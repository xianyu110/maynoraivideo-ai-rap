import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { RequestAttribution } from './attribution'
import { ledgerStatements } from './credits'
import { bindReferralStatement, type SignupReferral } from './referrals'
import { getSettings } from './settings'
import type { AppContext, UserRow } from './types'
import { ApiError, createId, isProduction, nowIso, randomToken, sha256Hex } from './util'

const SESSION_DAYS = 30

export function sessionCookieName(env: Env) {
  // __Host- 前缀要求 Secure + Path=/ + 无 Domain，只在 HTTPS 生产环境使用
  return isProduction(env) ? '__Host-sid' : 'sid'
}

export async function loadSessionUser(c: Context<AppContext>): Promise<UserRow | null> {
  const token = getCookie(c, sessionCookieName(c.env))
  if (!token) return null
  const id = await sha256Hex(token)
  const user = await c.env.DB.prepare(
    `SELECT u.* FROM arv_sessions s JOIN arv_users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(id, nowIso())
    .first<UserRow>()
  if (!user || user.status !== 'active') return null
  return user
}

export async function startSession(c: Context<AppContext>, userId: string) {
  const token = randomToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000)
  await c.env.DB.prepare(
    'INSERT INTO arv_sessions (id, user_id, expires_at, created_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      await sha256Hex(token),
      userId,
      expires.toISOString(),
      nowIso(),
      c.req.header('user-agent')?.slice(0, 300) ?? null,
      c.req.header('cf-connecting-ip') ?? null,
    )
    .run()
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: isProduction(c.env),
    sameSite: 'Lax',
    path: '/',
    expires,
  })
}

export async function endSession(c: Context<AppContext>) {
  const name = sessionCookieName(c.env)
  const token = getCookie(c, name)
  if (token) await c.env.DB.prepare('DELETE FROM arv_sessions WHERE id = ?').bind(await sha256Hex(token)).run()
  deleteCookie(c, name, { path: '/', secure: isProduction(c.env) })
}

export function adminEmails(env: Env) {
  return env.ADMIN_EMAILS.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(env: Env, email: string) {
  return adminEmails(env).includes(email.toLowerCase())
}

export interface SignInProfile {
  email: string
  name: string | null
  picture: string | null
  googleSub: string | null
  country: string | null
  locale: string | null
  attribution?: RequestAttribution | null // 仅新用户注册时写入
  referral?: SignupReferral | null // 仅新用户注册时绑定邀请人
}

// 注销账号只留邮箱的加盐哈希（deleted_accounts），用来识别“注销后用同一邮箱重新注册”。
// 盐是 SESSION_SECRET：换密钥后旧记录对不上，这些邮箱会再领一次注册赠送
export async function deletedEmailHash(env: Env, email: string) {
  return sha256Hex(`deleted-email:${env.SESSION_SECRET ?? ''}:${email.trim().toLowerCase()}`)
}

// Google 登录与 dev 登录共用：先按 google_sub、再按 email 找人，没有就创建并发放注册赠送积分（后台运营参数，默认取 site.ts）。
// 账号以 Google 的 sub 为准：邮箱相同但已绑定另一个 sub 时拒绝登录（Google 账号被删后同一邮箱可以注册成新账号），
// 只有 google_sub 为空的账号（dev 登录创建的）才按邮箱绑定
export async function upsertUser(env: Env, profile: SignInProfile): Promise<UserRow> {
  const email = profile.email.trim().toLowerCase()
  const db = env.DB
  const existing = await db
    .prepare(
      `SELECT * FROM arv_users WHERE (google_sub IS NOT NULL AND google_sub = ?1) OR email = ?2
       ORDER BY CASE WHEN google_sub = ?1 THEN 0 ELSE 1 END LIMIT 1`,
    )
    .bind(profile.googleSub, email)
    .first<UserRow>()
  const now = nowIso()
  const role = isAdminEmail(env, email) ? 'admin' : undefined

  if (existing) {
    if (existing.status !== 'active') throw new ApiError(403, 'account_disabled')
    if (profile.googleSub && existing.google_sub && existing.google_sub !== profile.googleSub) {
      console.warn('sign-in rejected: email bound to another google account', existing.id)
      throw new ApiError(409, 'account_conflict')
    }
    await db
      .prepare(
        `UPDATE arv_users SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url),
         google_sub = COALESCE(google_sub, ?), role = COALESCE(?, role), last_login_at = ? WHERE id = ?`,
      )
      .bind(profile.name, profile.picture, profile.googleSub, role ?? null, now, existing.id)
      .run()
    return (await db.prepare('SELECT * FROM arv_users WHERE id = ?').bind(existing.id).first<UserRow>())!
  }

  const id = createId('usr')
  const statements = [
    db
      .prepare(
        `INSERT INTO arv_users (id, email, name, avatar_url, google_sub, role, status, credits, locale, country,
         signup_source, signup_medium, signup_campaign, signup_device, attribution, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        email,
        profile.name,
        profile.picture,
        profile.googleSub,
        role ?? 'user',
        profile.locale,
        profile.country ?? profile.attribution?.country ?? null,
        profile.attribution?.source ?? null,
        profile.attribution?.medium ?? null,
        profile.attribution?.campaign ?? null,
        profile.attribution?.device ?? null,
        profile.attribution?.json ?? null,
        now,
        now,
      ),
  ]
  // 注销过的邮箱重新注册：不发注册赠送、不绑定邀请人
  const returning = await db
    .prepare('SELECT 1 AS hit FROM arv_deleted_accounts WHERE email_hash = ?')
    .bind(await deletedEmailHash(env, email))
    .first<{ hit: number }>()
  if (profile.referral && !returning) statements.push(bindReferralStatement(db, id, profile.referral, now))
  const { signupBonusCredits, signupBonusValidDays } = await getSettings(env)
  if (signupBonusCredits > 0 && !returning) {
    statements.push(
      ...ledgerStatements(db, {
        userId: id,
        delta: signupBonusCredits,
        reason: 'signup_bonus',
        idempotencyKey: `signup:${id}`,
        expiresAt: signupBonusValidDays > 0 ? new Date(Date.now() + signupBonusValidDays * 86400_000).toISOString() : null,
      }),
    )
  }
  await db.batch(statements)
  return (await db.prepare('SELECT * FROM arv_users WHERE id = ?').bind(id).first<UserRow>())!
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    role: user.role,
    credits: user.credits,
    createdAt: user.created_at,
  }
}
