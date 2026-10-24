-- 部分退款、实收金额、来源归因、访问统计
-- 金额字段都是最小货币单位（USD 分、JPY 円）

-- 实收金额（支付商回传，含税/汇率后的真实扣款），与展示价 amount_cents 区分
ALTER TABLE arv_orders ADD COLUMN paid_amount_cents INTEGER;
-- 部分退款：status 仍为 paid，累计退款金额与已回收积分记在这里；全额退款后 status = refunded
ALTER TABLE arv_orders ADD COLUMN refunded_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE arv_orders ADD COLUMN refunded_credits INTEGER NOT NULL DEFAULT 0;
-- 下单时的来源（最近一次非 direct 触点，没有则首次触点）
ALTER TABLE arv_orders ADD COLUMN source TEXT;
ALTER TABLE arv_orders ADD COLUMN medium TEXT;
ALTER TABLE arv_orders ADD COLUMN campaign TEXT;
ALTER TABLE arv_orders ADD COLUMN country TEXT;
ALTER TABLE arv_orders ADD COLUMN device TEXT;
ALTER TABLE arv_orders ADD COLUMN attribution TEXT; -- JSON：{ first, last }，含 utm_*、click id、referrer、landing

-- 注册时的来源（首次触点）
ALTER TABLE arv_users ADD COLUMN signup_source TEXT;
ALTER TABLE arv_users ADD COLUMN signup_medium TEXT;
ALTER TABLE arv_users ADD COLUMN signup_campaign TEXT;
ALTER TABLE arv_users ADD COLUMN signup_device TEXT;
ALTER TABLE arv_users ADD COLUMN attribution TEXT;

UPDATE arv_orders SET paid_amount_cents = amount_cents WHERE status IN ('paid', 'refunded') AND paid_currency = currency;
UPDATE arv_orders SET refunded_credits = credits, refunded_amount_cents = COALESCE(paid_amount_cents, amount_cents) WHERE status = 'refunded';

CREATE INDEX arv_idx_orders_paid_at ON arv_orders(paid_at);
CREATE INDEX arv_idx_orders_source ON arv_orders(source, created_at);
CREATE INDEX arv_idx_users_created ON arv_users(created_at);

-- 每个浏览器会话首次访问计 1 次（前端 sessionStorage 去重），用于漏斗第一步
CREATE TABLE arv_visit_stats (
  day TEXT NOT NULL, -- YYYY-MM-DD（UTC）
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  country TEXT NOT NULL,
  device TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, medium, country, device)
) WITHOUT ROWID;
