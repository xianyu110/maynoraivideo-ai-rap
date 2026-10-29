import { afterEach, describe, expect, it, vi } from 'vitest'
import { sellingPlans, site } from '#/config/site'
import { runProbe } from '#/server/probes'
import type { UserRow } from '#/server/types'
import { kvShim } from './d1-sqlite'

const admin = { id: 'usr_admin', email: 'admin@example.com', role: 'admin' } as UserRow
const DODO_KEY = 'dodo_test_key_1234567890'
// 与 probes.ts 一致：订阅关闭时只探测积分包
const ITEMS = [...site.packages, ...sellingPlans]
const DODO_PRODUCTS = JSON.stringify(Object.fromEntries(ITEMS.map((pack) => [pack.id, `pdt_${pack.id}`])))

type Reply = { status?: number; body?: unknown }
// 按 URL 片段返回假响应，并记下请求过的 URL 和 Authorization 头
function stubFetch(routes: Record<string, Reply | ((url: string) => Reply)>) {
  const calls: Array<{ url: string; auth: string | null }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization') })
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment))
    if (!match) throw new Error(`unexpected fetch ${url}`)
    const reply = typeof match[1] === 'function' ? match[1](url) : match[1]
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

const dodoPrice = (prices: Record<string, number>, currency = 'USD') => (url: string) => {
  const packId = decodeURIComponent(url.split('/products/')[1]!).replace('pdt_', '')
  return { body: { product_id: `pdt_${packId}`, price: { price: prices[packId] ?? ITEMS.find((p) => p.id === packId)!.priceCents, currency } } }
}

