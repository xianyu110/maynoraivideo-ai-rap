-- 交易邮件发件箱：同一事件（dedupe_key）只发一次；发送失败按退避重试，由 Cron 补发
CREATE TABLE arv_email_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE, -- 例如 generation_succeeded:<gen id>
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  user_id TEXT, -- 收件人是本站用户时填写，注销时据此删除
  locale TEXT NOT NULL DEFAULT 'en',
  params TEXT NOT NULL DEFAULT '{}', -- 渲染模板所需数据（JSON），发送时再渲染
  subject TEXT, -- 发送时写入，便于后台查看
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, -- 也是发送租约：发送中途 Worker 退出，到期后 Cron 重试
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX arv_idx_email_outbox_due ON arv_email_outbox(status, next_attempt_at);
CREATE INDEX arv_idx_email_outbox_user ON arv_email_outbox(user_id);
CREATE INDEX arv_idx_email_outbox_created ON arv_email_outbox(created_at);

-- 举报人提交时的界面语言（回执与处理结果邮件用）
ALTER TABLE arv_takedown_requests ADD COLUMN locale TEXT;
-- 已提醒管理员的阶段：0 未提醒，1 即将超时，2 已超时
ALTER TABLE arv_takedown_requests ADD COLUMN reminder_stage INTEGER NOT NULL DEFAULT 0;
