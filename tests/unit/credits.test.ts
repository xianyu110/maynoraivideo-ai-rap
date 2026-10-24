import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { clawbackStatements, expireStatements, generationRefundStatements, ledgerStatements } from '#/server/credits'
import { isCheckConstraintError, isUniqueConstraintError } from '#/server/util'
import { type Stmt, d1Shim, migrate as runMigrations } from './d1-sqlite'

// 积分批次的 SQL 在本地 SQLite 上真跑：依次执行全部迁移，用一个最小的 D1 外壳（batch = 事务）调用 credits.ts。
// 这里验证的是账务规则；D1 线上的事务与约束行为由 e2e（本地 Worker 运行时）覆盖。
const DAY = 86400_000

let sqlite: DatabaseSync
let db: ReturnType<typeof d1Shim>
const asD1 = () => db as unknown as D1Database
const run = (statements: D1PreparedStatement[]) => db.batch(statements as unknown as Stmt[])
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

const migrate = (from?: number, to?: number) => runMigrations(sqlite, from, to)

function addUser(id: string) {
  sqlite.prepare(`INSERT INTO arv_users (id, email, credits, created_at) VALUES (?, ?, 0, ?)`).run(id, `${id}@example.com`, iso(0))
}

// 同一到期时间按入账时间先后扣；错开 2ms，避免同一毫秒入账时按随机 id 排序
const credit = async (userId: string, delta: number, extra: { reason?: 'purchase' | 'admin_adjust' | 'signup_bonus'; refId?: string; expiresAt?: string } = {}) => {
  await new Promise((resolve) => setTimeout(resolve, 2))
  return run(
    ledgerStatements(asD1(), {
      userId,
      delta,
      reason: extra.reason ?? 'purchase',
      refId: extra.refId ?? null,
      idempotencyKey: `credit:${crypto.randomUUID()}`,
      expiresAt: extra.expiresAt ?? null,
    }),
  )
}

const spend = (userId: string, amount: number, key = `generation:${crypto.randomUUID()}`) =>
  run(ledgerStatements(asD1(), { userId, delta: -amount, reason: 'generation', idempotencyKey: key }))

function balance(userId: string) {
  return (sqlite.prepare('SELECT credits FROM arv_users WHERE id = ?').get(userId) as { credits: number }).credits
}

function grants(userId: string) {
  return sqlite
    .prepare('SELECT source, ref_id AS refId, amount, remaining, expires_at AS expiresAt FROM arv_credit_grants WHERE user_id = ? ORDER BY created_at, id')
    .all(userId) as Array<{ source: string; refId: string | null; amount: number; remaining: number; expiresAt: string | null }>
}

function ledger(userId: string) {
  return sqlite.prepare('SELECT reason, delta FROM arv_credit_ledger WHERE user_id = ? ORDER BY rowid').all(userId) as Array<{ reason: string; delta: number }>
}

// 不变式：流水之和 = 缓存余额 = 批次剩余之和
function expectConsistent(userId: string) {
  const sums = sqlite
    .prepare(
      `SELECT (SELECT COALESCE(SUM(delta), 0) FROM arv_credit_ledger WHERE user_id = ?1) AS ledger,
              (SELECT credits FROM arv_users WHERE id = ?1) AS cached,
              (SELECT COALESCE(SUM(remaining), 0) FROM arv_credit_grants WHERE user_id = ?1) AS grants`,
    )
    .get(userId) as { ledger: number; cached: number; grants: number }
  expect(sums.cached).toBe(sums.ledger)
  expect(sums.grants).toBe(sums.ledger)
}

function addFailedGeneration(userId: string, id: string, cost: number) {
  sqlite
    .prepare(
      `INSERT INTO arv_generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, refunded, created_at, updated_at)
       VALUES (?, ?, 't', 'short', 6, ?, 'upl', 'failed', 'mock', 1, ?, ?)`,
    )
    .run(id, userId, cost, iso(0), iso(0))
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  db = d1Shim(sqlite)
})

