-- 兑换码：后台批量生成（或指定一个活动码），用户在设置页兑换成积分批次。
-- 每个码可用 max_uses 次，每个用户每个码只能兑换一次；兑换在一个 batch 里完成，并发兑换不会超出次数。
CREATE TABLE arv_redeem_codes (
  code TEXT PRIMARY KEY, -- 大写字母和数字，不含分隔符
  batch_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  credit_valid_days INTEGER CHECK (credit_valid_days IS NULL OR credit_valid_days >= 1), -- 兑换后积分的有效期，NULL = 永不过期
  expires_at TEXT, -- 兑换截止时间，NULL = 不截止
  note TEXT NOT NULL,
  disabled_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_redeem_codes_batch ON arv_redeem_codes(batch_id, created_at);

CREATE TABLE arv_redeem_uses (
  code TEXT NOT NULL REFERENCES arv_redeem_codes(code),
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (code, user_id)
);
CREATE INDEX arv_idx_redeem_uses_user ON arv_redeem_uses(user_id);
