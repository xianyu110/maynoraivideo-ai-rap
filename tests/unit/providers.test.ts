import { describe, expect, it } from 'vitest'
import { activePaymentProviderId } from '#/server/payments'
import { activeVideoProviderId, videoFallbackProviderId } from '#/server/video'

// mock 支付/生成在生产环境必须不可用，否则任何人都能免费充值
describe('provider 选择', () => {
  const env = (vars: Record<string, string>) => vars as unknown as Env

  it('非生产环境允许 mock', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'mock' }))).toBe('mock')
    expect(activeVideoProviderId(env({ APP_ENV: 'preview', VIDEO_PROVIDER: 'mock' }))).toBe('mock')
  })

  it('生产环境和 staging 拒绝 mock，未知 provider 也拒绝', () => {
    expect(() => activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'mock' }))).toThrow(/VIDEO_PROVIDER/)
    // staging 部署在公开的 workers.dev 上，mock 支付等于免费充值
    expect(() => activePaymentProviderId(env({ APP_ENV: 'staging', PAYMENT_PROVIDER: 'mock' }))).toThrow(/PAYMENT_PROVIDER/)
    expect(() => activePaymentProviderId(env({ APP_ENV: 'development', PAYMENT_PROVIDER: 'creem' }))).toThrow()
  })

  it('生产环境正常选择 waffo / dodo / stripe / yir / tryallapi', () => {
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'waffo' }))).toBe('waffo')
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'dodo' }))).toBe('dodo')
    expect(activePaymentProviderId(env({ APP_ENV: 'production', PAYMENT_PROVIDER: 'stripe' }))).toBe('stripe')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'tryallapi' }))).toBe('tryallapi')
    expect(activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'yir' }))).toBe('yir')
    expect(() => activeVideoProviderId(env({ APP_ENV: 'production', VIDEO_PROVIDER: 'fal' }))).toThrow(/VIDEO_PROVIDER/)
  })

  it('VIDEO_FALLBACK_PROVIDER 与主服务商不同时才生效', () => {
    const base = { APP_ENV: 'production', VIDEO_PROVIDER: 'yir', VIDEO_FALLBACK_PROVIDER: 'tryallapi' }
    expect(videoFallbackProviderId(env(base))).toBe('tryallapi')
    expect(videoFallbackProviderId(env({ ...base, VIDEO_FALLBACK_PROVIDER: 'yir' }))).toBeNull()
    expect(videoFallbackProviderId(env({ ...base, VIDEO_FALLBACK_PROVIDER: '' }))).toBeNull()
  })
})
