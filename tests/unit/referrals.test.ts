import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { ledgerStatements } from '#/server/credits'
import { processPaymentEvent, refundOrder } from '#/server/orders'
import type { PaymentEvent } from '#/server/payments/types'
import { bindReferralStatement, normalizeReferralCode, referralIpHash } from '#/server/referrals'
import type { OrderRow } from '#/server/types'
import { type Stmt, d1Shim, kvShim, migrate } from './d1-sqlite'

// 入账后的通知邮件与本测试无关
vi.mock('#/server/notifications', () => ({ notifyOrderPaid: async () => {} }))

const DAY = 86400_000
const REWARD = site.referralRewardCredits
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

describe('邀请码与 IP 哈希', () => {
  it('邀请码 8 位、只认字母表内的字符，忽略大小写', () => {
    expect(normalizeReferralCode(' abcdefgh ')).toBe('ABCDEFGH')
    expect(normalizeReferralCode('ABCDEFG')).toBeNull()
    expect(normalizeReferralCode('ABCDEFG1')).toBeNull() // 1 不在字母表里
    expect(normalizeReferralCode("AB' OR 1")).toBeNull()
    expect(normalizeReferralCode(undefined)).toBeNull()
  })

  it('IP 只存加盐哈希；IPv6 同一个 /64 视为同一个 IP', async () => {
    const a = await referralIpHash('s', '2001:db8:1:2:aaaa::1')
    expect(a).toBe(await referralIpHash('s', '2001:DB8:1:2:bbbb::9'))
    expect(a).not.toBe(await referralIpHash('s', '2001:db8:1:3::1'))
    expect(await referralIpHash('s', '1.2.3.4')).not.toBe(await referralIpHash('s', '1.2.3.5'))
    expect(await referralIpHash('s', '1.2.3.4')).not.toBe(await referralIpHash('t', '1.2.3.4'))
    expect(await referralIpHash('s', null)).toBeNull()
  })
})

