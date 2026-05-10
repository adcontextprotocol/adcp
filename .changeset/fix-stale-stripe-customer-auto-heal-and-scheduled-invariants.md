---
---

Fixes a noisy "No such customer" Slack alert + 500 on the billing page when an org's `stripe_customer_id` points at a non-existent Stripe customer (deleted, or written from a different Stripe mode). Three changes:

1. `createCustomerSession` and `getPendingInvoices` re-throw Stripe `resource_missing` errors instead of swallowing them — other errors still log+return null/[]. The billing-public route detects `resource_missing` via `isStripeNotFound`, unlinks the stale customer ID, calls `getOrCreateStripeCustomer` again, and retries once. User no longer sees a 500 and the global `logger.error` → error-channel hook no longer fires for this recoverable case.

2. New `server/src/scripts/unlink-stale-stripe-customers.ts` (dry-run by default, `--apply` to write) walks every org with a non-null `stripe_customer_id`, retrieves from Stripe, and unlinks rows that are missing or `deleted: true`. Same shape the `stripe-customer-resolves` invariant detects, with a remediation step.

3. Phase 2 of the integrity-invariants framework: a `runIntegrityInvariantsJob` background job runs `ALL_INVARIANTS` every 6 hours and posts a single Slack alert per run when any critical violation is found (one summary message, grouped by invariant, with a sample of three). The env-mismatch guard from the admin route is shared via `audit/integrity/env-mismatch.ts` so the job refuses to run with a `sk_test_*` key against prod (or vice versa) — the same protection that kept the on-demand admin route honest.

Drift like "org references a non-existent Stripe customer" now surfaces within hours instead of waiting for a user to load the affected page.
