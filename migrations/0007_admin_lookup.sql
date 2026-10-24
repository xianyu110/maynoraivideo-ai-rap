-- 后台订单详情时间线、用户详情审计记录的按对象查询
CREATE INDEX arv_idx_payment_events_order ON arv_payment_events(order_id, created_at);
CREATE INDEX arv_idx_admin_audit_target ON arv_admin_audit(target_type, target_id, created_at);
CREATE INDEX arv_idx_ledger_ref ON arv_credit_ledger(ref_id);
