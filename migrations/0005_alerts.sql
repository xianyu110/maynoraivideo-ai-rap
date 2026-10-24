-- 健康检查每 5 分钟统计一次处理失败的支付回调
CREATE INDEX arv_idx_payment_events_status ON arv_payment_events(status, created_at);
