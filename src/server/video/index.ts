import { ApiError, isProduction } from '../util'
import { createTryAllApiProvider } from './tryallapi'
import { createYirProvider } from './yir'
import type { VideoProvider } from './types'

// mock：本地与 e2e 用。几秒后“完成”，输出直接复制该时长档位的模板源视频。
// 生成请求带 mockOutcome（仅非生产）：'fail' 模拟失败，用于验证自动退积分；'hang' 一直处理中，直到超时、死信或管理员处理。
function createMockProvider(): VideoProvider {
  return {
    id: 'mock',
    async submit(input) {
      return {
        requestId: `mock_${input.generationId}`,
        meta: { ...input.meta, readyAt: Date.now() + 3000, sourceKey: input.sourceVideoKey },
      }
    },
    async status(_requestId, meta) {
      if (meta.mockOutcome === 'hang' || Date.now() < Number(meta.readyAt ?? 0)) return { state: 'pending' }
      if (meta.mockOutcome === 'fail') return { state: 'failed', code: 'mock_failure', message: 'Simulated provider failure' }
      return { state: 'completed', output: { r2Key: String(meta.sourceKey) } }
    },
    costCents: () => 0,
  }
}

export function activeVideoProviderId(env: Env): VideoProvider['id'] {
  if (env.VIDEO_PROVIDER === 'yir') return 'yir'
  if (env.VIDEO_PROVIDER === 'tryallapi') return 'tryallapi'
  if (env.VIDEO_PROVIDER === 'mock' && !isProduction(env)) return 'mock'
  throw new ApiError(503, 'video_not_configured', `Unsupported VIDEO_PROVIDER: ${env.VIDEO_PROVIDER}`)
}

/** Optional cross-provider fallback (env VIDEO_FALLBACK_PROVIDER). Must differ from primary. */
export function videoFallbackProviderId(env: Env, primary: string = activeVideoProviderId(env)): VideoProvider['id'] | null {
  const raw = (env.VIDEO_FALLBACK_PROVIDER ?? '').trim()
  if (!raw || raw === primary) return null
  if (raw === 'yir' || raw === 'tryallapi') return raw
  if (raw === 'mock' && !isProduction(env)) return 'mock'
  return null
}

export function getVideoProvider(env: Env, id: string = activeVideoProviderId(env)): VideoProvider {
  if (id === 'yir') return createYirProvider(env)
  if (id === 'tryallapi') return createTryAllApiProvider(env)
  if (id === 'mock' && !isProduction(env)) return createMockProvider()
  throw new ApiError(503, 'video_not_configured', `Unsupported video provider: ${id}`)
}
