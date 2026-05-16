---
---

Fix `/api/admin/accounts/:orgId/sync` — Stripe expansion depth + observable error logging.

Hotfix on top of #3829: I asked Stripe to expand `subscriptions.data.items.data.price.product` on `customers.retrieve`, which is 6 levels deep and exceeds Stripe's 4-level expansion limit. Every /sync call against an org with a Stripe customer threw and returned a generic "Failed to sync from Stripe" with no log line.

- Drop the deep expand on `customers.retrieve` (just confirms the customer isn't deleted).
- Fetch subscriptions separately via `stripe.subscriptions.list({ expand: ['data.items.data.price.product'] })` — only 4 levels deep from the subscriptions resource, within Stripe's limit. The expansion is what makes `isMembershipSub`'s metadata fallback work for founding-era prices.
- Log the actual error on the catch path so the next regression like this surfaces in admin logs instead of being invisible.