describe('邀请奖励', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let kv: ReturnType<typeof kvShim>
  let seq = 0

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    migrate(sqlite)
    db = d1Shim(sqlite) as unknown as D1Database
    kv = kvShim()
    addUser('inviter', 'INVITER2')
  })

  const run = (statements: D1PreparedStatement[]) => db.batch(statements as unknown as Stmt[] as unknown as D1PreparedStatement[])
  const credits = (id: string) => (sqlite.prepare('SELECT credits FROM arv_users WHERE id = ?').get(id) as { credits: number }).credits
  const referral = (invitee: string) =>
    sqlite.prepare('SELECT status, reject_reason, reward_order_id, reward_credits FROM arv_referrals WHERE invitee_id = ?').get(invitee) as
      | { status: string; reject_reason: string | null; reward_order_id: string | null; reward_credits: number | null }
      | undefined
  const ledger = (id: string) =>
    (sqlite.prepare('SELECT reason, delta, ref_id FROM arv_credit_ledger WHERE user_id = ? ORDER BY rowid').all(id) as Array<{
      reason: string
      delta: number
      ref_id: string | null
    }>).map((e) => [e.reason, e.delta, e.ref_id])

  function addUser(id: string, code: string | null = null, status = 'active') {
    sqlite
      .prepare('INSERT INTO arv_users (id, email, credits, referral_code, status, created_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(id, `${id}@example.com`, code, status, iso())
  }

  // 新用户注册：插入用户后在同一个 batch 里绑定
  async function signup(id: string, code = 'INVITER2', ipHash: string | null = null) {
    addUser(id)
    await run([bindReferralStatement(db, id, { code, ipHash })])
  }

  function addOrder(userId: string, amountCents = 990, orderCredits = 20) {
    const id = `ord_${++seq}`
    sqlite
      .prepare(
        `INSERT INTO arv_orders (id, user_id, provider, package_id, credits, amount_cents, currency, status, created_at, updated_at)
         VALUES (?, ?, 'mock', 'starter', ?, ?, 'USD', 'pending', ?, ?)`,
      )
      .run(id, userId, orderCredits, amountCents, iso(), iso())
    return id
  }

  const paid = (orderId: string, eventId = `evt_paid_${orderId}`): PaymentEvent => ({
    kind: 'paid',
    eventId,
    eventType: 'mock.paid',
    orderId,
    providerOrderId: null,
    providerPaymentId: `pay_${orderId}`,
    paidAmount: '9.90',
    paidCurrency: 'USD',
    paidAmountCents: 990,
  })
  const pay = (orderId: string, eventId?: string) => processPaymentEvent({ DB: db, KV: kv } as unknown as Env, 'mock', paid(orderId, eventId), '{}')
  // 后台运营参数：直接写 settings 表（KV 里还没有缓存时从 D1 读）
  const setting = (key: string, value: unknown) =>
    sqlite.prepare('INSERT INTO arv_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), iso())
  const order = (id: string) => sqlite.prepare('SELECT * FROM arv_orders WHERE id = ?').get(id) as unknown as OrderRow

  it('绑定：邀请码不存在或邀请人不可用时不绑定；同一 IP 超过上限的记为 rejected，不知道 IP 时不限', async () => {
    await signup('nobody', 'NOSUCH22')
    expect(referral('nobody')).toBeUndefined()
    addUser('banned', 'BANNED22', 'banned')
    await signup('fan', 'BANNED22')
    expect(referral('fan')).toBeUndefined()

    for (let i = 0; i < site.referralMaxPerIp + 1; i++) await signup(`same_ip_${i}`, 'INVITER2', 'hash_a')
    const statuses = Array.from({ length: site.referralMaxPerIp + 1 }, (_, i) => referral(`same_ip_${i}`))
    expect(statuses.slice(0, -1).every((r) => r?.status === 'pending')).toBe(true)
    expect(statuses.at(-1)).toMatchObject({ status: 'rejected', reject_reason: 'ip_limit' })
    await signup('other_ip', 'INVITER2', 'hash_b')
    expect(referral('other_ip')?.status).toBe('pending')
    for (let i = 0; i < site.referralMaxPerIp + 1; i++) await signup(`no_ip_${i}`, 'INVITER2', null)
    expect(referral(`no_ip_${site.referralMaxPerIp}`)?.status).toBe('pending')
  })

  it('首单付款给邀请人发奖励（流水 ref 是订单），第二笔订单不再发；没被邀请的用户付款不影响', async () => {
    await signup('friend')
    const first = addOrder('friend')
    expect((await pay(first)).status).toBe('processed')
    expect(credits('friend')).toBe(20)
    expect(credits('inviter')).toBe(REWARD)
    expect(ledger('inviter')).toEqual([['referral', REWARD, first]])
    expect(referral('friend')).toMatchObject({ status: 'rewarded', reward_order_id: first, reward_credits: REWARD })

    expect((await pay(addOrder('friend'))).status).toBe('processed')
    expect((await pay(first, 'evt_replay')).status).toBe('duplicate')
    addUser('stranger')
    expect((await pay(addOrder('stranger'))).status).toBe('processed')
    expect(credits('inviter')).toBe(REWARD)
    expect(credits('friend')).toBe(40)
  })

  it('同一被邀请人两笔订单同时入账：两笔都到账，奖励只发一次', async () => {
    await signup('friend')
    const [a, b] = [addOrder('friend'), addOrder('friend')]
    const results = await Promise.all([pay(a), pay(b)])
    expect(results.map((r) => r.status)).toEqual(['processed', 'processed'])
    expect([order(a).status, order(b).status]).toEqual(['paid', 'paid'])
    expect(credits('friend')).toBe(40)
    expect(credits('inviter')).toBe(REWARD)
    expect(ledger('inviter')).toHaveLength(1)
  })

  it('邀请人 30 天内的奖励达到上限、或付款时邀请人已不可用：标记 rejected，不发；30 天前的不计入', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO arv_referrals (invitee_id, inviter_id, status, reward_order_id, reward_credits, rewarded_at, created_at)
       VALUES (?, 'inviter', ?, ?, ?, ?, ?)`,
    )
    for (let i = 0; i < site.referralMonthlyCap; i++) {
      addUser(`old_${i}`)
      // 最后一个是 31 天前的，不计入；其余在 30 天内（其中一个已回收，也计入）
      const at = i === site.referralMonthlyCap - 1 ? iso(-31 * DAY) : iso(-DAY)
      insert.run(`old_${i}`, i === 0 ? 'reversed' : 'rewarded', `ord_old_${i}`, REWARD, at, at)
    }
    await signup('last_slot')
    await pay(addOrder('last_slot'))
    expect(referral('last_slot')?.status).toBe('rewarded')
    await signup('over_cap')
    await pay(addOrder('over_cap'))
    expect(referral('over_cap')).toMatchObject({ status: 'rejected', reject_reason: 'monthly_cap' })
    expect(credits('inviter')).toBe(REWARD)

    addUser('gone', 'GONEGONE')
    await signup('orphan', 'GONEGONE')
    sqlite.prepare(`UPDATE arv_users SET status = 'deleted' WHERE id = 'gone'`).run()
    await pay(addOrder('orphan'))
    expect(referral('orphan')).toMatchObject({ status: 'rejected', reject_reason: 'inviter_inactive' })
    expect(credits('gone')).toBe(0)
  })

  it('奖励积分按后台运营参数发；暂停（0）期间付款的首单记为 rejected（paused），恢复后第二单也不补发', async () => {
    setting('referralRewardCredits', 25)
    await signup('friend')
    await pay(addOrder('friend'))
    expect(credits('inviter')).toBe(25)
    expect(referral('friend')).toMatchObject({ status: 'rewarded', reward_credits: 25 })

    kv.store.clear()
    sqlite.prepare(`UPDATE arv_settings SET value = '0' WHERE key = 'referralRewardCredits'`).run()
    await signup('late')
    await pay(addOrder('late'))
    expect(referral('late')).toMatchObject({ status: 'rejected', reject_reason: 'paused' })

    kv.store.clear()
    sqlite.prepare(`DELETE FROM arv_settings`).run()
    await pay(addOrder('late'))
    expect(referral('late')?.status).toBe('rejected')
    expect(credits('inviter')).toBe(25)
  })

  it('奖励订单退款（部分退款也算）：整笔回收邀请人的奖励，再退款不重复回收；邀请人已花掉的最多扣到 0', async () => {
    await signup('friend')
    const id = addOrder('friend')
    await pay(id)
    // 邀请人先花掉 4 积分
    await run(ledgerStatements(db, { userId: 'inviter', delta: -4, reason: 'generation', idempotencyKey: 'gen:1' }))
    expect(await refundOrder(db, order(id), { refundKey: 'rf_1', amountCents: 300, note: 'partial' })).toBe(true)
    expect(referral('friend')?.status).toBe('reversed')
    expect(credits('inviter')).toBe(0)
    expect(ledger('inviter').at(-1)).toEqual(['referral_refund', -(REWARD - 4), id])
    expect(await refundOrder(db, order(id), { refundKey: 'rf_2', amountCents: null, note: 'rest' })).toBe(true)
    expect(order(id).status).toBe('refunded')
    expect(ledger('inviter').filter(([reason]) => reason === 'referral_refund')).toHaveLength(1)
    expect(credits('friend')).toBe(0)
  })

  it('同一订单两笔退款同时处理：两笔退款都生效，奖励只回收一次', async () => {
    await signup('friend')
    const id = addOrder('friend')
    await pay(id)
    // 邀请人另有 50 积分：回收只能扣奖励那 10 个，不能因为重复回收扣到别的批次
    await run(ledgerStatements(db, { userId: 'inviter', delta: 50, reason: 'admin_adjust', idempotencyKey: 'adj:1' }))
    const stale = order(id)
    const results = await Promise.all([
      refundOrder(db, stale, { refundKey: 'rf_a', amountCents: 300, note: 'a' }),
      refundOrder(db, stale, { refundKey: 'rf_b', amountCents: 300, note: 'b' }),
    ])
    expect(results).toEqual([true, true])
    expect(order(id).refunded_amount_cents).toBe(600)
    expect(credits('inviter')).toBe(50)
    expect(ledger('inviter').map(([reason, delta]) => [reason, delta])).toEqual([
      ['referral', REWARD],
      ['admin_adjust', 50],
      ['referral_refund', -REWARD],
    ])
  })

  it('没发过奖励的订单退款不碰邀请人', async () => {
    await signup('friend')
    const first = addOrder('friend')
    const second = addOrder('friend')
    await pay(first)
    await pay(second)
    expect(await refundOrder(db, order(second), { refundKey: 'rf', amountCents: null, note: 'full' })).toBe(true)
    expect(referral('friend')?.status).toBe('rewarded')
    expect(credits('inviter')).toBe(REWARD)
  })
})
