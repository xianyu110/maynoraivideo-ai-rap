-- 注销账号的邮箱只留加盐哈希（不可还原）：同一邮箱重新注册时不再发注册赠送、不绑定邀请人
CREATE TABLE arv_deleted_accounts (
  email_hash TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
