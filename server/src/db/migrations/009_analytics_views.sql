-- Migration: Analytics Views for BI/Reporting
-- Creates materialized views and regular views for common business metrics

-- Revenue by month view
CREATE VIEW revenue_by_month AS
SELECT
  DATE_TRUNC('month', paid_at) AS month,
  SUM(amount_paid) FILTER (WHERE amount_paid > 0) / 100.0 AS gross_revenue,
  SUM(amount_paid) FILTER (WHERE amount_paid < 0) / 100.0 AS refunds,
  SUM(amount_paid) / 100.0 AS net_revenue,
  COUNT(DISTINCT workos_organization_id) AS paying_customers,
  COUNT(*) FILTER (WHERE revenue_type IN ('subscription_initial', 'subscription_recurring')) AS subscription_payments,
  COUNT(*) FILTER (WHERE revenue_type = 'refund') AS refund_count
FROM revenue_events
WHERE paid_at IS NOT NULL
GROUP BY DATE_TRUNC('month', paid_at)
ORDER BY month DESC;

-- Customer health view
CREATE VIEW customer_health AS
SELECT
  o.workos_organization_id,
  o.name AS company_name,
  o.stripe_customer_id,
  o.created_at AS customer_since,
  o.subscription_amount / 100.0 AS mrr,
  o.subscription_interval,
  o.subscription_current_period_end,
  o.subscription_canceled_at,
  CASE
    WHEN o.subscription_canceled_at IS NOT NULL THEN 'canceled'
    WHEN o.subscription_current_period_end IS NULL THEN 'none'
    WHEN o.subscription_current_period_end < NOW() THEN 'expired'
    WHEN o.subscription_amount IS NULL THEN 'none'
    ELSE 'active'
  END AS subscription_status,
  CASE
    WHEN o.subscription_current_period_end IS NOT NULL
      AND o.subscription_current_period_end < NOW() + INTERVAL '7 days'
      AND o.subscription_canceled_at IS NULL
    THEN TRUE
    ELSE FALSE
  END AS renewal_at_risk,
  COUNT(re.id) AS total_payments,
  SUM(CASE WHEN re.amount_paid > 0 THEN re.amount_paid ELSE 0 END) / 100.0 AS lifetime_value,
  SUM(CASE WHEN re.revenue_type = 'refund' THEN 1 ELSE 0 END) AS refund_count,
  MAX(re.paid_at) AS last_payment_date
FROM organizations o
LEFT JOIN revenue_events re ON re.workos_organization_id = o.workos_organization_id
GROUP BY o.workos_organization_id, o.name, o.stripe_customer_id, o.created_at,
         o.subscription_amount, o.subscription_interval, o.subscription_current_period_end,
         o.subscription_canceled_at;

-- Daily revenue metrics
CREATE VIEW daily_revenue AS
SELECT
  DATE(paid_at) AS date,
  SUM(amount_paid) FILTER (WHERE amount_paid > 0) / 100.0 AS gross_revenue,
  SUM(amount_paid) FILTER (WHERE amount_paid < 0) / 100.0 AS refunds,
  SUM(amount_paid) / 100.0 AS net_revenue,
  COUNT(*) AS transaction_count,
  COUNT(DISTINCT workos_organization_id) AS unique_customers
FROM revenue_events
WHERE paid_at IS NOT NULL
GROUP BY DATE(paid_at)
ORDER BY date DESC;

-- Subscription metrics summary
CREATE VIEW subscription_metrics AS
SELECT
  COUNT(*) FILTER (WHERE subscription_status = 'active') AS active_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'canceled') AS canceled_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'expired') AS expired_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'none') AS no_subscription,
  SUM(mrr) FILTER (WHERE subscription_status = 'active') AS total_mrr,
  AVG(mrr) FILTER (WHERE subscription_status = 'active') AS avg_mrr,
  SUM(lifetime_value) AS total_ltv,
  AVG(lifetime_value) FILTER (WHERE subscription_status = 'active') AS avg_ltv_active,
  COUNT(*) FILTER (WHERE renewal_at_risk = TRUE) AS renewals_at_risk_7d
FROM customer_health;

-- Product revenue breakdown
CREATE VIEW product_revenue AS
SELECT
  sli.product_name,
  sli.product_id,
  COUNT(DISTINCT sli.workos_organization_id) AS customer_count,
  SUM(sli.amount) / 100.0 AS total_revenue,
  AVG(sli.amount) / 100.0 AS avg_revenue_per_customer,
  MIN(sli.created_at) AS first_sale,
  MAX(sli.created_at) AS last_sale
FROM subscription_line_items sli
GROUP BY sli.product_name, sli.product_id
ORDER BY total_revenue DESC;

-- Cohort analysis by month
CREATE VIEW cohort_analysis AS
SELECT
  DATE_TRUNC('month', o.created_at) AS cohort_month,
  COUNT(DISTINCT o.workos_organization_id) AS cohort_size,
  COUNT(DISTINCT o.workos_organization_id) FILTER (
    WHERE o.subscription_canceled_at IS NULL
      AND o.subscription_amount IS NOT NULL
  ) AS still_active,
  COUNT(DISTINCT o.workos_organization_id) FILTER (
    WHERE o.subscription_canceled_at IS NOT NULL
  ) AS churned,
  ROUND(
    COUNT(DISTINCT o.workos_organization_id) FILTER (
      WHERE o.subscription_canceled_at IS NULL
        AND o.subscription_amount IS NOT NULL
    )::NUMERIC / NULLIF(COUNT(DISTINCT o.workos_organization_id), 0) * 100,
    2
  ) AS retention_rate
FROM organizations o
WHERE o.created_at IS NOT NULL
GROUP BY DATE_TRUNC('month', o.created_at)
ORDER BY cohort_month DESC;

-- Payment success rate
CREATE VIEW payment_success_rate AS
SELECT
  DATE_TRUNC('day', paid_at) AS date,
  COUNT(*) FILTER (WHERE revenue_type != 'payment_failed') AS successful_payments,
  COUNT(*) FILTER (WHERE revenue_type = 'payment_failed') AS failed_payments,
  COUNT(*) AS total_attempts,
  ROUND(
    COUNT(*) FILTER (WHERE revenue_type != 'payment_failed')::NUMERIC /
    NULLIF(COUNT(*), 0) * 100,
    2
  ) AS success_rate
FROM revenue_events
WHERE paid_at IS NOT NULL
GROUP BY DATE_TRUNC('day', paid_at)
ORDER BY date DESC;

-- Comments for documentation
COMMENT ON VIEW revenue_by_month IS 'Monthly revenue aggregation with gross, refunds, and net revenue';
COMMENT ON VIEW customer_health IS 'Current health status of all customers with LTV and risk indicators';
COMMENT ON VIEW daily_revenue IS 'Daily revenue metrics for trend analysis';
COMMENT ON VIEW subscription_metrics IS 'Summary metrics for subscription business (MRR, churn, etc.)';
COMMENT ON VIEW product_revenue IS 'Revenue breakdown by product/SKU';
COMMENT ON VIEW cohort_analysis IS 'Customer retention by signup cohort';
COMMENT ON VIEW payment_success_rate IS 'Payment processing success rate over time';
