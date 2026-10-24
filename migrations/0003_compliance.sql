-- 合规：数据保留、举报下架、相同图片拦截

-- 到期后 R2 对象被删除，行保留（订单/积分流水仍引用它们），只记录过期时间
ALTER TABLE arv_uploads ADD COLUMN expired_at TEXT;
-- 原图 SHA-256：下架后用于拦截同一张图片再次上传
ALTER TABLE arv_uploads ADD COLUMN sha256 TEXT;
ALTER TABLE arv_generations ADD COLUMN expired_at TEXT;
-- 因举报被下架的时间（成片与原图已删除）
ALTER TABLE arv_generations ADD COLUMN removed_at TEXT;

CREATE INDEX arv_idx_uploads_created ON arv_uploads(created_at);
CREATE INDEX arv_idx_uploads_sha256 ON arv_uploads(sha256);
CREATE INDEX arv_idx_generations_completed ON arv_generations(completed_at);
CREATE INDEX arv_idx_generations_upload ON arv_generations(upload_id);

CREATE TABLE arv_takedown_requests (
  id TEXT PRIMARY KEY,
  reporter_name TEXT NOT NULL, -- 电子签名
  reporter_email TEXT NOT NULL,
  reporter_user_id TEXT,
  content_ref TEXT NOT NULL, -- 链接、视频 ID 或描述
  generation_id TEXT, -- 能从 content_ref 解析出本站视频 ID 时填写
  reason TEXT NOT NULL CHECK (reason IN ('intimate', 'impersonation', 'minor', 'copyright', 'other')),
  details TEXT,
  is_depicted INTEGER NOT NULL DEFAULT 0, -- 举报人是画面中的人或其授权代表
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'removed', 'rejected')),
  due_at TEXT NOT NULL, -- 创建后 48 小时
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX arv_idx_takedown_status ON arv_takedown_requests(status, due_at);

-- 已下架内容的原图哈希：再次上传直接拒绝
CREATE TABLE arv_blocked_media (
  sha256 TEXT PRIMARY KEY,
  takedown_id TEXT,
  created_at TEXT NOT NULL
);