const probe = (target: Parameters<typeof runProbe>[1], env: Record<string, unknown>) => runProbe(env as unknown as Env, target, admin)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('支付探测', () => {
  const dodo = { PAYMENT_PROVIDER: 'dodo', DODO_API_KEY: DODO_KEY, DODO_PRODUCTS }

  it('Dodo：每个套餐的商品和价格一致时 ok，只读 GET 商品接口，走 test 环境', async () => {
    const calls = stubFetch({ '/products/': dodoPrice({}) })
    const result = await probe('payment', dodo)
    expect(result).toMatchObject({ target: 'payment', provider: 'dodo', status: 'ok' })
    expect(calls.map((c) => c.url)).toEqual(ITEMS.map((pack) => `https://test.dodopayments.com/products/pdt_${pack.id}`))
    expect(calls.every((c) => c.auth === `Bearer ${DODO_KEY}`)).toBe(true)
  })

  it('Dodo：售价低于 site.ts 时 fail（付款会因金额不符不入账）；高于或币种不同只提示', async () => {
    const [cheap, pricey] = site.packages
    stubFetch({ '/products/': dodoPrice({ [cheap!.id]: cheap!.priceCents - 1, [pricey!.id]: pricey!.priceCents + 100 }) })
    const result = await probe('payment', dodo)
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${cheap!.id}：Dodo 售价 ${cheap!.priceCents - 1} 低于`)
    expect(result.message).toContain(`${pricey!.id}：Dodo 售价 ${pricey!.priceCents + 100} 高于`)

    stubFetch({ '/products/': dodoPrice({ [pricey!.id]: pricey!.priceCents + 100 }) })
    expect(await probe('payment', dodo)).toMatchObject({ status: 'warn' })
    stubFetch({ '/products/': dodoPrice({}, 'EUR') })
    expect((await probe('payment', dodo)).message).toContain('币种是 EUR')
  })

  it('Dodo：Key 无效、商品不存在、套餐没配商品 ID 都是 fail，说明里不带 Key', async () => {
    stubFetch({ '/products/': { status: 401 } })
    const unauthorized = await probe('payment', { ...dodo, DODO_ENVIRONMENT: 'live' })
    expect(unauthorized).toMatchObject({ status: 'fail' })
    expect(unauthorized.message).toContain('DODO_ENVIRONMENT=live')

    stubFetch({ '/products/': { status: 404 } })
    const [first, ...rest] = site.packages
    const partial = JSON.stringify(Object.fromEntries(rest.map((pack) => [pack.id, `pdt_${pack.id}`])))
    const result = await probe('payment', { ...dodo, DODO_PRODUCTS: partial })
    expect(result.status).toBe('fail')
    expect(result.message).toContain(`${first!.id}：DODO_PRODUCTS 里没有商品 ID`)
    expect(result.message).toContain(`商品 pdt_${rest[0]!.id} 不存在`)
    expect(await probe('payment', { PAYMENT_PROVIDER: 'dodo', DODO_PRODUCTS })).toMatchObject({ status: 'fail', message: 'DODO_API_KEY 未配置' })
  })

  it('mock 不调用外部接口；生产环境配了 mock 时报 fail 而不是抛错', async () => {
    stubFetch({})
    expect(await probe('payment', { PAYMENT_PROVIDER: 'mock' })).toMatchObject({ status: 'ok', provider: 'mock' })
    expect(await probe('payment', { PAYMENT_PROVIDER: 'mock', APP_ENV: 'production' })).toMatchObject({ status: 'fail' })
  })
})

describe('视频服务商探测', () => {
  it('tryallapi：401/403 fail；其它 4xx 视为鉴权正常；缺 key fail；不支持的 provider fail', async () => {
    const env = { VIDEO_PROVIDER: 'tryallapi', TRYALLAPI_API_KEY: 'tryall_key_abcdefgh' }
    const calls = stubFetch({ 'tryallapi.com/v1/video/generations/probe_health_check': { status: 404, body: { error: 'not found' } } })
    const ok = await probe('video', env)
    expect(ok).toMatchObject({ status: 'ok', provider: 'tryallapi' })
    expect(ok.message).toContain('鉴权正常')
    expect(calls[0]?.auth).toBe('Bearer tryall_key_abcdefgh')

    stubFetch({ 'tryallapi.com': { status: 401 } })
    expect(await probe('video', env)).toMatchObject({ status: 'fail', message: expect.stringMatching(/无效|无权/) })
    stubFetch({ 'tryallapi.com': { status: 403 } })
    expect(await probe('video', env)).toMatchObject({ status: 'fail' })
    stubFetch({ 'tryallapi.com': { status: 500 } })
    expect(await probe('video', env)).toMatchObject({ status: 'fail', message: expect.stringContaining('500') })
    expect(await probe('video', { VIDEO_PROVIDER: 'tryallapi' })).toMatchObject({ status: 'fail', message: 'TRYALLAPI_API_KEY 未配置' })
    expect(await probe('video', { VIDEO_PROVIDER: 'fal' })).toMatchObject({ status: 'fail' })
  })

  it('yir：查余额接口；缺 key fail', async () => {
    const env = { VIDEO_PROVIDER: 'yir', YIR_API_KEY: 'yir_key_abcdefgh' }
    const calls = stubFetch({ 'gateway.yir.ai/v1/balance': { body: { available_amount: '12.00', currency: 'USD' } } })
    expect(await probe('video', env)).toMatchObject({ status: 'ok', provider: 'yir' })
    expect(calls[0]?.auth).toBe('Bearer yir_key_abcdefgh')
    expect(await probe('video', { VIDEO_PROVIDER: 'yir' })).toMatchObject({ status: 'fail', message: 'YIR_API_KEY 未配置' })
  })

  it('上游报错里出现的密钥值被替换掉', async () => {
    const key = 'tryall_secret_value_123'
    vi.stubGlobal('fetch', async () => {
      throw new Error(`connect failed for Bearer ${key} (OPENAI ${'sk-other-secret'})`)
    })
    const result = await probe('video', {
      VIDEO_PROVIDER: 'tryallapi',
      TRYALLAPI_API_KEY: `${key}\n`,
      OPENAI_API_KEY: 'sk-other-secret',
      SITE_URL: 'http://localhost',
    })
    expect(result.status).toBe('fail')
    expect(result.message).toBe('connect failed for Bearer *** (OPENAI ***)')
  })
})

describe('其他依赖', () => {
  it('发信未配置时 skipped；配置后给管理员发一封测试邮件', async () => {
    expect(await probe('email', {})).toMatchObject({ status: 'skipped' })
    const send = vi.fn(async () => ({ messageId: 'msg_1' }))
    const result = await probe('email', { EMAIL_FROM: 'noreply@example.com', EMAIL: { send } })
    expect(result.status).toBe('ok')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: admin.email, from: { email: 'noreply@example.com', name: site.brandName } }))
  })

  it('KV 和 R2 写读删，不留下探测数据；R2 写入失败时 fail', async () => {
    const kv = kvShim()
    expect(await probe('kv', { KV: kv })).toMatchObject({ status: 'ok' })
    expect(kv.store.size).toBe(0)

    const objects = new Map<string, string>()
    const media = {
      put: async (key: string, value: string) => void objects.set(key, value),
      head: async (key: string) => (objects.has(key) ? { key } : null),
      delete: async (key: string) => void objects.delete(key),
    }
    expect(await probe('storage', { MEDIA: media })).toMatchObject({ status: 'ok', provider: 'R2' })
    expect(objects.size).toBe(0)
    expect(await probe('storage', { MEDIA: { ...media, put: async () => Promise.reject(new Error('R2 down')) } })).toMatchObject({ status: 'fail', message: 'R2 down' })
  })

  it('审核：none 时 skipped；openai 查模型接口', async () => {
    expect(await probe('moderation', { MODERATION_PROVIDER: 'none' })).toMatchObject({ status: 'skipped' })
    stubFetch({ '/v1/models/omni-moderation-latest': { body: { id: 'omni-moderation-latest' } } })
    expect(await probe('moderation', { MODERATION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-12345678' })).toMatchObject({ status: 'ok' })
    stubFetch({ '/v1/models/': { status: 401 } })
    expect(await probe('moderation', { MODERATION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-12345678' })).toMatchObject({ status: 'fail' })
  })
})
