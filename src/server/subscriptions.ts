// 订阅：状态、周期与积分发放。扣款事件（首付、续费）和状态事件的处理在 orders.ts，这里放不依赖事件的部分：
// - 周期推算：支付商没给周期时按付款时间加计费周期（按日历月加，1 月 31 日 + 1 个月 = 2 月底）
// - 积分发放：每月发 credits_per_month，当期结束作废；年付每个月由 Cron 补发一次（grantDueSubscriptions）
// - 查询与展示：账单页卡片、后台、注销和重复订阅的判断
import { findPlan, type SubscriptionPlan } from '#/config/site'
import { ledgerStatements } from './credits'
import { getOrderProvider } from './payments'
import type { SubscriptionRef } from './payments/types'
import type { SubscriptionRow, UserRow } from './types'
import { ApiError, isUniqueConstraintError, nowIso } from './util'

const DAY_MS = 86400_000

export function addMonths(iso: string, months: number) {
  const d = new Date(iso)
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
  )
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay))
  return target.toISOString()
}

export function addInterval(iso: string, interval: SubscriptionPlan['interval']) {
  return addMonths(iso, interval === 'year' ? 12 : 1)
}

// 第 k 个月（从 0 起）的积分：从当期开始日加 k 个月起算，到下个月同日或当期结束时作废。
// 月付只有 k = 0，直接用当期结束时间，不受支付商周期和日历月的几小时差影响
export function grantWindow(sub: Pick<SubscriptionRow, 'interval' | 'current_period_start' | 'current_period_end'>, k: number) {
  const start = addMonths(sub.current_period_start!, k)
  const periodEnd = sub.current_period_end!
  if (sub.interval === 'month') return { start, expiresAt: periodEnd }
  const monthEnd = addMonths(sub.current_period_start!, k + 1)
  return { start, expiresAt: monthEnd < periodEnd ? monthEnd : periodEnd }
}

// 年付的下一次补发时间；离当期结束不到一天时不再补发（支付商的周期可能比 12 个日历月长几个小时）
export function nextGrantAt(sub: Pick<SubscriptionRow, 'interval' | 'current_period_start' | 'current_period_end'>, grantsDone: number) {
  if (sub.interval !== 'year') return null
  const next = addMonths(sub.current_period_start!, grantsDone)
  return Date.parse(next) < Date.parse(sub.current_period_end!) - DAY_MS ? next : null
}

// 仍在生效：active 或 past_due，且不是“已到期取消、当期也结束了”（状态 webhook 丢失时不至于永远卡住新订阅）
export const LIVE_SUBSCRIPTION_SQL = `status IN ('active', 'past_due') AND NOT (cancel_at_period_end = 1 AND current_period_end < ?)`

