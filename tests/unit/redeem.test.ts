import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatCode, generateCode, normalizeCode, redeemCode } from '#/server/redeem'
import { ApiError } from '#/server/util'
import { d1Shim, migrate } from './d1-sqlite'

const DAY = 86400_000

describe('兑换码格式', () => {
  it('随机码 12 位、不含易混字符，展示为 4-4-4，规范化后还原', () => {
    const codes = Array.from({ length: 200 }, generateCode)
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/)
      expect(formatCode(code)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code)
    }
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('用户输入忽略大小写、空格和连字符；格式不对返回 null', () => {
    expect(normalizeCode(' abcd-efgh 2345 ')).toBe('ABCDEFGH2345')
    expect(normalizeCode('launch2026')).toBe('LAUNCH2026')
    expect(normalizeCode('ab1')).toBeNull()
    expect(normalizeCode('A'.repeat(33))).toBeNull()
    expect(normalizeCode('ABCD_1234')).toBeNull()
    expect(normalizeCode("ABCD' OR 1=1")).toBeNull()
    expect(normalizeCode(12345678)).toBeNull()
  })

  it('活动码原样展示', () => {
    expect(formatCode('LAUNCH2026')).toBe('LAUNCH2026')
    // 12 位但含字母表以外的字符（I、O、0、1），不是随机码
    expect(formatCode('LAUNCHPROMO1')).toBe('LAUNCHPROMO1')
  })
})

describe('兑换', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    db = d1Shim(sqlite) as unknown as D1Database
    for (const id of ['u1', 'u2', 'u3']) {
      sqlite.prepare('INSERT INTO arv_users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run(id, `${id}@example.com`, iso(0))
    }
  })

  function addCode(code: string, extra: { credits?: number; maxUses?: number; validDays?: number | null; expiresAt?: string | null; disabled?: boolean } = {}) {
    sqlite
      .prepare(
        `INSERT INTO arv_redeem_codes (code, batch_id, credits, max_uses, credit_valid_days, expires_at, note, disabled_at, created_by, created_at)
         VALUES (?, 'rdb_1', ?, ?, ?, ?, 'test', ?, 'admin', ?)`,
      )
      .run(code, extra.credits ?? 10, extra.maxUses ?? 1, extra.validDays ?? null, extra.expiresAt ?? null, extra.disabled ? iso(0) : null, iso(0))
  }

  const usedCount = (code: string) => (sqlite.prepare('SELECT used_count AS n FROM arv_redeem_codes WHERE code = ?').get(code) as { n: number }).n
  const balance = (userId: string) => (sqlite.prepare('SELECT credits FROM arv_users WHERE id = ?').get(userId) as { credits: number }).credits
  const grants = (userId: string) =>
    sqlite.prepare('SELECT source, ref_id AS refId, amount, remaining, expires_at AS expiresAt FROM arv_credit_grants WHERE user_id = ?').all(userId) as Array<{
      source: string
      refId: string
      amount: number
      remaining: number
      expiresAt: string | null
    }>
  const ledger = (userId: string) => sqlite.prepare('SELECT reason, delta, ref_id AS refId FROM arv_credit_ledger WHERE user_id = ?').all(userId)

  async function rejected(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ApiError)
    return { status: (error as ApiError).status, code: (error as ApiError).code }
  }

  it('兑换成功：发一个带有效期的 redeem 批次，次数 +1，流水与余额一致', async () => {
    addCode('ABCDEFGH2345', { credits: 15, validDays: 7 })
    const before = Date.now()
    const result = await redeemCode(db, 'u1', 'ABCDEFGH2345')
    expect(result.credits).toBe(15)
    const expires = Date.parse(result.expiresAt!)
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY)
    expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY)
    expect(grants('u1')).toEqual([{ source: 'redeem', refId: 'ABCDEFGH2345', amount: 15, remaining: 15, expiresAt: result.expiresAt }])
    expect(ledger('u1')).toEqual([{ reason: 'redeem', delta: 15, refId: 'ABCDEFGH2345' }])
    expect(balance('u1')).toBe(15)
    expect(usedCount('ABCDEFGH2345')).toBe(1)
  })

  it('不设有效期时积分永不过期', async () => {
    addCode('LAUNCH2026', { maxUses: 100 })
    expect((await redeemCode(db, 'u1', 'LAUNCH2026')).expiresAt).toBeNull()
    expect(grants('u1')[0]!.expiresAt).toBeNull()
  })

  it('同一用户重复兑换 409 already_redeemed，不重复发积分', async () => {
    addCode('LAUNCH2026', { maxUses: 100 })
    await redeemCode(db, 'u1', 'LAUNCH2026')
    expect(await rejected(redeemCode(db, 'u1', 'LAUNCH2026'))).toEqual({ status: 409, code: 'already_redeemed' })
    expect(balance('u1')).toBe(10)
    expect(usedCount('LAUNCH2026')).toBe(1)
  })

  it('次数用完 409 code_used_up；不存在、已停用、已过截止时间都是 400 invalid_code', async () => {
    addCode('ONCEONLY', { maxUses: 1 })
    addCode('DISABLED', { disabled: true })
    addCode('PASTDEADLINE', { expiresAt: iso(-1000) })
    await redeemCode(db, 'u1', 'ONCEONLY')
    expect(await rejected(redeemCode(db, 'u2', 'ONCEONLY'))).toEqual({ status: 409, code: 'code_used_up' })
    expect(await rejected(redeemCode(db, 'u1', 'NOSUCHCODE'))).toEqual({ status: 400, code: 'invalid_code' })
    expect(await rejected(redeemCode(db, 'u1', 'DISABLED'))).toEqual({ status: 400, code: 'invalid_code' })
    expect(await rejected(redeemCode(db, 'u1', 'PASTDEADLINE'))).toEqual({ status: 400, code: 'invalid_code' })
    expect(balance('u2')).toBe(0)
    expect(grants('u2')).toEqual([])
  })

  // 并发：预检查都在写入前完成（读到的是旧状态），由 batch 里的条件和 credit_guard 断言兜底
  it('并发兑换不超出次数：两次可用的码被三个用户同时兑换，只有两个成功', async () => {
    addCode('TWICE', { maxUses: 2 })
    const results = await Promise.allSettled(['u1', 'u2', 'u3'].map((u) => redeemCode(db, u, 'TWICE')))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failure.reason as ApiError).code).toBe('code_used_up')
    expect(usedCount('TWICE')).toBe(2)
    expect(['u1', 'u2', 'u3'].map(balance).sort()).toEqual([0, 10, 10])
  })

  it('同一用户并发提交两次只到账一次', async () => {
    addCode('LAUNCH2026', { maxUses: 100 })
    const results = await Promise.allSettled([redeemCode(db, 'u1', 'LAUNCH2026'), redeemCode(db, 'u1', 'LAUNCH2026')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as ApiError).code).toBe('already_redeemed')
    expect(balance('u1')).toBe(10)
    expect(usedCount('LAUNCH2026')).toBe(1)
  })

  it('预检查之后码被停用：兑换失败且不留下兑换记录', async () => {
    addCode('LAUNCH2026', { maxUses: 100 })
    const pending = redeemCode(db, 'u1', 'LAUNCH2026')
    sqlite.prepare('UPDATE arv_redeem_codes SET disabled_at = ? WHERE code = ?').run(iso(0), 'LAUNCH2026')
    expect(await rejected(pending)).toEqual({ status: 400, code: 'invalid_code' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_redeem_uses').get()).toEqual({ n: 0 })
    expect(balance('u1')).toBe(0)
  })
})
