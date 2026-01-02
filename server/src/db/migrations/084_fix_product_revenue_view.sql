-- Migration: Fix product_revenue view to use revenue_events instead of subscription_line_items
-- The subscription_line_items table is only populated by webhooks, not by backfill.
-- revenue_events is populated by both, so it has actual data.

DROP VIEW IF EXISTS product_revenue;

-- Recreate product_revenue view using revenue_events table
CREATE VIEW product_revenue AS
SELECT
  re.product_name,
  re.product_id,
  COUNT(DISTINCT re.workos_organization_id) AS customer_count,
  SUM(re.amount_paid) / 100.0 AS total_revenue,
  AVG(re.amount_paid) / 100.0 AS avg_revenue_per_customer,
  MIN(re.paid_at) AS first_sale,
  MAX(re.paid_at) AS last_sale
FROM revenue_events re
WHERE re.product_name IS NOT NULL
  AND re.paid_at IS NOT NULL
  AND re.amount_paid > 0
GROUP BY re.product_name, re.product_id
ORDER BY total_revenue DESC;

COMMENT ON VIEW product_revenue IS 'Revenue breakdown by product/SKU, aggregated from revenue_events';
