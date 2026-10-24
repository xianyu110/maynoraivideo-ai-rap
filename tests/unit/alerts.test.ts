import { describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { alertBucket, evaluateHealth, type HealthStats } from '#/server/alerts'
import { renderEmail } from '#/server/email-templates'

function stats(overrides: Partial<HealthStats> = {}): HealthStats {
  return {
    generations: { finished: 40, failed: 1, topErrors: 'provider_error ×1' },
    deadLetters: 0,
    providerAccount: { count: 0, detail: null },
    backlog: 0,
    webhookFailures: { count: 0, latest: null },
    paymentReview: { count: 0, latest: null },
    emailFailures: 2,
    ...overrides,
  }
}

const kinds = (s: HealthStats) => evaluateHealth(s).map((a) => a.kind)

describe('evaluateHealth', () => {
  it('零星失败、少量邮件失败不告警', () => {
    expect(evaluateHealth(stats())).toEqual([])
  })

  it('生成失败：至少 3 个且占比 ≥ 30% 才告警', () => {
    for (const [failed, finished, expected] of [
      [2, 2, false],
      [3, 10, true],
      [3, 11, false],
      [0, 0, false],
    ] as const) {
      expect(kinds(stats({ generations: { finished, failed, topErrors: null } })).includes('generation_failures'), `${failed}/${finished}`).toBe(
        expected,
      )
    }
    const [alert] = evaluateHealth(stats({ generations: { finished: 4, failed: 4, topErrors: 'mock_failure ×4' } }))
    expect(alert).toEqual({ kind: 'generation_failures', count: 4, total: 4, windowMinutes: 60, detail: 'mock_failure ×4' })
  })

  it('死信、积压、支付回调失败出现 1 个就告警；邮件失败 3 封才告警', () => {
    expect(
      kinds(stats({ deadLetters: 1, backlog: 1, webhookFailures: { count: 1, latest: 'waffo order.paid: boom' }, emailFailures: 3 })),
    ).toEqual(['dead_letter', 'job_backlog', 'payment_webhook', 'email_failures'])
    const review = evaluateHealth(stats({ paymentReview: { count: 1, latest: 'dodo payment.succeeded mismatch ord_1: paid 1 < price 990 USD' } }))[0]
    expect(review).toMatchObject({ kind: 'payment_review', count: 1, windowMinutes: 1440 })
    // 服务商余额不足：1 个就告警，不等失败率（40 个里只失败 1 个也报）
    const account = evaluateHealth(stats({ providerAccount: { count: 1, detail: 'tryallapi_submit_402 ×1' } }))
    expect(account).toEqual([{ kind: 'provider_account', count: 1, total: null, windowMinutes: 60, detail: 'tryallapi_submit_402 ×1' }])
    const webhook = evaluateHealth(stats({ webhookFailures: { count: 2, latest: 'dodo payment.succeeded: boom' } }))[0]
    expect(webhook).toMatchObject({ kind: 'payment_webhook', count: 2, detail: 'dodo payment.succeeded: boom' })
  })
})

describe('alertBucket', () => {
  it('6 小时一个桶（UTC）：桶内不变，跨桶变化', () => {
    expect(alertBucket(Date.parse('2026-10-20T06:00:00Z'))).toBe('2026-10-20T06')
    expect(alertBucket(Date.parse('2026-10-20T11:59:59Z'))).toBe('2026-10-20T06')
    expect(alertBucket(Date.parse('2026-10-20T12:00:00Z'))).toBe('2026-10-20T12')
    expect(alertBucket(Date.parse('2026-10-20T23:59:59Z'))).toBe('2026-10-20T18')
  })
})

describe('admin_alert 邮件', () => {
  it('固定中文，带详情和对应的后台页面', () => {
    const ctx = { siteUrl: 'https://example.test/', locale: 'en' }
    const failures = renderEmail(
      'admin_alert',
      { kind: 'generation_failures', count: 3, total: 10, windowMinutes: 60, detail: 'mock_failure ×3' },
      ctx,
    )
    expect(failures.subject).toBe(`[${site.brandName}] 告警：生成失败率 30%`)
    expect(failures.text).toContain('详情：mock_failure ×3')
    expect(failures.text).toContain('https://example.test/admin/generations')

    const webhook = renderEmail('admin_alert', { kind: 'payment_webhook', count: 1, total: null, windowMinutes: 1440, detail: null }, ctx)
    expect(webhook.text).toContain('https://example.test/admin/events')
    expect(webhook.text).not.toContain('详情')
  })
})