describe('积分批次', () => {
  beforeEach(() => {
    migrate()
    addUser('u1')
  })

  it('先扣快到期的批次，永不过期的最后扣', async () => {
    await credit('u1', 20)
    await credit('u1', 3, { reason: 'signup_bonus', expiresAt: iso(10 * DAY) })
    await credit('u1', 5, { reason: 'admin_adjust', expiresAt: iso(DAY) })
    await spend('u1', 6)
    expect(grants('u1').map((g) => [g.source, g.remaining])).toEqual([
      ['purchase', 20],
      ['signup_bonus', 2],
      ['admin_adjust', 0],
    ])
    expect(balance('u1')).toBe(22)
    expectConsistent('u1')
  })

  it('余额不足：整个 batch 回滚，不留流水和明细', async () => {
    await credit('u1', 5)
    const error = await spend('u1', 6).catch((e: unknown) => e)
    expect(isCheckConstraintError(error)).toBe(true)
    expect(balance('u1')).toBe(5)
    expect(ledger('u1')).toEqual([{ reason: 'purchase', delta: 5 }])
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_credit_allocations').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_credit_guard').get()).toEqual({ n: 0 })
  })

  it('已到期的批次不能用；扣费前先作废并记 expire 流水', async () => {
    await credit('u1', 5, { reason: 'admin_adjust', expiresAt: iso(-DAY) })
    await credit('u1', 3)
    // 到期的 5 积分还算在缓存余额里（等 Cron 作废），但扣 6 必须失败
    expect(balance('u1')).toBe(8)
    expect(isCheckConstraintError(await spend('u1', 6).catch((e: unknown) => e))).toBe(true)
    await spend('u1', 3)
    expect(balance('u1')).toBe(0)
    expect(ledger('u1').map((e) => [e.reason, e.delta])).toEqual([
      ['admin_adjust', 5],
      ['purchase', 3],
      ['expire', -5],
      ['generation', -3],
    ])
    expectConsistent('u1')
  })

  it('Cron 作废所有用户的到期批次，重复执行不重复作废', async () => {
    addUser('u2')
    await credit('u1', 5, { reason: 'admin_adjust', expiresAt: iso(DAY) })
    await credit('u1', 4)
    await credit('u2', 2, { reason: 'signup_bonus', expiresAt: iso(2 * DAY) })
    await spend('u1', 1)
    await run(expireStatements(asD1(), iso(3 * DAY)))
    await run(expireStatements(asD1(), iso(3 * DAY)))
    expect(balance('u1')).toBe(4)
    expect(balance('u2')).toBe(0)
    expect(ledger('u1').filter((e) => e.reason === 'expire')).toEqual([{ reason: 'expire', delta: -4 }])
    expect(ledger('u2').filter((e) => e.reason === 'expire')).toEqual([{ reason: 'expire', delta: -2 }])
    expectConsistent('u1')
    expectConsistent('u2')
  })

  it('生成失败按明细原路退回各批次，重复退款整体回滚', async () => {
    await credit('u1', 4, { reason: 'admin_adjust', expiresAt: iso(DAY) })
    await credit('u1', 10)
    addFailedGeneration('u1', 'gen_a', 6)
    await spend('u1', 6, 'generation:gen_a')
    expect(grants('u1').map((g) => g.remaining)).toEqual([0, 8])
    await run(generationRefundStatements(asD1(), 'gen_a', 'provider_failed'))
    expect(grants('u1').map((g) => g.remaining)).toEqual([4, 10])
    expect(balance('u1')).toBe(14)
    expect(isUniqueConstraintError(await run(generationRefundStatements(asD1(), 'gen_a', 'again')).catch((e: unknown) => e))).toBe(true)
    expect(balance('u1')).toBe(14)
    expectConsistent('u1')
  })

  it('没有扣费明细的旧任务退成一个永不过期的新批次；未失败的任务不退', async () => {
    addFailedGeneration('u1', 'gen_old', 6)
    sqlite.prepare(`INSERT INTO arv_credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, created_at) VALUES ('led_x', 'u1', 6, 'purchase', NULL, 'k', ?)`).run(iso(0))
    sqlite.prepare(`INSERT INTO arv_credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, created_at) VALUES ('led_y', 'u1', -6, 'generation', 'gen_old', 'generation:gen_old', ?)`).run(iso(0))
    await run(generationRefundStatements(asD1(), 'gen_old', 'provider_failed'))
    expect(grants('u1')).toEqual([{ source: 'generation_refund', refId: 'gen_old', amount: 6, remaining: 6, expiresAt: null }])
    expect(balance('u1')).toBe(6)
    expectConsistent('u1')

    addFailedGeneration('u1', 'gen_ok', 6)
    sqlite.prepare(`UPDATE arv_generations SET status = 'succeeded', refunded = 0 WHERE id = 'gen_ok'`).run()
    await run(generationRefundStatements(asD1(), 'gen_ok', 'noop'))
    expect(balance('u1')).toBe(6)
    expect(ledger('u1')).toHaveLength(3)
  })

  it('订单退款先扣该订单买的批次，最多扣到 0', async () => {
    await credit('u1', 20, { refId: 'ord_a' })
    await credit('u1', 5, { reason: 'admin_adjust', expiresAt: iso(DAY) })
    await credit('u1', 20, { refId: 'ord_b' })
    await spend('u1', 6)
    // 先扣到期的 5，再按入账顺序扣 ord_a 的 1
    expect(grants('u1').map((g) => g.remaining)).toEqual([19, 0, 20])
    await run(clawbackStatements(asD1(), { userId: 'u1', reason: 'order_refund', refId: 'ord_b', idempotencyKey: 'order_refund:ord_b', maxAmount: 20, preferRefId: 'ord_b' }))
    expect(grants('u1').map((g) => g.remaining)).toEqual([19, 0, 0])
    await run(clawbackStatements(asD1(), { userId: 'u1', reason: 'account_deleted', idempotencyKey: 'account_deleted:u1', maxAmount: 1_000_000_000 }))
    expect(balance('u1')).toBe(0)
    expect(ledger('u1').slice(-2)).toEqual([
      { reason: 'order_refund', delta: -20 },
      { reason: 'account_deleted', delta: -19 },
    ])
    expectConsistent('u1')
  })

  it('同一笔扣费重复提交：幂等键冲突，整体回滚', async () => {
    await credit('u1', 20)
    await spend('u1', 6, 'generation:gen_dup')
    expect(isUniqueConstraintError(await spend('u1', 6, 'generation:gen_dup').catch((e: unknown) => e))).toBe(true)
    expect(balance('u1')).toBe(14)
    expectConsistent('u1')
  })
})

describe('迁移 0009', () => {
  it('现有余额转成永不过期的 legacy 批次，之后照常扣费', async () => {
    migrate(1, 8)
    addUser('u1')
    addUser('u0')
    sqlite.prepare(`UPDATE arv_users SET credits = 7 WHERE id = 'u1'`).run()
    sqlite.prepare(`INSERT INTO arv_credit_ledger (id, user_id, delta, reason, ref_id, idempotency_key, created_at) VALUES ('led_l', 'u1', 7, 'purchase', NULL, 'order:x', ?)`).run(iso(0))
    migrate(9)
    expect(grants('u1')).toEqual([{ source: 'legacy', refId: null, amount: 7, remaining: 7, expiresAt: null }])
    expect(grants('u0')).toEqual([])
    await spend('u1', 6)
    expect(balance('u1')).toBe(1)
    expectConsistent('u1')
  })
})
