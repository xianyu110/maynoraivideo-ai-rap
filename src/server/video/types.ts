export interface VideoSubmitInput {
  generationId: string
  durationSeconds: number
  imageUrl: string
  sourceVideoUrl: string
  sourceVideoKey: string
  webhookUrl: string
  meta: Record<string, unknown>
}

export interface VideoSubmitResult {
  requestId: string
  meta: Record<string, unknown>
}

export type VideoStatus =
  | { state: 'pending' }
  // costCents：服务商返回了已结算的实际费用时带上，否则用 costCents() 估算
  | { state: 'completed'; output: { url: string } | { r2Key: string }; costCents?: number }
  | { state: 'failed'; code: string; message: string; retryable?: boolean }

export interface VideoProvider {
  id: 'yir' | 'tryallapi' | 'mock'
  submit(input: VideoSubmitInput): Promise<VideoSubmitResult>
  status(requestId: string, meta: Record<string, unknown>): Promise<VideoStatus>
  // 出一条成片的估算成本（美分），出片后写入 generations.provider_cost_cents
  costCents(durationSeconds: number): number
}

// 可重试错误（网络/限流/5xx）：队列会重投；不可重试错误直接失败并退积分
export class VideoProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
