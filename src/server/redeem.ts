import type { Hono } from 'hono'
import { ledgerStatements } from './credits'
import { audit, pageParams, readJson, requireAdmin } from './http'
import { csvCell } from './reports'
import type { AppContext } from './types'
import { ApiError, createId, isCheckConstraintError, isUniqueConstraintError, nowIso } from './util'

// 兑换码：兑换在一个 D1 batch 里完成——写兑换记录、断言写入成功（次数没用完、没停用、没过期）、
// 次数 +1、发一个积分批次。每个用户每个码一次靠 redeem_uses 主键和流水幂等键 redeem:<code>:<userId> 保证。

// 随机码字母表：去掉易混的 I、O，0、1，正好 32 个字符；12 位约 60 bit，不可能被枚举
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const RANDOM_LENGTH = 12

export interface RedeemCodeRow {
  code: string
  batch_id: string
  credits: number
  max_uses: number
  used_count: number
  credit_valid_days: number | null
  expires_at: string | null
  note: string
  disabled_at: string | null
}

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH))
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('')
}

// 用户输入：忽略大小写、空格和连字符；只接受 4–32 位字母数字
export function normalizeCode(input: unknown) {
  if (typeof input !== 'string') return null
  const code = input.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null
}

// 展示用：随机码按 4 位分组，活动码原样
export function formatCode(code: string) {
  return code.length === RANDOM_LENGTH && [...code].every((ch) => ALPHABET.includes(ch)) ? code.match(/.{4}/g)!.join('-') : code
}

// 兑换前的检查（给出准确的错误码）；batch 里的条件和断言才是并发下的最终判断
function rejection(row: RedeemCodeRow | null, redeemed: boolean, now: string) {
  if (!row || row.disabled_at || (row.expires_at && row.expires_at <= now)) return new ApiError(400, 'invalid_code')
  if (redeemed) return new ApiError(409, 'already_redeemed')
  if (row.used_count >= row.max_uses) return new ApiError(409, 'code_used_up')
  return null
}

async function lookup(db: D1Database, code: string, userId: string) {
  const [row, use] = await db.batch([
    db.prepare('SELECT * FROM arv_redeem_codes WHERE code = ?').bind(code),
    db.prepare('SELECT 1 AS used FROM arv_redeem_uses WHERE code = ? AND user_id = ?').bind(code, userId),
  ])
  return { row: (row!.results[0] as RedeemCodeRow | undefined) ?? null, redeemed: use!.results.length > 0 }
}

