// 上新词时主要改这个文件：关键词、品牌、模板视频、时长档位、积分包、文章 slug。
// 文案在 src/content/<locale>.ts，通过 {keyword} 等变量自动套用。

export const LOCALES = ['en', 'zh'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

// 每种语言的 BCP 47 标签（<html lang>、日期格式、Turnstile）、og:locale 和切换器里显示的自称。
// 加语言时在这里补一行，并在 src/lib/i18n.ts 的 loaders 里登记文案文件
export const LOCALE_META: Record<Locale, { tag: string; ogLocale: string; name: string }> = {
  en: { tag: 'en', ogLocale: 'en_US', name: 'English' },
  zh: { tag: 'zh-CN', ogLocale: 'zh_CN', name: '简体中文' },
}

export const site = {
  keyword: 'AI Rap Video',
  brandName: 'AI Rap Video',
  logoMark: 'AR',
  domain: 'ai-rap-video.asia',
  supportEmail: 'bgnwd15@gmail.com',
  // 社媒平台名称（用于 “Viral on TikTok” 之类标签）
  trendPlatform: 'TikTok',
  ogImage: '/og.png',

  // 生成模板：provider 输出时长 = 源视频时长，所以每个时长档位各有一段剪好的源视频。
  // 源视频上传到 R2 的 templates/<文件名>，由 /media/templates/<文件名> 公开提供给 provider 拉取。
  template: {
    id: 'ai-rap-video-v1',
    aspectRatio: '9:16',
    fullSeconds: 18,
  },

  // 首页展示素材（public/demo/）。换成真实素材时必须拥有授权，credit 写原作者，例如 '@handle · TikTok'。
  examples: {
    original: { video: '/demo/original.mp4', poster: '/demo/original.jpg', credit: 'Demo · AI Rap Video template' },
    aiVersions: [
      { video: '/demo/ai1.mp4', poster: '/demo/ai1.jpg', credit: 'Demo · AI rap lip-sync' },
      { video: '/demo/ai2.mp4', poster: '/demo/ai2.jpg', credit: 'Demo · AI rap lip-sync' },
    ],
    madeWith: { photo: '/demo/sample-photo.jpg', video: '/demo/madeWith.mp4', poster: '/demo/madeWith.jpg' },
    // “创意”区块：每条 = 一张示例照片 + 一段成片
    ideas: [
      { photo: '/demo/sample-photo.jpg', video: '/demo/ai1.mp4', poster: '/demo/ai1.jpg' },
      { photo: '/demo/sample-photo.jpg', video: '/demo/ai2.mp4', poster: '/demo/ai2.jpg' },
      { photo: '/demo/sample-photo.jpg', video: '/demo/madeWith.mp4', poster: '/demo/madeWith.jpg' },
    ],
  },

  // 视频模型，服务商由 VIDEO_PROVIDER 选择（tryallapi 默认；mock 仅本地/e2e）。换模型时同时检查 src/server/video/ 下对应文件的入参与出参。
  video: {
    // TryAllAPI（默认，VIDEO_PROVIDER=tryallapi）：聚合站模型名以控制台「模型广场」为准，例如 aigc-video-hailuo / sora-2
    tryallapi: {
      model: 'aigc-video-hailuo',
      prompt:
        'The person in the reference image lip-syncs and performs the exact rap moves from the viral AI rap video template. Keep their face, hair, body shape and outfit identical. Clear mouth motion, smooth motion, vertical 9:16.',
      resolution: '720p',
      size: '720x1280',
      // 估算成本（美分/秒），只用于后台毛利；实际以 TryAllAPI 账单为准
      costCentsPerSecond: 8,
      // true：额外把模板源视频 URL 放进 video / input_reference（仅当所选模型支持参考视频时打开）
      passSourceVideo: false,
      // 透传到 metadata 的额外字段（模型专属参数）
      extra: {} as Record<string, unknown>,
    },
  },

  durations: [
    { id: 'short', seconds: 6, credits: 6, source: 'ai-rap-video-v1-6s.mp4' },
    { id: 'medium', seconds: 12, credits: 12, source: 'ai-rap-video-v1-12s.mp4' },
    { id: 'full', seconds: 18, credits: 18, source: 'ai-rap-video-v1-18s.mp4', isFull: true },
  ],

  // 积分包：一次性购买，买的积分永不过期（赠送积分可以设有效期，扣费时先扣快到期的）。价格用于展示与订单记录，实际收费以支付商后台为准。
  // 可选 anchorPriceCents：划线原价，价格卡显示原价和“Save X%”。只能填这个套餐真实卖过的价格
  // （欧盟要求以降价前 30 天内的最低价为准），不能编一个从没卖过的高价；没有就不填
  packages: [
    { id: 'starter', credits: 500, priceCents: 888, currency: 'USD' }, // Single · From $8.88 · one 720p
    { id: 'party', credits: 1500, priceCents: 1699, currency: 'USD', highlight: true }, // Popular
    { id: 'squad', credits: 5000, priceCents: 2990, currency: 'USD' }, // Creator
  ],

  // 订阅：按月或按年自动续费，每月发 credits 积分，当期结束时作废（不累积）；年付一次收一年的钱，积分按月发放。
  // 价格同样以支付商后台为准（dodo-setup / waffo-setup 按这里建订阅商品）。改价只影响新订阅，老订阅按订阅时的价格续费。
  // 开关 subscriptionsEnabled：false 时不再卖新订阅（定价页、条款、退款政策和 FAQ 里的订阅内容一起隐藏，下单接口拒绝套餐），
  // 已有订阅照常续费、退款，账单页仍能取消和进门户；这时要保留 *_PRODUCTS 里套餐的商品，支付商 webhook 也别退订订阅事件。
  // 使用手册见 docs/subscriptions.md
  subscriptionsEnabled: false as boolean,
  plans: [
    { id: 'monthly', interval: 'month', credits: 60, priceCents: 1490, currency: 'USD' },
    { id: 'yearly', interval: 'year', credits: 60, priceCents: 14900, currency: 'USD', highlight: true },
  ] as readonly SubscriptionPlan[],

  signupBonusCredits: 0,
  // 注册赠送积分的有效期（天），0 = 永不过期
  signupBonusValidDays: 0 as number,

  // 邀请奖励：被邀请人第一笔付款入账后给邀请人发的积分，0 = 关闭（不显示邀请卡片，/i/ 链接不再绑定）
  referralRewardCredits: 10 as number,
  // 同一邀请人在同一 IP（IPv6 按 /64）下最多绑定几个新账号，超出的不发奖励
  referralMaxPerIp: 3,
  // 每个邀请人 30 天内最多获得几次奖励
  referralMonthlyCap: 20,

  upload: {
    maxBytes: 10 * 1024 * 1024,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },

  // 数据保留（天）：Cron 到期删除 R2 对象并标记 expired；隐私政策与个人中心按这里的值展示。
  // 另在 R2 配同前缀的生命周期规则兜底（README「数据保留」）。0 = 不自动删除。
  retention: {
    uploadDays: 7,
    outputDays: 30,
  },

  // 举报下架的处理时限（小时），TAKE IT DOWN Act 要求 48 小时内删除
  takedownSlaHours: 48,

  // 成片公开分享（/v/<随机串>）：用户在个人中心主动开启，页面 noindex，带 AI 标识和举报入口；
  // 成片到期、下架、删除或停止分享后链接失效。换脸、真人类站点风险高时设为 false（按钮和页面都不出现）
  share: {
    enabled: true,
  },

  // SEO 文章（指南），按展示顺序排列。slug 是根路径：/<slug> 与 /zh/<slug>；正文在 src/content/<locale>.ts 的 articles[key]。
  // 新增文章：这里加一项，各语言 content 的 articles 补同名 key（缺了 typecheck 会报错）。
  // trend、howTo 两篇被首页直接链接，不要删。related 不填时推荐其余文章里最近更新的。
  // 日期写进 Article 的 datePublished/dateModified、页面上的“最后更新”和 sitemap lastmod，改正文时同步改 updatedAt
  articles: [
    { key: 'trend', slug: 'ai-rap-video-ai-trend', publishedAt: '2026-10-24', updatedAt: '2026-10-24' },
    { key: 'howTo', slug: 'how-to-make-ai-rap-video', publishedAt: '2026-10-24', updatedAt: '2026-10-24' },
  ],

  seo: {
    // 长尾词：不输出 meta keywords（Google 不用），由 npm run seo:check 检查首页正文是否覆盖
    secondaryKeywords: ['AI Rap Video AI', 'AI Rap Video video', 'AI Rap Video trend', 'AI rap video', 'lip-sync rap', 'AI dance video', 'From $8.88'],
    // 首次上线日期与站点页面（首页、价格、法律页等）最近一次内容更新日期：首页视频 uploadDate、sitemap lastmod。文章用各自的日期
    publishedAt: '2026-10-24',
    updatedAt: '2026-10-24',
    // Search Console / Bing Webmaster 选“HTML 标记”验证时填 content 值；用 DNS 验证则留空
    googleVerification: '',
    bingVerification: '',
    // IndexNow key（8–128 位字母数字）：填了才会公开 /<key>.txt，配合 npm run seo:indexnow 推送
    indexNowKey: '',
    // 品牌社媒主页，写进 Organization.sameAs
    sameAs: [] as string[],
    ogImageSize: { width: 1200, height: 630 },
  },

  // 统计：推荐只填 cfBeaconToken（Cloudflare Web Analytics，不写 Cookie，不需要同意横幅）。
  // 填了 ga4Id 才启用 GA4：同时出现同意横幅和页脚“Cookie 设置”，访客接受前不加载 gtag.js（Consent Mode v2 basic 模式，见 lib/consent.ts）。
  // 隐私政策的“Cookie 与统计”一节按这两项自动调整
  analytics: {
    ga4Id: '',
    cfBeaconToken: '',
  },
} as const

export type DurationOption = (typeof site.durations)[number]
export type CreditPackage = (typeof site.packages)[number]

export interface SubscriptionPlan {
  id: string
  interval: 'month' | 'year'
  credits: number // 每月发放的积分
  priceCents: number // 每期价格（年付为一年的价格）
  currency: string
  highlight?: boolean
}

export function findDuration(id: string) {
  return site.durations.find((d) => d.id === id)
}

export function findPackage(id: string) {
  return site.packages.find((p) => p.id === id)
}

// 在售的订阅套餐：开关关掉时为空。处理已有订阅（续费、退款、账单页）用 findPlan，不受开关影响
export const sellingPlans: readonly SubscriptionPlan[] = site.subscriptionsEnabled ? site.plans : []

export function findPlan(id: string) {
  return site.plans.find((p) => p.id === id)
}

// 套餐填了高于售价的 anchorPriceCents 才返回划线原价和折扣百分比，否则不显示
export function anchorPrice(pack: CreditPackage): { cents: number; percentOff: number } | null {
  const anchor = 'anchorPriceCents' in pack ? pack.anchorPriceCents : undefined
  if (typeof anchor !== 'number' || anchor <= pack.priceCents) return null
  return { cents: anchor, percentOff: Math.round((1 - pack.priceCents / anchor) * 100) }
}

export type ArticleKey = (typeof site.articles)[number]['key']
export interface Article {
  key: ArticleKey
  slug: string
  publishedAt: string
  updatedAt: string
  related?: readonly ArticleKey[]
}
export const ARTICLES: readonly Article[] = site.articles

export function findArticle(slug: string) {
  return ARTICLES.find((a) => a.slug === slug)
}

export function articlePath(key: ArticleKey) {
  const article = ARTICLES.find((a) => a.key === key)
  if (!article) throw new Error(`Unknown article: ${key}`)
  return `/${article.slug}`
}

export function relatedArticles(article: Article, limit = 3): Article[] {
  if (article.related) return article.related.flatMap((key) => ARTICLES.filter((a) => a.key === key)).slice(0, limit)
  return ARTICLES.filter((a) => a.key !== article.key)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value)
}

export function localePath(locale: Locale, path: string) {
  const clean = path.startsWith('/') ? path : `/${path}`
  if (locale === DEFAULT_LOCALE) return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

export function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
