import type { Context } from 'hono'
import { outputExpiresAt } from './retention'
import type { AppContext, GenerationRow, OrderRow, UserRow } from './types'
import { ApiError, createId, nowIso } from './util'

export function requireUser(c: Context<AppContext>): UserRow {
  const user = c.get('user')
  if (!user) throw new ApiError(401, 'unauthorized')
  return user
}

export function requireAdmin(c: Context<AppContext>): UserRow {
  const user = requireUser(c)
  if (user.role !== 'admin') throw new ApiError(403, 'forbidden')
  return user
}

export async function rateLimit(limiter: RateLimit | undefined, key: string) {
  if (!limiter) return
  const { success } = await limiter.limit({ key })
  if (!success) throw new ApiError(429, 'rate_limited')
}

export async function readJson<T>(c: Context<AppContext>): Promise<Partial<T>> {
  try {
    const body = (await c.req.json()) as unknown
    return body && typeof body === 'object' ? (body as Partial<T>) : {}
  } catch {
    throw new ApiError(400, 'invalid_json')
  }
}

export function pageParams(c: Context<AppContext>, pageSize = 50) {
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1)
  return { limit: pageSize, offset: (page - 1) * pageSize, page }
}

export async function audit(
  env: Env,
  admin: UserRow,
  action: string,
  targetType: string,
  targetId: string,
  detail?: unknown,
) {
  await env.DB.prepare(
    `INSERT INTO arv_admin_audit (id, admin_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(createId('aud'), admin.id, action, targetType, targetId, detail === undefined ? null : JSON.stringify(detail), nowIso())
    .run()
}

export function publicGeneration(g: GenerationRow) {
  return {
    id: g.id,
    templateId: g.template_id,
    durationId: g.duration_id,
    durationSeconds: g.duration_seconds,
    creditsCost: g.credits_cost,
    status: g.status,
    errorCode: g.error_code,
    refunded: g.refunded === 1,
    createdAt: g.created_at,
    completedAt: g.completed_at,
    videoUrl: g.status === 'succeeded' && g.output_r2_key ? `/api/generations/${g.id}/video` : null,
    expired: Boolean(g.expired_at),
    removed: Boolean(g.removed_at),
    expiresAt: g.output_r2_key ? outputExpiresAt(g.completed_at) : null,
    shareId: g.share_id,
  }
}

export function publicOrder(o: OrderRow) {
  return {
    id: o.id,
    provider: o.provider,
    packageId: o.package_id,
    credits: o.credits,
    amountCents: o.amount_cents,
    currency: o.currency,
    // 实收（支付商回传，可能与标价币种不同）；pending 订单为 null
    paidAmountCents: o.paid_amount_cents,
    paidCurrency: o.paid_currency,
    status: o.status,
    refundedAmountCents: o.refunded_amount_cents ?? 0,
    refundedCredits: o.refunded_credits ?? 0,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    refundedAt: o.refunded_at,
    subscriptionId: o.subscription_id ?? null,
  }
}
