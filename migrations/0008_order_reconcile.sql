-- 主动对账：成功页和定时任务最近一次向支付商查单的时间，用于节流和退避
ALTER TABLE arv_orders ADD COLUMN last_reconciled_at TEXT;
