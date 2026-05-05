---
---

Two billing UX fixes for the failure modes Sabarish hit. (1) `POST /api/organizations/:orgId/billing/portal` now refuses with a clear "no active subscription" error and a pointer to `/dashboard/membership` when the org has never paid — Stripe's customer portal can only manage existing subscriptions, so opening it for a non-subscriber was a silent dead end. (2) Stripe webhook handler captures `checkout.session.expired` and records a `checkout_session_expired` person event so Addie's relationship loop can offer to send a fresh checkout link instead of leaving the user stranded on Stripe's "session expired" page.
