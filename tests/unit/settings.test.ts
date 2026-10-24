import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { DEFAULT_SETTINGS, dailyCapGuard, generationsToday, getSettings, mergeSettings, parseSettingsPatch } from '#/server/settings'
import { ApiError } from '#/server/util'
import { type Stmt, d1Shim, kvShim, migrate } from './d1-sqlite'

const invalid = (input: unknown) => {
  try {
    parseSettingsPatch(input)
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_setting' })
    return (error as ApiError).message
  }
  throw new Error('expected invalid_setting')
}

describe('后台提交的运营参数', () => {
  it('未知字段、类型不对、越界或超长都整体拒绝，并说明是哪一项', () => {
    expect(invalid({ signupBonusCredits: 10, UNKNOWN_SECRET: 'x' })).toContain('UNKNOWN_SECRET')
    expect(invalid({ signupBonusCredits: 1001 })).toContain('0–1000')
    expect(invalid({ signupBonusCredits: 1.5 })).toContain('注册赠送积分')
    expect(invalid({ signupBonusCredits: '10' })).toContain('注册赠送积分')
    expect(invalid({ generationDailyCap: -1 })).toContain('全站每日生成上限')
    expect(invalid({ maintenance: 'true' })).toContain('开或关')
    expect(invalid({ 'announcement.en': 'x'.repeat(201) })).toContain('200')
    expect(invalid({})).toBe('没有要保存的参数')
    expect(invalid([])).toBe('没有要保存的参数')
    expect(invalid(null)).toBe('没有要保存的参数')
  })

  it('公告压成一行纯文本；首尾和连续空白不算进长度', () => {
    expect(parseSettingsPatch({ 'announcement.zh': '  新功能\n上线   了 ', maintenance: true })).toEqual({ 'announcement.zh': '新功能 上线 了', maintenance: true })
    expect(parseSettingsPatch({ 'announcement.en': ` ${'x'.repeat(200)}\n\n` })).toEqual({ 'announcement.en': 'x'.repeat(200) })
  })

  it('邀请奖励的上限跟随 site.ts：site.ts 关闭邀请时只能是 0', () => {
    if (site.referralRewardCredits > 0) expect(parseSettingsPatch({ referralRewardCredits: 1000 })).toEqual({ referralRewardCredits: 1000 })
    else expect(invalid({ referralRewardCredits: 1 })).toContain('邀请奖励积分')
  })
})

describe('存值合并', () => {
  it('没有存值时取 site.ts 默认；非法、越界和已删除字段的存值丢弃', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.signupBonusCredits).toBe(site.signupBonusCredits)
    const merged = mergeSettings({ signupBonusCredits: 5000, signupBonusValidDays: 7, maintenance: 1, removedField: true, 'announcement.en': 'Hi' })
    expect(merged.signupBonusCredits).toBe(site.signupBonusCredits)
    expect(merged.signupBonusValidDays).toBe(7)
    expect(merged.maintenance).toBe(false)
    expect(merged['announcement.en']).toBe('Hi')
    expect(merged).not.toHaveProperty('removedField')
  })
})

describe('读取与每日上限（SQLite）', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let kv: ReturnType<typeof kvShim>
  let seq = 0

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    migrate(sqlite)
    // 只测计数，不建用户
    sqlite.exec('PRAGMA foreign_keys = OFF')
    db = d1Shim(sqlite) as unknown as D1Database
    kv = kvShim()
  })

  const env = () => ({ DB: db, KV: kv }) as unknown as Env
  const store = (key: string, raw: string) => sqlite.prepare(`INSERT INTO arv_settings (key, value, updated_at) VALUES (?, ?, '2026-01-01')`).run(key, raw)
  const generation = (createdAt: string) => {
    const id = `gen_${++seq}`
    return db
      .prepare(
        `INSERT INTO arv_generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, provider, created_at, updated_at)
         VALUES (?, 'u', 't', 'd', 5, 1, 'up', 'mock', ?, ?)`,
      )
      .bind(id, createdAt, createdAt)
  }
  const run = (statements: D1PreparedStatement[]) => db.batch(statements as unknown as Stmt[] as unknown as D1PreparedStatement[])

  it('KV 未命中时读 D1 并写回缓存；缓存期内改 D1 不生效，清缓存后生效；坏 JSON 的行忽略', async () => {
    store('signupBonusCredits', '3')
    store('signupBonusValidDays', '{oops')
    expect((await getSettings(env())).signupBonusCredits).toBe(3)
    expect(JSON.parse(kv.store.get('settings:v1')!)).toEqual({ signupBonusCredits: 3 })

    sqlite.prepare(`UPDATE arv_settings SET value = '9' WHERE key = 'signupBonusCredits'`).run()
    expect((await getSettings(env())).signupBonusCredits).toBe(3)
    kv.store.clear()
    const fresh = await getSettings(env())
    expect(fresh.signupBonusCredits).toBe(9)
    expect(fresh.signupBonusValidDays).toBe(site.signupBonusValidDays)
  })

  it('每日上限按 UTC 自然日计数；超出时整个 batch 回滚，昨天的不算', async () => {
    const now = '2026-10-21T23:59:00.000Z'
    await run([generation('2026-10-20T23:59:59.999Z')])
    await run([generation('2026-10-21T00:00:00.000Z')])
    expect(await generationsToday(db, now)).toBe(1)

    await run([generation(now), ...dailyCapGuard(db, 2, now)])
    expect(await generationsToday(db, now)).toBe(2)
    await expect(run([generation(now), ...dailyCapGuard(db, 2, now)])).rejects.toThrow(/CHECK constraint/)
    expect(await generationsToday(db, now)).toBe(2)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM arv_credit_guard').get()).toEqual({ n: 0 })

    expect(dailyCapGuard(db, 0, now)).toEqual([])
    await run([generation(now)])
    expect(await generationsToday(db, now)).toBe(3)
  })
})
