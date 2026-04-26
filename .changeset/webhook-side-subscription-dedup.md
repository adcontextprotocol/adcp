---
---

Webhook-side dedup on `customer.subscription.created`: cancel a duplicate subscription with proration and skip the org-row UPDATE when the customer already has another live sub. Closes the cross-path race the intake-side guards (active-subscription guard, advisory lock) can't catch — Stripe Checkout creates a session URL, not a subscription, so two concurrent intake paths can both pass guards before either mints a sub. Logs and alerts ops; failures fall through (audit invariant catches misses).
