---
---

Fixes a silent billing state drop when a Stripe subscription cancellation arrives for a drift-customer org (the event's `customer` field does not match the org's `stripe_customer_id`, and the subscription has no `workos_organization_id` metadata). Adds a `stripe_subscription_id` DB fallback in `resolveOrgForStripeCustomer` so the org is always resolved when the sub ID is tracked; adds `logger.warn` + `notifySystemError` alerting when resolution still fails for `.updated`/`.deleted` events; adds a regression test for the drift scenario.
