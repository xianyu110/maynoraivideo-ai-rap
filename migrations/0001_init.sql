-- 用户：credits 是 credit_ledger 的缓存余额，CHECK 保证扣费不会透支（D1 batch 内违反即整体回滚）
CREATE TABLE arv_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deleted')), -- deleted = 用户注销后匿名化保留（订单/流水需留档）
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  locale TEXT,
  country TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE arv_sessions (
  id TEXT PRIMARY KEY, -- sha256(token)，cookie 里只放原始 token
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX arv_idx_sessions_user ON arv_sessions(user_id);

-- 积分流水：idempotency_key 唯一，重复入账在 batch 中失败并回滚
CREATE TABLE arv_credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL, -- signup_bonus | purchase | generation | generation_refund | order_refund | admin_adjust
  ref_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_ledger_user ON arv_credit_ledger(user_id, created_at);

CREATE TABLE arv_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id),
  provider TEXT NOT NULL, -- waffo | dodo | mock
  package_id TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded', 'failed', 'canceled')),
  provider_session_id TEXT,
  provider_order_id TEXT,
  provider_payment_id TEXT,
  paid_amount TEXT,
  paid_currency TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX arv_idx_orders_user ON arv_orders(user_id, created_at);
CREATE INDEX arv_idx_orders_status ON arv_orders(status, created_at);
CREATE INDEX arv_idx_orders_provider_payment ON arv_orders(provider, provider_payment_id);

CREATE TABLE arv_payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL, -- processed | ignored | failed
  error TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE arv_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_uploads_user ON arv_uploads(user_id, created_at);

CREATE TABLE arv_generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  duration_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  credits_cost INTEGER NOT NULL,
  upload_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  provider TEXT NOT NULL,
  provider_request_id TEXT,
  provider_meta TEXT, -- JSON：status_url / response_url 等
  output_r2_key TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX arv_idx_generations_user ON arv_generations(user_id, created_at);
CREATE INDEX arv_idx_generations_status ON arv_generations(status, updated_at);

CREATE TABLE arv_contact_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_contact_status ON arv_contact_messages(status, created_at);

-- 管理员操作审计
CREATE TABLE arv_admin_audit (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_admin_audit_created ON arv_admin_audit(created_at);
