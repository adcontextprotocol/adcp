---
---

fix(billing): clear subscription state on unlink + filter membership sub on link (#3623 step 4).

Two bugs in the admin Stripe-customer link/unlink endpoints surfaced by the Lina/HYPD/Yoshihiko investigation:

1. **`POST /api/admin/stripe-customers/:customerId/unlink`** was setting `stripe_customer_id = NULL` but leaving every other `subscription_*` column intact. After unlink, the org row continued to show as a paying member with no Stripe link — entitlement gates would silently grant access on stale state until a webhook fired (which never does, since the customer is gone). Now clears `stripe_subscription_id`, `subscription_status`, `subscription_amount`, `subscription_interval`, `subscription_current_period_end`, `subscription_canceled_at`, `subscription_product_id`, `subscription_product_name`, `subscription_price_id`, `subscription_price_lookup_key`, and invalidates the membership cache.

2. **`POST /api/admin/stripe-customers/:customerId/link`** had the same `subscriptions.data[0]` bug as `/sync` (fixed in #3646) — picks the first sub regardless of whether it's a membership sub. Now uses `pickMembershipSub` to filter.
