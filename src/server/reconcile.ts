// 主动对账：webhook 丢失或延迟时，向支付商查单补救。查到的付款走与 webhook 相同的 processPaymentEvent
// （同样的入账前核对和幂等键），所以和迟到的 webhook 撞在一起也只会入账一次。
// 触发点：成功页轮询久等未到账时（POST /api/orders/:id/reconcile）、Cron 扫 pending 订单、后台订单详情手动查单
import { processPaymentEvent } from './orders'
import { getOrderProvider } from './payments'
import type { OrderRow } from './types'

export type ReconcileStatus =
  | 'processed' // 查到付款并入账
  | 'duplicate' // 查到付款，但已经入过账
  | 'orphan'
  | 'mismatch' // 查到付款，但金额/商品不符，没有入账（等人工核对）
  | 'ignored'
  | 'unpaid' // 支付商那边还没有成功的付款
  | 'throttled' // 距上次查单太近，或其他请求正在查
  | 'review' // 已有金额/商品不符的付款事件，等人工处理，不再自动查
  | 'skipped' // 订单已是终态，或支付商不支持查单

export async function reconcileOrder(
  env: Env,
  order: OrderRow,
  options: { minIntervalMs?: number; now?: number } = {},
): Promise<ReconcileStatus> {
  if (order.status === 'paid' || order.status === 'refunded') return 'skipped'
  const provider = getOrderProvider(env, order.provider)
  if (!provider?.fetchPaidEvent) return 'skipped'
  const db = env.DB
  const review = await db
    .prepare(`SELECT 1 FROM arv_payment_events WHERE order_id = ? AND status = 'mismatch' LIMIT 1`)
    .bind(order.id)
    .first()
  if (review) return 'review'

  // 先占住查单时间：既是节流，也让同时到达的成功页请求和 Cron 只有一个真正去查支付商
  const now = options.now ?? Date.now()
  const claimed = await db
    .prepare(
      `UPDATE arv_orders SET last_reconciled_at = ? WHERE id = ? AND status NOT IN ('paid', 'refunded')
       AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)`,
    )
    .bind(new Date(now).toISOString(), order.id, new Date(now - (options.minIntervalMs ?? 0)).toISOString())
    .run()
  if (!claimed.meta.changes) return 'throttled'

  const lookup = await provider.fetchPaidEvent({ id: order.id, packageId: order.package_id, providerSessionId: order.provider_session_id })
  if (!lookup) return 'unpaid'
  const result = await processPaymentEvent(env, provider.id, lookup.event, JSON.stringify(lookup.raw))
  return result.status
}

const SWEEP_MIN_AGE_MINUTES = 10
const SWEEP_MAX_AGE_HOURS = 24 // 超过 24 小时的 pending 订单由定时任务取消（迟到的 webhook 仍会入账）
const SWEEP_BATCH = 10 // 每轮最多查 10 单：Dodo 每单 2 个子请求，控制在 Workers 子请求额度内

// Cron：创建 10 分钟到 24 小时之间、仍是 pending 的订单逐个查单。指数退避：订单年龄比上次查单时翻倍才再查，
// 一单最多查约 8 次（10、20、40 分钟……约 21 小时）。userId 只给本地 e2e 用，把扫描范围限定到测试用户
export async function reconcilePendingOrders(env: Env, options: { now?: number; userId?: string } = {}) {
  const now = options.now ?? Date.now()
  const nowIsoString = new Date(now).toISOString()
  const rows = await env.DB.prepare(
    `SELECT * FROM arv_orders o
     WHERE o.status = 'pending' AND o.created_at <= ?1 AND o.created_at > ?2 AND (?4 IS NULL OR o.user_id = ?4)
       AND o.provider_session_id IS NOT NULL
       AND (o.last_reconciled_at IS NULL
         OR julianday(?3) - julianday(o.created_at) >= 2 * (julianday(o.last_reconciled_at) - julianday(o.created_at)))
       AND NOT EXISTS (SELECT 1 FROM arv_payment_events e WHERE e.order_id = o.id AND e.status = 'mismatch')
     ORDER BY o.created_at LIMIT ${SWEEP_BATCH}`,
  )
    .bind(
      new Date(now - SWEEP_MIN_AGE_MINUTES * 60_000).toISOString(),
      new Date(now - SWEEP_MAX_AGE_HOURS * 3600_000).toISOString(),
      nowIsoString,
      options.userId ?? null,
    )
    .all<OrderRow>()

  const counts: Partial<Record<ReconcileStatus | 'error', number>> = {}
  for (const order of rows.results) {
    let status: ReconcileStatus | 'error'
    try {
      status = await reconcileOrder(env, order, { now })
    } catch (error) {
      // 单个订单查单失败（支付商超时等）不影响其他订单，下一轮按退避继续
      console.error('order reconcile failed', order.id, error)
      status = 'error'
    }
    counts[status] = (counts[status] ?? 0) + 1
  }
  return { checked: rows.results.length, ...counts }
}
