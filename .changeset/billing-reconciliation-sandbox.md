---
---

scripts(billing): add Stripe (test-mode) + dev-DB sandbox for reconciliation work.

Idempotent setup script creates a deterministic 6-fixture matrix in Stripe test mode + local Postgres covering Lina-class drift, multi-sub (data[0]) bug, email mismatch, orphan customer, and WorkOS resolution failure. Verify script runs the new `stripe-sub-reflected-in-org-row` invariant and reports detected drift. Refuses to run unless `STRIPE_SECRET_KEY` is `sk_test_*` and `DATABASE_URL` is local. Companion to #3623 — provides the test infrastructure that Path B reconciliation work depends on.
