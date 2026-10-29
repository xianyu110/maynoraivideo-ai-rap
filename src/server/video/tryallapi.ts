// TryAllAPI / momoAPIPro：https://tryallapi.com
// Doubao / Seedance 走豆包视频异步任务：
//   POST /api/v3/contents/generations/tasks → 轮询 GET /api/v3/contents/generations/tasks/{id}
// 其它模型仍走 NewAPI 风格：POST/GET /v1/video/generations（status 会回退 /v1/video/tasks/{id}）
// ShrimpReel 是「用户照片 + 模板动作」成片：默认把照片作 reference_image，模板源视频按配置透传。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const DEFAULT_BASE = 'https://tryallapi.com'
const V3_TASKS_PATH = '/api/v3/contents/generations/tasks'
/** Seedance 2.0 / 2.5 family typically accepts 4–15s */
const SEEDANCE_MIN_SECONDS = 4
const SEEDANCE_MAX_SECONDS = 15

interface TryAllTask {
  id?: string
  task_id?: string
  status?: string
  progress?: number
  video_url?: string
  url?: string
  output?: { url?: string; video_url?: string } | string | string[]
  content?: { video_url?: string; last_frame_url?: string }
  data?: {
    id?: string
    task_id?: string
    status?: string
    output?: string | string[]
    video_url?: string
    url?: string
    content?: { video_url?: string }
    error?: { message?: string; code?: string } | string
  }
  error?: { message?: string; code?: string } | string
  fail_reason?: string
  message?: string
  msg?: string
}

export function tryallapiBaseUrl(env: Env) {
  const configured = cleanSecret(env.TRYALLAPI_BASE_URL)
  return (configured ?? DEFAULT_BASE).replace(/\/+$/, '')
}

/** Doubao Seedance (and related) models must use the v3 contents/generations/tasks API. */
export function isDoubaoSeedanceModel(model: string) {
  const value = model.toLowerCase()
  return value.includes('seedance') || value.includes('doubao')
}

export function clampSeedanceDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return SEEDANCE_MIN_SECONDS
  return Math.max(SEEDANCE_MIN_SECONDS, Math.min(SEEDANCE_MAX_SECONDS, Math.round(seconds)))
}

export function createTryAllApiProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.TRYALLAPI_API_KEY)
  const base = tryallapiBaseUrl(env)
  const headers = () => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'TRYALLAPI_API_KEY missing', false)
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    }
  }

  return {
    id: 'tryallapi',
    async submit(input) {
      const cfg = site.video.tryallapi
      if (isDoubaoSeedanceModel(cfg.model)) {
        return submitSeedanceV3(base, headers(), input, cfg)
      }
      return submitLegacyV1(base, headers(), input, cfg)
    },

    async status(requestId, meta): Promise<VideoStatus> {
      const root = String(meta.base ?? base).replace(/\/+$/, '')
      const api = String(meta.api ?? (isDoubaoSeedanceModel(site.video.tryallapi.model) ? 'v3' : 'v1'))
      const task = api === 'v3' ? await fetchV3Task(root, requestId, headers()) : await fetchLegacyTask(root, requestId, headers())
      const state = normalizeStatus(task.status)
      if (state === 'pending') return { state: 'pending' }
      if (state === 'failed') {
        return { state: 'failed', code: 'tryallapi_failed', message: describeError(task).slice(0, 500) }
      }
      const url = extractVideoUrl(task)
      if (!url) return { state: 'failed', code: 'tryallapi_no_video', message: 'tryallapi result has no video url' }
      return { state: 'completed', output: { url } }
    },

    costCents: tryallapiCostCents,
  }
}

export function tryallapiCostCents(durationSeconds: number) {
  return Math.round(durationSeconds * site.video.tryallapi.costCentsPerSecond)
}

