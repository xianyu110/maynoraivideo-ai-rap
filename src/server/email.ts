import { site } from '#/config/site'
import { isEmailTemplate, renderEmail, type EmailTemplate, type TemplateParams } from './email-templates'
import { createId, nowIso } from './util'

// 交易邮件发件箱（Cloudflare Email Service，send_email binding）。
// 业务流程里先按 dedupe_key 写入 email_outbox（同一事件只会有一行），再立即尝试发送；
// 临时失败留在 pending 按退避重试，Cron 每 5 分钟补发。通知失败从不影响主流程。
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/

export const EMAIL_MAX_ATTEMPTS = 5
// 发送租约：领取后到期前别的 Worker 不会再发；中途退出则到期后由 Cron 重试（至少一次）
const LEASE_MS = 5 * 60_000
const RETRY_BASE_MS = 5 * 60_000
const OUTBOX_RETENTION_DAYS = 30
const RETRY_BATCH = 50

// 临时性错误，稍后重试可能成功；其它 E_ 错误码（发件域未验证、收件人被抑制、参数错误等）重试也没用
const RETRYABLE_CODES = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR'])

export type OutgoingEmail = {
  [K in EmailTemplate]: { key: string; template: K; to: string; params: TemplateParams[K]; userId?: string | null; locale?: string | null }
}[EmailTemplate]

export interface EmailOutboxRow {
  id: string
  dedupe_key: string
  template: string
  to_email: string
  user_id: string | null
  locale: string
  params: string
  subject: string | null
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  attempts: number
  next_attempt_at: string
  provider_message_id: string | null
  last_error: string | null
  created_at: string
  sent_at: string | null
}

export interface Mailer {
  send(message: {
    from: { email: string; name: string }
    to: string
    subject: string
    text: string
    html: string
    replyTo: string
  }): Promise<{ messageId: string }>
}

export interface EmailConfig {
  mailer: Mailer
  from: { email: string; name: string }
  siteUrl: string
}

// 没配 EMAIL_FROM 或没有 binding：不发信，记录为 skipped（后台可见）
export function emailConfig(env: Env): EmailConfig | null {
  const from = env.EMAIL_FROM?.trim()
  if (!from || !env.EMAIL) return null
  return { mailer: env.EMAIL, from: { email: from, name: site.brandName }, siteUrl: env.SITE_URL }
}

export type DeliveryResult =
  | { status: 'sent'; subject: string; messageId: string }
  | { status: 'pending' | 'failed'; subject: string | null; error: string; retryAt: string | null }

// 一次发送尝试（row.attempts 已含本次）。不抛错，返回要写回的状态
export async function attemptDelivery(
  row: Pick<EmailOutboxRow, 'template' | 'to_email' | 'locale' | 'params' | 'attempts'>,
  config: EmailConfig,
  now = Date.now(),
): Promise<DeliveryResult> {
  if (!isEmailTemplate(row.template)) return { status: 'failed', subject: null, error: 'unknown_template', retryAt: null }
  let rendered
  try {
    rendered = renderEmail(row.template, JSON.parse(row.params), { siteUrl: config.siteUrl, locale: row.locale })
  } catch (error) {
    return { status: 'failed', subject: null, error: `render_failed: ${errorText(error)}`, retryAt: null }
  }
  try {
    const result = await config.mailer.send({
      from: config.from,
      to: row.to_email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: rendered.replyTo,
    })
    return { status: 'sent', subject: rendered.subject, messageId: result.messageId }
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null
    const retryable = !code || RETRYABLE_CODES.has(code)
    const message = `${code ?? 'send_failed'}: ${errorText(error)}`.slice(0, 500)
    if (!retryable || row.attempts >= EMAIL_MAX_ATTEMPTS) return { status: 'failed', subject: rendered.subject, error: message, retryAt: null }
    // 5、15、45、135 分钟后重试
    const retryAt = new Date(now + RETRY_BASE_MS * 3 ** (row.attempts - 1)).toISOString()
    return { status: 'pending', subject: rendered.subject, error: message, retryAt }
  }
}

