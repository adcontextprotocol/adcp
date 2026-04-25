---
---

Refuse to mint a new Stripe subscription/invoice when the org already has an active, trialing, or past_due one.

`POST /api/checkout-session`, `POST /api/invoice-request`, and `POST /api/invite/:token/accept` now all run a duplicate-subscription guard before issuing billing. If the org has a live subscription, they return 409 with the existing subscription details and a Stripe Customer Portal URL. Tier upgrades and payment-method changes belong in the portal, not these intake routes — without this guard, two of them in sequence produced the duplicate $3K Builder sub on top of Triton's active $10K Corporate sub (Apr 2026).
