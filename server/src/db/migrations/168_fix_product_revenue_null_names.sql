-- Migration: Fix product_revenue view to handle NULL product names
-- Previously, the view filtered out records where product_name IS NULL,
-- which caused "No product data yet" to display when product names weren't captured.
-- This fix uses COALESCE to provide a fallback name.

DROP VIEW IF EXISTS product_revenue;

-- Recreate product_revenue view with fallback for NULL product names
CREATE VIEW product_revenue AS
SELECT
  COALESCE(re.product_name, 'Unlabeled Product') AS product_name,
  re.product_id,
  COUNT(DISTINCT re.workos_organization_id) AS customer_count,
  SUM(re.amount_paid) / 100.0 AS total_revenue,
  AVG(re.amount_paid) / 100.0 AS avg_revenue_per_customer,
  MIN(re.paid_at) AS first_sale,
  MAX(re.paid_at) AS last_sale
FROM revenue_events re
WHERE re.paid_at IS NOT NULL
  AND re.amount_paid > 0
GROUP BY COALESCE(re.product_name, 'Unlabeled Product'), re.product_id
ORDER BY total_revenue DESC;

COMMENT ON VIEW product_revenue IS 'Revenue breakdown by product/SKU, aggregated from revenue_events. Uses "Unlabeled Product" for records without product names.';
