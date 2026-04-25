---
---

Extend Stripe duplicate customer detector to find orphan customers by email or name+active-subscription, in addition to the existing metadata-based detection.

- `findStripeCustomerMismatches()` now returns `match_reason: 'metadata' | 'email' | 'name'` on each result
- A single Stripe customer scan (replacing two sequential scans) covers all three detection strategies
- Admin UI and resolve endpoint field renamed `stripe_metadata_customer_id` → `orphan_customer_id`
- "Both customers have activity" 400 error now includes actionable Stripe steps
