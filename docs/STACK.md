# ShrimpReel stack (quick reference)

English notes for forking / uploading to your own GitHub. Full detail: [README.md](../README.md), [env.md](env.md), [payments.md](payments.md).

## Runtime

| Layer | Choice |
| --- | --- |
| Host | Cloudflare Workers (+ Vite / TanStack Start SSR) |
| DB / files / queue | D1 + R2 + KV + Queues + Cron |
| UI | React 19 + Tailwind 4, locales `en` (default) / `zh` |
| Auth | Google OAuth (+ One Tap); credits ledger in D1 |
| Payments | `PAYMENT_PROVIDER`: `stripe` (ShipAny-style Checkout+credits), `waffo`, `dodo`, or `mock` (local) |
| Video | `VIDEO_PROVIDER`: `tryallapi` (https://tryallapi.com, default) or `mock` (local/e2e only) |

## Generation flow

1. User uploads a photo → R2 `uploads/` (optional OpenAI moderation).
2. User spends credits → row in `generations` → Queue message.
3. Worker submits to the active video provider with signed photo URL + template MP4 URL.
4. Provider webhook (or poll) → download result into R2 `outputs/` → email user; failures refund credits.

TryAllAPI path: `POST {TRYALLAPI_BASE_URL}/v1/video/generations` then poll `/v1/video/generations/{task_id}` (fallback `/v1/video/tasks/{id}`). Model/prompt in `site.video.tryallapi`.

## Required env (production sketch)

```bash
PAYMENT_PROVIDER=stripe
STRIPE_ENVIRONMENT=live
STRIPE_PRODUCTS={"starter":"price_xxx","party":"price_yyy","squad":"price_zzz","monthly":"price_aaa","yearly":"price_bbb"}
# secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SESSION_SECRET, GOOGLE_CLIENT_SECRET

VIDEO_PROVIDER=tryallapi
# secrets: TRYALLAPI_API_KEY
# optional: TRYALLAPI_BASE_URL=https://tryallapi.com
```

Local defaults stay `mock` / `mock` so `npm run seed:local && npm run dev` works offline.

## Deploy

Cloudflare only (not Vercel): create D1/R2/KV/Queues → `npm run db:migrate:remote` → `node scripts/sync-secrets.mjs --apply` → `npm run deploy`. See README “Deploying to Cloudflare”.
