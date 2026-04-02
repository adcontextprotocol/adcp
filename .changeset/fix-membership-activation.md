---
---

fix: store pending agreement before checkout on membership page

The dashboard-membership page skipped the pending-agreement API call before
redirecting to Stripe checkout. This meant the webhook could not find the
agreement version the user accepted, falling back to a generic lookup.
