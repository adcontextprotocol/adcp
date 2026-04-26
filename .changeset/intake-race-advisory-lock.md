---
---

Close the millisecond intake race that the duplicate-subscription guard couldn't on its own (#3179).

`POST /api/invoice-request` and `POST /api/invite/:token/accept` now wrap their `blockIfActiveSubscription` re-check + Stripe write in a per-org Postgres advisory lock (`pg_advisory_xact_lock(hashtext(orgId))`). Two concurrent intakes for the same org serialize: the first acquires the lock, runs the guard against live Stripe state, mints the subscription/invoice, commits, and releases; the second acquires the lock, runs the guard, sees the now-existing subscription, and returns 409.

`POST /api/checkout-session` is intentionally not wrapped in the lock — Stripe Checkout sessions don't create the subscription until the user completes the hosted page, so two concurrent calls just produce two session URLs; the actual duplication can only happen if the user pays on both. That race is closed at the webhook layer (separate follow-up).
