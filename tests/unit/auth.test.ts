import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { deletedEmailHash, upsertUser, type SignInProfile } from '#/server/auth'
import { ApiError } from '#/server/util'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

const SECRET = 'unit-test-session-secret-0123456789abcdef'

describe('upsertUser：账号以 Google sub 为准', () => {
  let sqlite: DatabaseSync
  let env: Env

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    const kv = kvShim()
    // 注册赠送 5 积分，便于观察是否发放
    kv.store.set('settings:v1', JSON.stringify({ signupBonusCredits: 5 }))
    env = { DB: d1Shim(sqlite), KV: kv, SESSION_SECRET: SECRET, ADMIN_EMAILS: '' } as unknown as Env
  })

  const profile = (email: string, googleSub: string | null, extra: Partial<SignInProfile> = {}): SignInProfile => ({
    email,
    name: null,
    picture: null,
    googleSub,
    country: null,
    locale: null,
    ...extra,
  })
  const users = () => sqlite.prepare('SELECT id, email, google_sub, credits, status FROM arv_users ORDER BY created_at, id').all()
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => (error instanceof ApiError ? [error.status, error.code] : error),
    )

  it('同一邮箱换了 Google 账号（sub 不同）拒绝登录，不改原账号', async () => {
    const first = await upsertUser(env, profile('a@example.com', 'sub-1'))
    expect(await rejection(upsertUser(env, profile('A@example.com', 'sub-2')))).toEqual([409, 'account_conflict'])
    expect(users()).toEqual([expect.objectContaining({ id: first.id, google_sub: 'sub-1', credits: 5 })])
  })

  it('同一个 sub 换了邮箱仍登录原账号；dev 登录建的账号（sub 为空）在第一次 Google 登录时绑定', async () => {
    const google = await upsertUser(env, profile('old@example.com', 'sub-1'))
    expect((await upsertUser(env, profile('new@example.com', 'sub-1'))).id).toBe(google.id)

    const dev = await upsertUser(env, profile('dev@example.com', null))
    expect((await upsertUser(env, profile('dev@example.com', 'sub-9'))).id).toBe(dev.id)
    expect(await rejection(upsertUser(env, profile('dev@example.com', 'sub-10')))).toEqual([409, 'account_conflict'])
    // dev 登录不带 sub，不受绑定影响
    expect((await upsertUser(env, profile('dev@example.com', null))).id).toBe(dev.id)
  })

  it('邮箱属于 A、sub 属于 B 时按 sub 登录 B', async () => {
    const a = await upsertUser(env, profile('a@example.com', 'sub-a'))
    const b = await upsertUser(env, profile('b@example.com', 'sub-b'))
    expect((await upsertUser(env, profile('a@example.com', 'sub-b'))).id).toBe(b.id)
    expect(a.id).not.toBe(b.id)
  })

  it('封禁的账号拒绝登录', async () => {
    const user = await upsertUser(env, profile('a@example.com', 'sub-1'))
    sqlite.prepare(`UPDATE arv_users SET status = 'banned' WHERE id = ?`).run(user.id)
    expect(await rejection(upsertUser(env, profile('a@example.com', 'sub-1')))).toEqual([403, 'account_disabled'])
  })

  it('注销过的邮箱重新注册：不发注册赠送、不绑定邀请人；别的邮箱照常发', async () => {
    sqlite.prepare(`INSERT INTO arv_users (id, email, credits, referral_code, status, created_at) VALUES ('usr_inviter', 'inv@example.com', 0, 'INVITER2', 'active', ?)`).run(new Date().toISOString())
    sqlite.prepare('INSERT INTO arv_deleted_accounts (email_hash, deleted_at) VALUES (?, ?)').run(await deletedEmailHash(env, ' Gone@Example.com '), new Date().toISOString())

    const back = await upsertUser(env, profile('gone@example.com', 'sub-new', { referral: { code: 'INVITER2', ipHash: null } }))
    expect(back.credits).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_credit_ledger WHERE user_id = ?').get(back.id)).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_referrals WHERE invitee_id = ?').get(back.id)).toEqual({ n: 0 })

    const fresh = await upsertUser(env, profile('fresh@example.com', 'sub-fresh', { referral: { code: 'INVITER2', ipHash: null } }))
    expect(fresh.credits).toBe(5)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_referrals WHERE invitee_id = ?').get(fresh.id)).toEqual({ n: 1 })
  })

  it('邮箱哈希加了盐：换 SESSION_SECRET 后对不上', async () => {
    const other = { ...env, SESSION_SECRET: `${SECRET}-rotated` } as Env
    expect(await deletedEmailHash(env, 'a@example.com')).not.toBe(await deletedEmailHash(other, 'a@example.com'))
    expect(await deletedEmailHash(env, 'a@example.com')).toBe(await deletedEmailHash(env, ' A@EXAMPLE.com'))
  })
})
