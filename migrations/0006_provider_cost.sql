-- 视频服务商成本估算（美分），供后台算毛利；NULL = 服务商未出片（未计费）
ALTER TABLE arv_generations ADD COLUMN provider_cost_cents INTEGER;
