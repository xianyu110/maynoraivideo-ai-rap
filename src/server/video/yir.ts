// yir.ai 网关（可选的第二个视频服务商，VIDEO_PROVIDER=yir）：https://yir.ai/docs
// 照片 + 模板源视频按 reference 模式提交（Kling Motion Control），两者都给公开 HTTPS 地址，yir 提交时各下载一次。
// Idempotency-Key 用生成任务 id：队列重投或 Worker 中断后重新提交会拿回同一个 Job，不会重复计费。
// yir 按请求体识别同一请求，所以请求体必须每次一致（jobs.ts 里图片签名按任务创建时间算）。
// webhook 只当“该去查一下了”的信号，结果始终用 API key 重新拉取。
// 提交带 Yir-Referral: ctc47abk（伙伴未开通时网关静默忽略）；邀请链接 https://yir.ai/?ref=ctc47abk
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const GATEWAY = 'https://gateway.yir.ai/v1'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

interface YirError {
  code?: string
  message?: string
  retryable?: boolean
  action?: string
  provider_error?: { message?: string }
}

interface YirJob {
  id?: string
  status?: string
  error?: YirError | null
  result?: { availability?: string; files?: Array<{ url?: string; media_type?: string }> }
  billing?: { status?: string; total_charged_by_yir?: string }
}

export function createYirProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.YIR_API_KEY)
  const headers = (extra: Record<string, string> = {}) => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'YIR_API_KEY missing', false)
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra }
  }

  async function getJob(path: string) {
    const response = await fetch(`${GATEWAY}${path}`, { headers: headers() })
    const body = (await response.json().catch(() => null)) as YirJob | null
    if (!response.ok || !body) throw requestError('status', response, body)
    return body
  }

  return {
    id: 'yir',
    async submit(input) {
      const { model, prompt, resolution, routingOnly } = site.video.yir
      const body: Record<string, unknown> = {
        model,
        input: {
          type: 'reference',
          prompt,
          references: [
            { role: 'reference_image', url: input.imageUrl },
            { role: 'reference_video', url: input.sourceVideoUrl },
          ],
        },
        parameters: { duration: input.durationSeconds, resolution, aspect_ratio: 'auto', generate_audio: false, n: 1 },
      }
      if (routingOnly?.length) body.routing = { only: routingOnly }
      // yir 只投递 443 端口的 HTTPS 地址；本地 http 开发环境不带，靠轮询
      if (input.webhookUrl.startsWith('https://')) body.webhook_url = input.webhookUrl
      const response = await fetch(`${GATEWAY}/videos/generations`, {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': input.generationId, 'Yir-Referral': 'ctc47abk' }),
        body: JSON.stringify(body),
      })
      const job = (await response.json().catch(() => null)) as YirJob | null
      if (!response.ok || !job?.id) throw requestError('submit', response, job)
      return { requestId: job.id, meta: {} }
    },

    async status(requestId): Promise<VideoStatus> {
      const id = encodeURIComponent(requestId)
      const summary = await getJob(`/jobs/${id}/status?wait=0`)
      if (!summary.status || !TERMINAL.has(summary.status)) return { state: 'pending' }
      if (summary.status === 'cancelled') return { state: 'failed', code: 'yir_cancelled', message: 'yir job cancelled' }
      if (summary.status === 'failed') {
        const error = summary.error
        return { state: 'failed', code: error?.code ?? 'yir_failed', message: describe(error), retryable: error?.retryable }
      }
      // 成功：完整 Job 里才有结果文件和账单
      const job = await getJob(`/jobs/${id}`)
      const video = job.result?.availability === 'available'
        ? job.result.files?.find((file) => file.url && file.media_type?.startsWith('video/'))
        : undefined
      if (!video?.url) {
        return { state: 'failed', code: 'yir_no_video', message: `yir result unavailable (${job.result?.availability ?? 'missing'})` }
      }
      return { state: 'completed', output: { url: video.url }, costCents: settledCents(job) }
    },

    costCents: yirCostCents,
  }
}

// 估算：Motion Control 按参考视频实测秒数计费，参考视频就是模板源视频，时长固定
export function yirCostCents(durationSeconds: number) {
  return Math.round(durationSeconds * site.video.yir.costCentsPerSecond)
}

// 账单已结算才是最终金额；还在对账（pending）时返回 undefined，由 costCents() 估算
function settledCents(job: YirJob) {
  if (job.billing?.status !== 'settled') return undefined
  const usd = Number(job.billing.total_charged_by_yir)
  // 金额是 USD 小数字符串（最多 6 位小数）；先截到 6 位再取整，避免 0.845 * 100 = 84.4999… 少记 1 美分
  return Number.isFinite(usd) ? Math.round(Number((usd * 100).toFixed(6))) : undefined
}

function describe(error: YirError | null | undefined) {
  const provider = error?.provider_error?.message
  const message = `${error?.message ?? 'yir job failed'}${provider ? ` (provider: ${provider})` : ''}`
  return error?.action ? `${message} [${error.action}]`.slice(0, 500) : message.slice(0, 500)
}

// HTTP 错误体是 { error: { code, message, retryable, action } }，按 yir 给的 retryable 决定重投还是退积分
function requestError(stage: 'submit' | 'status', response: Response, body: { error?: YirError | null } | null) {
  const error = body?.error
  return new VideoProviderError(
    error?.code ?? `yir_${stage}_${response.status}`,
    `yir ${stage} failed (HTTP ${response.status}): ${describe(error)}`,
    error?.retryable ?? (response.status === 408 || response.status === 429 || response.status >= 500),
  )
}