// 写入发件箱并立即尝试发送。返回 false 表示写入失败（已记录日志），调用方据此决定是否稍后再试
export async function sendEmails(env: Env, emails: OutgoingEmail[]) {
  if (!emails.length) return true
  let ids: string[]
  try {
    ids = await enqueueEmails(env, emails)
  } catch (error) {
    console.error('email enqueue failed', emails.map((e) => e.key), error)
    return false
  }
  for (const id of ids) {
    try {
      await deliverEmail(env, id)
    } catch (error) {
      // 状态没写回：租约到期后 Cron 会重试
      console.error('email delivery failed', id, error)
    }
  }
  return true
}

async function enqueueEmails(env: Env, emails: OutgoingEmail[]) {
  const configured = Boolean(emailConfig(env))
  const now = nowIso()
  const rows = emails.map((email) => ({ ...email, id: createId('eml') }))
  const db = env.DB
  const results = await db.batch(
    rows.map((email) =>
      db
        .prepare(
          `INSERT INTO arv_email_outbox (id, dedupe_key, template, to_email, user_id, locale, params, status, last_error, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(
          email.id,
          email.key,
          email.template,
          email.to,
          email.userId ?? null,
          email.locale ?? 'en',
          JSON.stringify(email.params),
          configured ? 'pending' : 'skipped',
          configured ? null : 'email_not_configured',
          now,
          now,
        ),
    ),
  )
  return configured ? rows.filter((_, i) => results[i]?.meta.changes).map((row) => row.id) : []
}

export async function deliverEmail(env: Env, id: string) {
  const config = emailConfig(env)
  if (!config) return null
  const now = Date.now()
  const row = await env.DB.prepare(
    `UPDATE arv_email_outbox SET attempts = attempts + 1, next_attempt_at = ?
     WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? RETURNING *`,
  )
    .bind(new Date(now + LEASE_MS).toISOString(), id, new Date(now).toISOString())
    .first<EmailOutboxRow>()
  if (!row) return null
  const result = await attemptDelivery(row, config, now)
  if (result.status === 'sent') {
    await env.DB.prepare(
      `UPDATE arv_email_outbox SET status = 'sent', subject = ?, provider_message_id = ?, last_error = NULL, sent_at = ? WHERE id = ?`,
    )
      .bind(result.subject, result.messageId, nowIso(), id)
      .run()
  } else {
    if (result.status === 'failed') console.error('email failed', row.template, id, result.error)
    await env.DB.prepare(
      `UPDATE arv_email_outbox SET status = ?, subject = COALESCE(?, subject), last_error = ?, next_attempt_at = COALESCE(?, next_attempt_at)
       WHERE id = ?`,
    )
      .bind(result.status, result.subject, result.error, result.retryAt, id)
      .run()
  }
  return result.status
}

// Cron：补发到期的 pending，删除超过保留期的记录（含收件地址，属于个人数据）
export async function runEmailMaintenance(env: Env) {
  const due = await env.DB.prepare(
    `SELECT id FROM arv_email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ${RETRY_BATCH}`,
  )
    .bind(nowIso())
    .all<{ id: string }>()
  for (const { id } of due.results) {
    try {
      await deliverEmail(env, id)
    } catch (error) {
      console.error('email retry failed', id, error)
    }
  }
  await env.DB.prepare('DELETE FROM arv_email_outbox WHERE created_at < ?')
    .bind(new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86400_000).toISOString())
    .run()
  return { retried: due.results.length }
}

// 后台手动重试 failed / skipped（例如配置好发件域名之后）
export async function retryEmail(env: Env, id: string) {
  const reset = await env.DB.prepare(
    `UPDATE arv_email_outbox SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?
     WHERE id = ? AND status IN ('failed', 'skipped')`,
  )
    .bind(nowIso(), id)
    .run()
  if (!reset.meta.changes) return null
  return (await deliverEmail(env, id)) ?? 'pending'
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