async function submitSeedanceV3(
  base: string,
  headers: Record<string, string>,
  input: {
    generationId: string
    durationSeconds: number
    imageUrl: string
    sourceVideoUrl: string
    webhookUrl: string
  },
  cfg: (typeof site)['video']['tryallapi'],
) {
  const duration = clampSeedanceDuration(input.durationSeconds)
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: cfg.prompt }]

  if (cfg.passSourceVideo && input.sourceVideoUrl) {
    content.push({
      type: 'video_url',
      video_url: { url: input.sourceVideoUrl },
      role: 'reference_video',
    })
  }

  content.push({
    type: 'image_url',
    image_url: { url: input.imageUrl },
    role: 'reference_image',
  })

  const body: Record<string, unknown> = {
    model: cfg.model,
    content,
    resolution: cfg.resolution,
    ratio: site.template.aspectRatio,
    duration,
    generate_audio: true,
    ...cfg.extra,
  }

  // v3 Doubao endpoint does not document OpenAI-style webhook fields; Worker polls via queue/cron.
  if (input.webhookUrl.startsWith('https://')) {
    body.callback_url = input.webhookUrl
  }

  const response = await fetch(`${base}${V3_TASKS_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const task = (await response.json().catch(() => null)) as TryAllTask | null
  const requestId = extractTaskId(task)
  if (!response.ok || !requestId) {
    throw new VideoProviderError(
      `tryallapi_submit_${response.status}`,
      `tryallapi submit failed: ${describeError(task).slice(0, 300)}`,
      isRetryableStatus(response.status) || isCapacityError(task),
    )
  }
  return { requestId, meta: { base, api: 'v3', duration } }
}

async function submitLegacyV1(
  base: string,
  headers: Record<string, string>,
  input: {
    generationId: string
    durationSeconds: number
    imageUrl: string
    sourceVideoUrl: string
    webhookUrl: string
  },
  cfg: (typeof site)['video']['tryallapi'],
) {
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt: cfg.prompt,
    image: input.imageUrl,
    images: [input.imageUrl],
    duration: input.durationSeconds,
    seconds: String(input.durationSeconds),
    size: cfg.size,
    resolution: cfg.resolution,
    metadata: {
      source_video_url: input.sourceVideoUrl,
      generation_id: input.generationId,
      site: site.domain,
      ...cfg.extra,
    },
  }
  if (cfg.passSourceVideo) {
    body.video = input.sourceVideoUrl
    body.input_reference = input.sourceVideoUrl
  }
  if (input.webhookUrl.startsWith('https://')) {
    body.webhook_url = input.webhookUrl
    body.notify_url = input.webhookUrl
  }

  const response = await fetch(`${base}/v1/video/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const task = (await response.json().catch(() => null)) as TryAllTask | null
  const requestId = extractTaskId(task)
  if (!response.ok || !requestId) {
    throw new VideoProviderError(
      `tryallapi_submit_${response.status}`,
      `tryallapi submit failed: ${describeError(task).slice(0, 300)}`,
      isRetryableStatus(response.status),
    )
  }
  return { requestId, meta: { base, api: 'v1' } }
}

async function fetchV3Task(base: string, requestId: string, headers: Record<string, string>) {
  const response = await fetch(`${base}${V3_TASKS_PATH}/${encodeURIComponent(requestId)}`, { headers })
  const body = (await response.json().catch(() => null)) as TryAllTask | null
  if (!response.ok || !body) {
    throw new VideoProviderError(
      `tryallapi_status_${response.status}`,
      `tryallapi status failed: ${describeError(body).slice(0, 300)}`,
      isRetryableStatus(response.status),
    )
  }
  // Some gateways wrap the task under `data`
  if (body.data && typeof body.data === 'object' && !body.status && body.data.status) {
    return { ...body, ...body.data, id: body.data.id ?? body.data.task_id ?? body.id }
  }
  return body
}

