// 可选 secret：没写进 .dev.vars 时 `npm run cf:types` 不会生成它们，这里补上类型
interface Env {
  TURNSTILE_SECRET_KEY?: string
  OPENAI_API_KEY?: string
  YIR_API_KEY?: string
  PAYMENT_NOTIFY_WEBHOOK_URL?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  TRYALLAPI_API_KEY?: string
  TRYALLAPI_BASE_URL?: string
  /** Optional; on primary submit failure before accept, retry once with this provider (e.g. tryallapi). */
  VIDEO_FALLBACK_PROVIDER?: string
}
