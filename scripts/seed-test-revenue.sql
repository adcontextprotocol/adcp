-- Seed test revenue data for Metabase analytics
-- This creates sample revenue events for the existing test subscription

-- Get the organization ID
DO $$
DECLARE
  test_org_id TEXT := 'org_01KAYQG2FCA1J12CERG9ZKRQCQ';
  test_customer_id TEXT := 'cus_TUoTJRUiKZKkhc';
BEGIN
  -- Insert initial subscription payment (today)
  INSERT INTO revenue_events (
    workos_organization_id,
    stripe_invoice_id,
    amount_paid,
    currency,
    revenue_type,
    product_id,
    product_name,
    price_id,
    billing_interval,
    paid_at
  ) VALUES (
    test_org_id,
    'in_test_initial_' || EXTRACT(EPOCH FROM NOW())::TEXT,
    250000, -- $2,500.00
    'usd',
    'subscription_initial',
    'prod_adcp_annual',
    'AdCP Membership - Annual',
    'price_adcp_annual',
    'year',
    NOW()
  );

  -- Insert recurring payment (3 months ago)
  INSERT INTO revenue_events (
    workos_organization_id,
    stripe_invoice_id,
    amount_paid,
    currency,
    revenue_type,
    product_id,
    product_name,
    price_id,
    billing_interval,
    paid_at
  ) VALUES (
    test_org_id,
    'in_test_recurring_3mo_' || EXTRACT(EPOCH FROM NOW())::TEXT,
    250000, -- $2,500.00
    'usd',
    'subscription_recurring',
    'prod_adcp_annual',
    'AdCP Membership - Annual',
    'price_adcp_annual',
    'year',
    NOW() - INTERVAL '3 months'
  );

  -- Insert recurring payment (6 months ago)
  INSERT INTO revenue_events (
    workos_organization_id,
    stripe_invoice_id,
    amount_paid,
    currency,
    revenue_type,
    product_id,
    product_name,
    price_id,
    billing_interval,
    paid_at
  ) VALUES (
    test_org_id,
    'in_test_recurring_6mo_' || EXTRACT(EPOCH FROM NOW())::TEXT,
    250000, -- $2,500.00
    'usd',
    'subscription_recurring',
    'prod_adcp_annual',
    'AdCP Membership - Annual',
    'price_adcp_annual',
    'year',
    NOW() - INTERVAL '6 months'
  );

  -- Insert a refund to show negative revenue (1 month ago)
  INSERT INTO revenue_events (
    workos_organization_id,
    stripe_invoice_id,
    amount_paid,
    currency,
    revenue_type,
    metadata,
    paid_at
  ) VALUES (
    test_org_id,
    'ref_test_' || EXTRACT(EPOCH FROM NOW())::TEXT,
    -50000, -- -$500.00 refund
    'usd',
    'refund',
    '{"refund_reason": "customer_request"}'::jsonb,
    NOW() - INTERVAL '1 month'
  );

  RAISE NOTICE '✨ Seeded revenue data:';
  RAISE NOTICE '  • Initial payment: $2,500.00 (today)';
  RAISE NOTICE '  • Recurring payment: $2,500.00 (3 months ago)';
  RAISE NOTICE '  • Recurring payment: $2,500.00 (6 months ago)';
  RAISE NOTICE '  • Refund: -$500.00 (1 month ago)';
  RAISE NOTICE '  • Net revenue: $7,000.00';
END $$;