async function fetchLegacyTask(base: string, requestId: string, headers: Record<string, string>) {
  const id = encodeURIComponent(requestId)
  const paths = [`/v1/video/generations/${id}`, `/v1/video/tasks/${id}`]
  let lastError: VideoProviderError | null = null
  for (const path of paths) {
    const response = await fetch(`${base}${path}`, { headers })
    const body = (await response.json().catch(() => null)) as TryAllTask | null
    if (response.status === 404) {
      lastError = new VideoProviderError('tryallapi_not_found', `tryallapi task not found at ${path}`, false)
      continue
    }
    if (!response.ok || !body) {
      throw new VideoProviderError(
        `tryallapi_status_${response.status}`,
        `tryallapi status failed: ${describeError(body).slice(0, 300)}`,
        isRetryableStatus(response.status),
      )
    }
    return body
  }
  throw lastError ?? new VideoProviderError('tryallapi_not_found', 'tryallapi task not found', false)
}

function extractTaskId(task: TryAllTask | null): string | undefined {
  if (!task) return undefined
  const fromRoot = task.task_id ?? task.id
  if (typeof fromRoot === 'string' && fromRoot) return fromRoot
  const data = task.data
  if (data) {
    const nested = data.task_id ?? data.id
    if (typeof nested === 'string' && nested) return nested
  }
  return undefined
}

function normalizeStatus(status: string | undefined): 'pending' | 'completed' | 'failed' {
  const value = (status ?? '').toLowerCase()
  if (
    !value ||
    value === 'queued' ||
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'processing' ||
    value === 'running' ||
    value === 'submitted' ||
    value === 'generating'
  ) {
    return 'pending'
  }
  if (value === 'completed' || value === 'succeeded' || value === 'success' || value === 'finished') return 'completed'
  if (value === 'failed' || value === 'fail' || value === 'error' || value === 'cancelled' || value === 'canceled' || value === 'expired') {
    return 'failed'
  }
  return 'pending'
}

function extractVideoUrl(task: TryAllTask): string | null {
  if (task.content && typeof task.content.video_url === 'string' && task.content.video_url) return task.content.video_url
  if (typeof task.video_url === 'string' && task.video_url) return task.video_url
  if (typeof task.url === 'string' && /\.(mp4|webm|mov)(\?|$)/i.test(task.url)) return task.url
  if (Array.isArray(task.output)) {
    const first = task.output.find((item) => typeof item === 'string' && item.startsWith('http'))
    if (typeof first === 'string') return first
  } else if (task.output && typeof task.output === 'object') {
    if (typeof task.output.url === 'string' && task.output.url) return task.output.url
    if (typeof task.output.video_url === 'string' && task.output.video_url) return task.output.video_url
  } else if (typeof task.output === 'string' && task.output.startsWith('http')) {
    return task.output
  }
  const data = task.data
  if (data) {
    if (data.content && typeof data.content.video_url === 'string' && data.content.video_url) return data.content.video_url
    if (typeof data.video_url === 'string' && data.video_url) return data.video_url
    if (typeof data.url === 'string' && data.url) return data.url
    if (typeof data.output === 'string' && data.output.startsWith('http')) return data.output
    if (Array.isArray(data.output)) {
      const first = data.output.find((item) => typeof item === 'string' && item.startsWith('http'))
      if (typeof first === 'string') return first
    }
  }
  return null
}

function describeError(task: TryAllTask | null) {
  if (!task) return 'empty response'
  if (typeof task.message === 'string' && task.message) return task.message
  if (typeof task.msg === 'string' && task.msg) return task.msg
  if (typeof task.error === 'string') return task.error
  if (task.error && typeof task.error === 'object' && typeof task.error.message === 'string') return task.error.message
  if (typeof task.fail_reason === 'string' && task.fail_reason) return task.fail_reason
  if (task.data && typeof task.data.error === 'string') return task.data.error
  if (task.data?.error && typeof task.data.error === 'object' && typeof task.data.error.message === 'string') {
    return task.data.error.message
  }
  return JSON.stringify(task).slice(0, 300)
}

function isCapacityError(task: TryAllTask | null) {
  const message = describeError(task).toLowerCase()
  return (
    message.includes('temporarily unavailable') ||
    message.includes('supply_unavailable') ||
    message.includes('服务暂不可用') ||
    message.includes('暂时不可用') ||
    message.includes('overloaded')
  )
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500
}
