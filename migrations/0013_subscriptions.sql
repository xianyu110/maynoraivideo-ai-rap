-- 订阅：每次扣款（首付和续费）各是一张订单，入账、退款、报表、邀请奖励沿用订单逻辑；这里记订阅本身的状态。
-- 年付按月发积分：next_grant_at 到了由 Cron 给当期订单补发一个月，arv_orders.credits 累加为“这张订单已发放的积分”
CREATE TABLE arv_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id),
  provider TEXT NOT NULL, -- waffo | dodo | mock
  provider_subscription_id TEXT NOT NULL, -- Dodo subscription_id；Waffo 订阅订单号 ORD_
  provider_customer_id TEXT, -- Dodo customer_id（客户门户用）
  plan_id TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  credits_per_month INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL, -- 订阅时锁定的每期价格，续费按它核对（之后改 site.ts 不影响老订阅）
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'expired')),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT,
  current_period_end TEXT,
  current_order_id TEXT, -- 当期扣款对应的订单
  grants_done INTEGER NOT NULL DEFAULT 0, -- 当期已发放的月数（月付恒为 1）
  next_grant_at TEXT, -- 年付下次补发时间；NULL = 当期已发完
  state_at TEXT, -- 最近一次应用的状态事件时间，更早的事件不再覆盖
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX arv_idx_subscriptions_user ON arv_subscriptions(user_id, status);
CREATE INDEX arv_idx_subscriptions_grant ON arv_subscriptions(next_grant_at) WHERE next_grant_at IS NOT NULL;

ALTER TABLE arv_orders ADD COLUMN subscription_id TEXT;
CREATE INDEX arv_idx_orders_subscription ON arv_orders(subscription_id, created_at);
