---
"adcontextprotocol": patch
---

Membership upgrade flow now follows the Stripe Customer Portal URL when `/api/checkout-session` returns 409. Previously the dashboard surfaced "Upgrade" buttons for tiers above the org's current sub, but clicking them routed through the checkout intake — which `blockIfActiveSubscription` refuses by design — and the client discarded the `customer_portal_url` from the 409 body, dead-ending the user on a toast like "already on Explorer ($50.00)". `proceedToCheckout` in `dashboard-membership.html` and both checkout entry points in `dashboard.html` now redirect to the returned portal URL so tier changes complete end-to-end.
