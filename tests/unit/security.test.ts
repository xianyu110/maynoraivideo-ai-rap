import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeRedirectPath } from '#/lib/redirect'
import { app } from '#/server/app'
import { signedUploadUrl } from '#/server/media'
import { ApiError } from '#/server/util'

const env = (vars: Record<string, unknown> = {}) => ({ APP_ENV: 'development', SITE_URL: 'https://site.example', ...vars }) as unknown as Env

afterEach(() => {
  vi.restoreAllMocks()
})

// 浏览器把 \ 当 /、丢掉 tab 和换行，/. 与 /..（含编码写法）规范化后留下 //：这些写法最终都指向另一个站点
const OFFSITE = [
  '/\\evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\\/evil.example',
  '//evil.example',
  '/..//evil.example',
  '/.//evil.example',
  '/%2e%2e//evil.example',
  'https://evil.example',
  'javascript:alert(1)',
]

describe('safeRedirectPath', () => {
  it('站外地址、非站内路径和空值回退到默认页', () => {
    for (const value of [...OFFSITE, 'dashboard', '', undefined, null]) {
      expect(safeRedirectPath(value, '/dashboard'), JSON.stringify(value)).toBe('/dashboard')
    }
  })

  it('站内路径连同查询串和锚点保留，编码过的反斜杠只是普通路径字符', () => {
    expect(safeRedirectPath('/zh/pricing?ref=sign-in#faq', '/dashboard')).toBe('/zh/pricing?ref=sign-in#faq')
    expect(safeRedirectPath('/%5Cevil.example', '/dashboard')).toBe('/%5Cevil.example')
  })
})

// 回调按 oauth_state cookie 里存的地址 302，入口就要把站外地址换掉
describe('GET /api/auth/google/start', () => {
  async function storedRedirect(redirect: string) {
    const google = env({ GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' })
    const res = await app.request(`/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`, {}, google)
    expect(res.status).toBe(302)
    const cookie = /oauth_state=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''
    return decodeURIComponent(cookie).split('|').slice(3).join('|')
  }

  it('站外 redirect 存成 /dashboard，站内地址原样保留', async () => {
    expect(await storedRedirect('/\\evil.example')).toBe('/dashboard')
    expect(await storedRedirect('/..//evil.example')).toBe('/dashboard')
    expect(await storedRedirect('/zh/pricing?ref=1')).toBe('/zh/pricing?ref=1')
  })
})

// 5xx 的 message 可能带配置或支付商细节。这里用“开了 Turnstile 却没配 secret”触发：
// /api/contact 校验完字段后抛 503 captcha_not_configured，还没碰数据库
describe('5xx 错误详情', () => {
  const contact = (target: Env, headers: Record<string, string> = {}) =>
    app.request(
      '/api/contact',
      {
        method: 'POST',
        headers: { origin: 'https://site.example', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'visitor@example.com', message: 'hello there, testing' }),
      },
      target,
    )

  it('访客只拿到错误码，详情写进日志', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await contact(env({ TURNSTILE_SITE_KEY: 'site-key' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'captcha_not_configured' })
    expect(log.mock.calls.flat().join(' ')).toContain('TURNSTILE_SECRET_KEY')
  })

  it('管理员能看到详情（后台操作失败时据此显示原因）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = { id: 'usr_admin', email: 'admin@example.com', role: 'admin', status: 'active' }
    const DB = { prepare: () => ({ bind: () => ({ first: async () => admin }) }) }
    const res = await contact(env({ TURNSTILE_SITE_KEY: 'site-key', DB }), { cookie: 'sid=session-token' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'captcha_not_configured', message: expect.stringContaining('TURNSTILE_SECRET_KEY') })
  })
})

// 上传图片的签名 URL 和视频 webhook 回调 token 都用 SESSION_SECRET 做 HMAC；.dev.vars.example 随模板公开，里面的占位值人人都知道
describe('签名密钥', () => {
  const example = /^SESSION_SECRET=(.*)$/m.exec(readFileSync('.dev.vars.example', 'utf8'))?.[1]?.trim() ?? ''

  it('生产环境密钥缺失、过短或仍是示例值时拒绝签名', async () => {
    expect(example).not.toBe('')
    for (const SESSION_SECRET of [undefined, 'short', example]) {
      const error = await signedUploadUrl(env({ APP_ENV: 'production', SESSION_SECRET }), 'upl_1').catch((e: unknown) => e)
      expect(error, String(SESSION_SECRET)).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe('server_misconfigured')
    }
    const strong = env({ APP_ENV: 'production', SESSION_SECRET: 'x'.repeat(64) })
    expect(await signedUploadUrl(strong, 'upl_1')).toMatch(/^https:\/\/site\.example\/media\/uploads\/upl_1\?exp=\d+&sig=/)
  })

  it('本地开发照常使用示例值（复制 .dev.vars.example 即可启动）', async () => {
    expect(await signedUploadUrl(env({ SESSION_SECRET: example }), 'upl_1')).toContain('&sig=')
  })
})
