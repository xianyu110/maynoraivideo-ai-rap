-- 后台运营参数（src/server/settings.ts）：只存非敏感参数，密钥仍放 wrangler secrets。
-- 每个参数一行，value 是 JSON；没有行时用 site.ts 的默认值
CREATE TABLE arv_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 全站每日生成上限按 created_at 统计当天的任务数
CREATE INDEX arv_idx_generations_created ON arv_generations(created_at);