export async function redeemCode(db: D1Database, userId: string, code: string) {
  const now = nowIso()
  const { row, redeemed } = await lookup(db, code, userId)
  const rejected = rejection(row, redeemed, now)
  if (rejected || !row) throw rejected ?? new ApiError(400, 'invalid_code')
  const expiresAt = row.credit_valid_days ? new Date(Date.parse(now) + row.credit_valid_days * 86400_000).toISOString() : null
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO arv_redeem_uses (code, user_id, created_at)
           SELECT code, ?2, ?3 FROM arv_redeem_codes
           WHERE code = ?1 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > ?3) AND used_count < max_uses`,
        )
        .bind(code, userId, now),
      db.prepare('INSERT INTO arv_credit_guard (ok) SELECT COUNT(*) = 1 FROM arv_redeem_uses WHERE code = ? AND user_id = ? AND created_at = ?').bind(code, userId, now),
      db.prepare('DELETE FROM arv_credit_guard'),
      db.prepare('UPDATE arv_redeem_codes SET used_count = used_count + 1 WHERE code = ?').bind(code),
      ...ledgerStatements(db, {
        userId,
        delta: row.credits,
        reason: 'redeem',
        refId: code,
        idempotencyKey: `redeem:${code}:${userId}`,
        note: row.batch_id,
        expiresAt,
      }),
    ])
  } catch (error) {
    // 并发下检查之后状态变了（次数被别人用完、刚被停用、同一用户重复提交）：重新读一次给出准确原因
    if (isCheckConstraintError(error) || isUniqueConstraintError(error)) {
      const again = await lookup(db, code, userId)
      throw rejection(again.row, again.redeemed, nowIso()) ?? new ApiError(409, 'code_used_up')
    }
    throw error
  }
  return { credits: row.credits, expiresAt }
}

// ---------- 后台：生成、列表、导出、停用 ----------

const MAX_BATCH = 1000

function optionalDays(value: unknown) {
  if (value == null || value === '') return null
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined
}

export function registerRedeemAdminRoutes(routes: Hono<AppContext>) {
  routes.post('/redeem-codes', async (c) => {
    const admin = requireAdmin(c)
    const body = await readJson<{
      credits: number
      count: number
      maxUses: number
      creditValidDays: number | null
      expiresInDays: number | null
      note: string
      code: string
    }>(c)
    const credits = Number(body.credits)
    if (!Number.isInteger(credits) || credits < 1 || credits > 100000) throw new ApiError(400, 'invalid_credits')
    const count = Number(body.count ?? 1)
    const maxUses = Number(body.maxUses ?? 1)
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw new ApiError(400, 'invalid_count')
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) throw new ApiError(400, 'invalid_max_uses')
    const creditValidDays = optionalDays(body.creditValidDays)
    const expiresInDays = optionalDays(body.expiresInDays)
    if (creditValidDays === undefined || expiresInDays === undefined) throw new ApiError(400, 'invalid_expiry')
    const note = (body.note ?? '').trim()
    if (!note || note.length > 200) throw new ApiError(400, 'note_required')
    // 指定的活动码（例如 LAUNCH2026）只能生成一个，通常配合 maxUses > 1
    const custom = body.code ? normalizeCode(body.code) : null
    if (body.code && !custom) throw new ApiError(400, 'invalid_code')
    if (custom && count !== 1) throw new ApiError(400, 'invalid_count')

    const now = nowIso()
    const expiresAt = expiresInDays ? new Date(Date.parse(now) + expiresInDays * 86400_000).toISOString() : null
    const batchId = createId('rdb')
    // 一条语句插入整批（json_each 展开），不受 D1 每次调用的查询数和绑定参数个数限制
    const insert = (codes: string[]) =>
      c.env.DB.prepare(
        `INSERT INTO arv_redeem_codes (code, batch_id, credits, max_uses, credit_valid_days, expires_at, note, created_by, created_at)
         SELECT value, ?, ?, ?, ?, ?, ?, ?, ? FROM json_each(?)`,
      )
        .bind(batchId, credits, maxUses, creditValidDays, expiresAt, note, admin.id, now, JSON.stringify(codes))
        .run()
    let codes: string[] = []
    for (let attempt = 0; ; attempt++) {
      codes = custom ? [custom] : [...new Set(Array.from({ length: count }, generateCode))]
      try {
        await insert(codes)
        break
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        if (custom) throw new ApiError(409, 'code_exists')
        // 随机码撞上已有的码（概率可忽略）：整条语句回滚，换一批重来
        if (attempt >= 2) throw error
      }
    }
    await audit(c.env, admin, 'redeem.create', 'redeem_batch', batchId, { credits, count: codes.length, maxUses, creditValidDays, expiresAt, note })
    return c.json({ batchId, codes: codes.map(formatCode) }, 201)
  })

  routes.get('/redeem-codes', async (c) => {
    const { limit, offset } = pageParams(c)
    const where: string[] = []
    const params: unknown[] = []
    const batch = c.req.query('batch')
    const q = (c.req.query('q') ?? '').replace(/[\s-]/g, '').toUpperCase()
    if (batch) {
      where.push('batch_id = ?')
      params.push(batch)
    }
    if (q) {
      where.push('(code LIKE ? OR note LIKE ?)')
      params.push(`%${q}%`, `%${c.req.query('q')!.trim()}%`)
    }
    const rows = await c.env.DB.prepare(
      `SELECT * FROM arv_redeem_codes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, code LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all<RedeemCodeRow & { created_at: string }>()
    return c.json({ codes: rows.results.map((row) => ({ ...row, display: formatCode(row.code) })) })
  })

  routes.get('/redeem-codes.csv', async (c) => {
    const batch = c.req.query('batch')
    const rows = await c.env.DB.prepare(
      `SELECT code, batch_id, credits, max_uses, used_count, credit_valid_days, expires_at, note, disabled_at, created_at
       FROM arv_redeem_codes ${batch ? 'WHERE batch_id = ?' : ''} ORDER BY created_at DESC, code LIMIT 10000`,
    )
      .bind(...(batch ? [batch] : []))
      .all<Record<string, unknown> & { code: string }>()
    const columns = ['code', 'batch_id', 'credits', 'max_uses', 'used_count', 'credit_valid_days', 'expires_at', 'note', 'disabled_at', 'created_at']
    const lines = rows.results.map((row) => columns.map((col) => csvCell(col === 'code' ? formatCode(row.code) : row[col])).join(','))
    return c.body(`\uFEFF${[columns.join(','), ...lines].join('\r\n')}\r\n`, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="redeem-codes-${batch ?? 'all'}.csv"`,
    })
  })

  routes.post('/redeem-codes/:code/disable', async (c) => {
    const admin = requireAdmin(c)
    const code = normalizeCode(c.req.param('code'))
    if (!code) throw new ApiError(404, 'not_found')
    const result = await c.env.DB.prepare('UPDATE arv_redeem_codes SET disabled_at = ? WHERE code = ? AND disabled_at IS NULL').bind(nowIso(), code).run()
    if (!result.meta.changes) {
      const exists = await c.env.DB.prepare('SELECT 1 FROM arv_redeem_codes WHERE code = ?').bind(code).first()
      if (!exists) throw new ApiError(404, 'not_found')
      return c.json({ ok: true })
    }
    await audit(c.env, admin, 'redeem.disable', 'redeem_code', code)
    return c.json({ ok: true })
  })
}
