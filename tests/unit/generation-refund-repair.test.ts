import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ledgerStatements, repairMissingGenerationRefunds } from '#/server/credits'
import { type Stmt, d1Shim, migrate } from './d1-sqlite'

let sqlite: DatabaseSync
let db: ReturnType<typeof d1Shim>
const asD1 = () => db as unknown as D1Database
const run = (statements: D1PreparedStatement[]) => db.batch(statements as unknown as Stmt[])
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

function addUser(id: string, credits = 0) {
  sqlite.prepare(`INSERT INTO arv_users (id, email, credits, created_at) VALUES (?, ?, ?, ?)`).run(id, `${id}@example.com`, credits, iso())
}

function insertGeneration(row: { id: string; userId: string; cost: number; status: string; refunded: number }) {
  sqlite
    .prepare(
      `INSERT INTO arv_generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider, refunded, created_at, updated_at)
       VALUES (?, ?, 't', 'short', 6, ?, 'upl', ?, 'mock', ?, ?, ?)`,
    )
    .run(row.id, row.userId, row.cost, row.status, row.refunded, iso(), iso())
}

function balance(userId: string) {
  return (sqlite.prepare('SELECT credits FROM arv_users WHERE id = ?').get(userId) as { credits: number }).credits
}

function refundedFlag(id: string) {
  return (sqlite.prepare('SELECT refunded FROM arv_generations WHERE id = ?').get(id) as { refunded: number }).refunded
}

function hasRefundLedger(id: string) {
  return Boolean(
    sqlite.prepare(`SELECT 1 AS ok FROM arv_credit_ledger WHERE idempotency_key = ?`).get(`generation_refund:${id}`),
  )
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  db = d1Shim(sqlite)
  migrate(sqlite)
})

describe('repairMissingGenerationRefunds', () => {
  it('failed + refunded=0 时补标记并退回积分', async () => {
    addUser('u1')
    await run(
      ledgerStatements(asD1(), {
        userId: 'u1',
        delta: 10,
        reason: 'purchase',
        idempotencyKey: 'credit:u1',
      }),
    )
    await run(
      ledgerStatements(asD1(), {
        userId: 'u1',
        delta: -6,
        reason: 'generation',
        idempotencyKey: 'generation:gen_gap',
        refId: 'gen_gap',
      }),
    )
    insertGeneration({ id: 'gen_gap', userId: 'u1', cost: 6, status: 'failed', refunded: 0 })
    expect(balance('u1')).toBe(4)

    const result = await repairMissingGenerationRefunds(asD1())
    expect(result.repaired).toBe(1)
    expect(refundedFlag('gen_gap')).toBe(1)
    expect(hasRefundLedger('gen_gap')).toBe(true)
    expect(balance('u1')).toBe(10)

    // 幂等：再跑一次不重复加积分
    const again = await repairMissingGenerationRefunds(asD1())
    expect(again.repaired).toBe(0)
    expect(balance('u1')).toBe(10)
  })

  it('refunded=1 但缺流水时只补退积分', async () => {
    addUser('u1')
    await run(
      ledgerStatements(asD1(), {
        userId: 'u1',
        delta: 8,
        reason: 'purchase',
        idempotencyKey: 'credit:u1b',
      }),
    )
    await run(
      ledgerStatements(asD1(), {
        userId: 'u1',
        delta: -6,
        reason: 'generation',
        idempotencyKey: 'generation:gen_led',
        refId: 'gen_led',
      }),
    )
    insertGeneration({ id: 'gen_led', userId: 'u1', cost: 6, status: 'failed', refunded: 1 })
    expect(balance('u1')).toBe(2)
    expect(hasRefundLedger('gen_led')).toBe(false)

    const result = await repairMissingGenerationRefunds(asD1())
    expect(result.repaired).toBe(1)
    expect(hasRefundLedger('gen_led')).toBe(true)
    expect(balance('u1')).toBe(8)
  })
})
