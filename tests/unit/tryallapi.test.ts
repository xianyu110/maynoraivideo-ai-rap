import { afterEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import {
  clampSeedanceDuration,
  createTryAllApiProvider,
  isDoubaoSeedanceModel,
} from '#/server/video/tryallapi'

const env = (vars: Record<string, string> = {}) =>
  ({
    APP_ENV: 'production',
    SITE_URL: 'https://moonhop.ai',
    SESSION_SECRET: 'a'.repeat(64),
    TRYALLAPI_API_KEY: 'sk-tryall',
    ...vars,
  }) as unknown as Env

const input = (webhookUrl = 'https://moonhop.ai/api/webhooks/tryallapi?gen=gen_1&token=t') => ({
  generationId: 'gen_1',
  durationSeconds: 12,
  imageUrl: 'https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s',
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-12s.mp4',
  sourceVideoKey: 'templates/neon-12s.mp4',
  webhookUrl,
  meta: {},
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tryallapi provider', () => {
  it('Seedance/doubao 走 v3 contents/generations/tasks，映射图+时长+比例并夹紧时长', async () => {
    expect(isDoubaoSeedanceModel(site.video.tryallapi.model)).toBe(true)
    expect(clampSeedanceDuration(2)).toBe(4)
    expect(clampSeedanceDuration(18)).toBe(15)

    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return json(200, { id: 'task_1', status: 'queued' })
    })
    const provider = createTryAllApiProvider(env())
    expect(await provider.submit(input())).toEqual({
      requestId: 'task_1',
      meta: { base: 'https://tryallapi.com', api: 'v3', duration: 12 },
    })
    expect(calls[0]!.url).toBe('https://tryallapi.com/api/v3/contents/generations/tasks')
    expect(calls[0]!.body).toMatchObject({
      model: site.video.tryallapi.model,
      resolution: site.video.tryallapi.resolution,
      ratio: site.template.aspectRatio,
      duration: 12,
      generate_audio: true,
      callback_url: input().webhookUrl,
    })
    expect(calls[0]!.body.content).toEqual([
      { type: 'text', text: site.video.tryallapi.prompt },
      {
        type: 'image_url',
        image_url: { url: input().imageUrl },
        role: 'reference_image',
      },
    ])

    await provider.submit(input('http://localhost:3000/api/webhooks/tryallapi?gen=gen_1&token=t'))
    expect(calls[1]!.body).not.toHaveProperty('callback_url')
  })

  it('status：v3 排队中 / succeeded 出片 / failed', async () => {
    const responses = [
      json(200, { status: 'running' }),
      json(200, { status: 'succeeded', content: { video_url: 'https://cdn.example/out.mp4' } }),
      json(200, { status: 'failed', error: { message: 'no channel' } }),
    ]
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).toContain('/api/v3/contents/generations/tasks/')
      return responses.shift()!
    })
    const provider = createTryAllApiProvider(env())
    expect(await provider.status('task_1', { base: 'https://tryallapi.com', api: 'v3' })).toEqual({ state: 'pending' })
    expect(await provider.status('task_1', { base: 'https://tryallapi.com', api: 'v3' })).toEqual({
      state: 'completed',
      output: { url: 'https://cdn.example/out.mp4' },
    })
    expect(await provider.status('task_1', { base: 'https://tryallapi.com', api: 'v3' })).toMatchObject({
      state: 'failed',
      code: 'tryallapi_failed',
      message: expect.stringContaining('no channel'),
    })
  })

  it('自定义 BASE_URL；缺密钥不可重试', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url).startsWith('https://custom.example/api/v3/')).toBe(true)
      return json(200, { id: 'task_x', status: 'queued' })
    })
    const provider = createTryAllApiProvider(env({ TRYALLAPI_BASE_URL: 'https://custom.example/' }))
    expect((await provider.submit(input())).requestId).toBe('task_x')
    await expect(createTryAllApiProvider(env({ TRYALLAPI_API_KEY: '' })).submit(input())).rejects.toMatchObject({
      code: 'provider_not_configured',
      retryable: false,
    })
  })

  it('提交时把 18s 夹到 15s（Seedance 上限）', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) })
      return json(200, { id: 'task_long', status: 'queued' })
    })
    const provider = createTryAllApiProvider(env())
    const result = await provider.submit({ ...input(), durationSeconds: 18 })
    expect(result.meta).toMatchObject({ api: 'v3', duration: 15 })
    expect(calls[0]!.body.duration).toBe(15)
  })
})