export function liveSubscription(db: D1Database, userId: string, now = nowIso()) {
  return db
    .prepare(`SELECT * FROM arv_subscriptions WHERE user_id = ? AND ${LIVE_SUBSCRIPTION_SQL} ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, now)
    .first<SubscriptionRow>()
}

export function latestSubscription(db: D1Database, userId: string) {
  return db
    .prepare('SELECT * FROM arv_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .bind(userId)
    .first<SubscriptionRow>()
}

// 账单页展示的状态：已到期取消且当期结束、但还没收到终止 webhook 的，按 canceled 显示
export function effectiveStatus(sub: Pick<SubscriptionRow, 'status' | 'cancel_at_period_end' | 'current_period_end'>, now = nowIso()) {
  if (sub.status !== 'canceled' && sub.status !== 'expired' && sub.cancel_at_period_end && sub.current_period_end && sub.current_period_end < now) {
    return 'canceled' as const
  }
  return sub.status
}

export function publicSubscription(sub: SubscriptionRow, now = nowIso()) {
  return {
    id: sub.id,
    provider: sub.provider,
    planId: sub.plan_id,
    interval: sub.interval,
    creditsPerMonth: sub.credits_per_month,
    amountCents: sub.amount_cents,
    currency: sub.currency,
    status: effectiveStatus(sub, now),
    cancelAtPeriodEnd: sub.cancel_at_period_end === 1,
    currentPeriodStart: sub.current_period_start,
    currentPeriodEnd: sub.current_period_end,
    nextGrantAt: sub.next_grant_at,
    createdAt: sub.created_at,
    endedAt: sub.ended_at,
  }
}

export function subscriptionRef(sub: SubscriptionRow, user: Pick<UserRow, 'id' | 'email'>): SubscriptionRef {
  return { providerSubscriptionId: sub.provider_subscription_id, providerCustomerId: sub.provider_customer_id, user: { id: user.id, email: user.email } }
}

// 用户在账单页取消或恢复：先调支付商，成功后本地立即更新（state_at = 现在，更早发出的状态 webhook 迟到也不会覆盖）
export async function setCancelAtPeriodEnd(env: Env, user: UserRow, cancel: boolean) {
  const sub = await liveSubscription(env.DB, user.id)
  if (!sub) throw new ApiError(404, 'subscription_not_found')
  if ((sub.cancel_at_period_end === 1) === cancel) return sub
  const provider = getOrderProvider(env, sub.provider)
  const action = cancel ? provider?.cancelSubscription : provider?.resumeSubscription
  // Waffo 的恢复只能由买家在客户门户里操作
  if (!provider || !action) throw new ApiError(409, cancel ? 'subscription_cancel_unsupported' : 'subscription_resume_in_portal')
  await action.call(provider, subscriptionRef(sub, user))
  const now = nowIso()
  await env.DB.prepare('UPDATE arv_subscriptions SET cancel_at_period_end = ?, state_at = ?, updated_at = ? WHERE id = ?')
    .bind(cancel ? 1 : 0, now, now, sub.id)
    .run()
  return { ...sub, cancel_at_period_end: cancel ? 1 : 0, state_at: now, updated_at: now }
}

export function planForSubscription(sub: Pick<SubscriptionRow, 'plan_id'>) {
  return findPlan(sub.plan_id) ?? null
}

type DueRow = SubscriptionRow & { order_status: string | null }

// Cron：年付按月补发。只给 active、当期订单仍是 paid 的订阅发；退款、终止或当期发完时清掉 next_grant_at。
// 幂等键 subscription_grant:<订单>:<k>，同一个月并发补发只会成功一次；Cron 停过几天时一次补齐，已过期的月份跳过。
// userId 只给本地 e2e 用
export async function grantDueSubscriptions(env: Env, options: { now?: number; userId?: string } = {}) {
  const db = env.DB
  const nowMs = options.now ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const rows = await db
    .prepare(
      `SELECT s.*, o.status AS order_status FROM arv_subscriptions s LEFT JOIN arv_orders o ON o.id = s.current_order_id
       WHERE s.next_grant_at IS NOT NULL AND s.next_grant_at <= ? AND (? IS NULL OR s.user_id = ?)
       ORDER BY s.next_grant_at LIMIT 50`,
    )
    .bind(now, options.userId ?? null, options.userId ?? null)
    .all<DueRow>()
  let granted = 0
  for (const sub of rows.results) {
    if (sub.status !== 'active' || sub.order_status !== 'paid' || !sub.current_order_id || !sub.current_period_start || !sub.current_period_end) {
      await db.prepare('UPDATE arv_subscriptions SET next_grant_at = NULL, updated_at = ? WHERE id = ? AND grants_done = ?')
        .bind(now, sub.id, sub.grants_done)
        .run()
      continue
    }
    let k = sub.grants_done
    let next = sub.next_grant_at
    while (next && next <= now) {
      const window = grantWindow(sub, k)
      const statements: D1PreparedStatement[] = []
      if (window.expiresAt > now) {
        statements.push(
          ...ledgerStatements(db, {
            userId: sub.user_id,
            delta: sub.credits_per_month,
            reason: 'subscription',
            refId: sub.current_order_id,
            idempotencyKey: `subscription_grant:${sub.current_order_id}:${k}`,
            note: `${sub.plan_id} month ${k + 1}`,
            expiresAt: window.expiresAt,
          }),
          // 订单的 credits 记“已发放的积分”，退款按它回收
          db.prepare(`UPDATE arv_orders SET credits = credits + ?, updated_at = ? WHERE id = ? AND status = 'paid'`)
            .bind(sub.credits_per_month, now, sub.current_order_id),
        )
      }
      next = nextGrantAt(sub, k + 1)
      statements.push(
        db.prepare('UPDATE arv_subscriptions SET grants_done = ?, next_grant_at = ?, updated_at = ? WHERE id = ? AND grants_done = ?')
          .bind(k + 1, next, now, sub.id, k),
      )
      try {
        await db.batch(statements)
        if (window.expiresAt > now) granted += 1
      } catch (error) {
        // 并发的另一轮已经发过这个月
        if (!isUniqueConstraintError(error)) throw error
        break
      }
      k += 1
    }
  }
  return { checked: rows.results.length, granted }
}
