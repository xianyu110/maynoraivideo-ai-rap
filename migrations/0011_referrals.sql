-- 邀请奖励：每个用户一个邀请码（第一次打开邀请卡片时生成）；被邀请人注册时绑定邀请人，首单付款后给邀请人发积分，
-- 这笔订单退款时回收。状态：pending 等待首单；rewarded 已发；reversed 已回收；rejected 不发（同 IP 超限、邀请人不可用、达到 30 天上限）
ALTER TABLE arv_users ADD COLUMN referral_code TEXT;
CREATE UNIQUE INDEX arv_idx_users_referral_code ON arv_users(referral_code);

CREATE TABLE arv_referrals (
  invitee_id TEXT PRIMARY KEY REFERENCES arv_users(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL REFERENCES arv_users(id) ON DELETE CASCADE,
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  reward_order_id TEXT UNIQUE,
  reward_credits INTEGER,
  rewarded_at TEXT,
  reversed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_referrals_inviter ON arv_referrals(inviter_id, created_at);
CREATE INDEX arv_idx_referrals_inviter_ip ON arv_referrals(inviter_id, ip_hash);
