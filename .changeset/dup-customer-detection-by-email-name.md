---
---

Extends `findStripeCustomerMismatches` (and `GET /api/admin/stripe-mismatches`) to detect duplicate Stripe customers by shared email or shared name+active-sub, in addition to the existing metadata-based detection. Each mismatch carries `match_reason: 'metadata' | 'email' | 'name'`. Closes #3200, the ResponsiveAds case where two customers shared an email and the orphan generated a duplicate $2,500 invoice.
