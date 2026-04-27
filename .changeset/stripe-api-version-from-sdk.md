---
---

Stripe client now reads its `apiVersion` from `Stripe.API_VERSION` instead of a pinned literal. Each Stripe SDK bump previously required a manual update to the literal in `server/src/billing/stripe-client.ts`, which was missed when the minor-and-patch group bumped Stripe and broke the build.
