---
---

fix: store pending agreement before checkout on membership page

- Added missing `/api/organizations/:orgId/pending-agreement` call in
  `proceedToCheckout()` so the Stripe webhook can record agreement acceptance
  atomically (matches existing behavior in dashboard.html)
- Added missing `escapeHtml()` on `product.lookup_key` in new-subscriber
  product cards and subscription select options
