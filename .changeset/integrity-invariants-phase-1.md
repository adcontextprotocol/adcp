---
---

Add Phase 1 of the cross-system integrity-invariants framework (#3181).

Each invariant is a self-contained assertion about state across WorkOS, Stripe, and AAO Postgres. The runner orchestrates evaluation, isolates failures, and produces a per-violation report. New admin endpoints `GET /api/admin/integrity/check` (run all) and `GET /api/admin/integrity/check/:name` (run one) surface the report on demand.

Phase 1 ships five invariants:

- `stripe-customer-org-metadata-bidirectional` (critical) — every org's stripe_customer_id resolves to a Stripe customer whose metadata.workos_organization_id points back at the same org. Catches Triton-shape cross-contamination.
- `one-active-stripe-sub-per-org` (critical) — no org has more than one live (active/trialing/past_due) Stripe subscription. The literal Triton failure mode.
- `stripe-customer-resolves` (critical) — every referenced Stripe customer exists and is not deleted.
- `org-row-matches-live-stripe-sub` (warning) — when an org has both a stripe_subscription_id and a live status, the row's mirrored amount/lookup_key/status agree with Stripe.
- `workos-membership-row-exists-in-workos` (warning, sampled) — random sample of active organization_memberships rows are reflected in WorkOS.

Phase 2 (separate PR) will add scheduled runs, persisted reports, Slack alerting, and an admin dashboard page. Phase 3+ extends to webhook-miss detection and inverse-walk orphan detection.
