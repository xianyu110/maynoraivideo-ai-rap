-- 积分批次：每次入账是一个批次，扣费按“先到期先扣”分配到批次上，Cron 把到期批次的剩余积分作废。
-- arv_users.credits 是所有批次 remaining 之和的缓存（到期但还没被 Cron 作废的也算在内），每次变动后按批次重算。
CREATE TABLE arv_credit_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  source TEXT NOT NULL, -- legacy | signup_bonus | purchase | admin_adjust | generation_refund
  ref_id TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  expires_at TEXT, -- NULL = 永不过期
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_grants_user ON arv_credit_grants(user_id, expires_at);
CREATE INDEX arv_idx_grants_expiring ON arv_credit_grants(expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;

-- 扣减明细：一笔扣费（按流水的 idempotency_key）从哪些批次各扣了多少。生成失败按明细原路退回
CREATE TABLE arv_credit_allocations (
  ledger_key TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES arv_credit_grants(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (ledger_key, grant_id)
);
CREATE INDEX arv_idx_allocations_grant ON arv_credit_allocations(grant_id);

-- 断言用的空表：扣费时插入“分配数量是否等于应扣数量”，不等就违反 CHECK，整个 batch 回滚；同一 batch 里随即删除
CREATE TABLE arv_credit_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- 现有余额转成一个永不过期的批次
INSERT INTO arv_credit_grants (id, user_id, source, ref_id, amount, remaining, expires_at, created_at)
SELECT 'grt_legacy_' || id, id, 'legacy', NULL, credits, credits, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM arv_users WHERE credits > 0;
