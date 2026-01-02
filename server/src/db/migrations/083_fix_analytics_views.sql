-- Migration: Fix analytics views to use correct subscription_status and ARR
-- The customer_health view was computing subscription_status from subscription_current_period_end
-- which is often NULL. Instead, use the actual subscription_status column set by Stripe webhooks.
-- Simplified to use ARR only (no MRR) since all subscriptions are annual.

-- Drop dependent views first (order matters for dependencies)
DROP VIEW IF EXISTS subscription_metrics;
DROP VIEW IF EXISTS cohort_analysis;
DROP VIEW IF EXISTS customer_health;

-- Recreate customer_health view with correct subscription_status and ARR
CREATE VIEW customer_health AS
SELECT
  o.workos_organization_id,
  o.name AS company_name,
  o.stripe_customer_id,
  o.created_at AS customer_since,
  -- ARR: subscription amount in dollars (stored in cents)
  COALESCE(o.subscription_amount / 100.0, 0) AS arr,
  o.subscription_interval,
  o.subscription_current_period_end,
  o.subscription_canceled_at,
  -- Use the actual subscription_status column set by Stripe webhooks
  COALESCE(o.subscription_status, 'none') AS subscription_status,
  CASE
    WHEN o.subscription_current_period_end IS NOT NULL
      AND o.subscription_current_period_end < NOW() + INTERVAL '7 days'
      AND o.subscription_canceled_at IS NULL
      AND o.subscription_status = 'active'
    THEN TRUE
    ELSE FALSE
  END AS renewal_at_risk,
  COUNT(re.id) AS total_payments,
  SUM(CASE WHEN re.amount_paid > 0 THEN re.amount_paid ELSE 0 END) / 100.0 AS lifetime_value,
  SUM(CASE WHEN re.revenue_type = 'refund' THEN 1 ELSE 0 END) AS refund_count,
  MAX(re.paid_at) AS last_payment_date,
  MIN(re.paid_at) FILTER (WHERE re.amount_paid > 0) AS first_payment_date
FROM organizations o
LEFT JOIN revenue_events re ON re.workos_organization_id = o.workos_organization_id
GROUP BY o.workos_organization_id, o.name, o.stripe_customer_id, o.created_at,
         o.subscription_amount, o.subscription_interval, o.subscription_current_period_end,
         o.subscription_canceled_at, o.subscription_status;

-- Recreate subscription_metrics with ARR and new bookings
CREATE VIEW subscription_metrics AS
SELECT
  COUNT(*) FILTER (WHERE subscription_status = 'active') AS active_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'canceled') AS canceled_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'past_due') AS past_due_subscriptions,
  COUNT(*) FILTER (WHERE subscription_status = 'none' OR subscription_status IS NULL) AS no_subscription,
  -- ARR: Sum of subscription amounts for active customers
  COALESCE(SUM(arr) FILTER (WHERE subscription_status = 'active'), 0) AS total_arr,
  COALESCE(AVG(arr) FILTER (WHERE subscription_status = 'active'), 0) AS avg_arr,
  -- Lifetime value metrics
  COALESCE(SUM(lifetime_value), 0) AS total_ltv,
  COALESCE(AVG(lifetime_value) FILTER (WHERE subscription_status = 'active'), 0) AS avg_ltv_active,
  -- Risk metrics
  COUNT(*) FILTER (WHERE renewal_at_risk = TRUE) AS renewals_at_risk_7d,
  -- New bookings in last 30 days (customers whose first payment was in last 30 days)
  COUNT(*) FILTER (WHERE first_payment_date >= NOW() - INTERVAL '30 days') AS new_bookings_30d,
  -- New bookings this month
  COUNT(*) FILTER (WHERE DATE_TRUNC('month', first_payment_date) = DATE_TRUNC('month', NOW())) AS new_bookings_this_month
FROM customer_health;

-- Recreate cohort_analysis (uses subscription_status directly from organizations)
CREATE VIEW cohort_analysis AS
SELECT
  DATE_TRUNC('month', o.created_at) AS cohort_month,
  COUNT(DISTINCT o.workos_organization_id) AS cohort_size,
  COUNT(DISTINCT o.workos_organization_id) FILTER (
    WHERE o.subscription_status = 'active'
  ) AS still_active,
  COUNT(DISTINCT o.workos_organization_id) FILTER (
    WHERE o.subscription_canceled_at IS NOT NULL
  ) AS churned,
  ROUND(
    COUNT(DISTINCT o.workos_organization_id) FILTER (
      WHERE o.subscription_status = 'active'
    )::NUMERIC / NULLIF(COUNT(DISTINCT o.workos_organization_id), 0) * 100,
    2
  ) AS retention_rate
FROM organizations o
WHERE o.created_at IS NOT NULL
GROUP BY DATE_TRUNC('month', o.created_at)
ORDER BY cohort_month DESC;

-- Comments for documentation
COMMENT ON VIEW customer_health IS 'Current health status of all customers with LTV, ARR, and risk indicators. Uses actual subscription_status from Stripe webhooks.';
COMMENT ON VIEW subscription_metrics IS 'Summary metrics including ARR, new bookings, and churn indicators.';
COMMENT ON VIEW cohort_analysis IS 'Customer retention by signup cohort.';
