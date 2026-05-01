---
---

fix(billing): re-throw on transient revenue_events INSERT failure (closes #3693).

Two webhook handlers were swallowing all errors when inserting into `revenue_events` and returning 200 — Stripe never retried, so transient DB errors silently lost paid revenue. The UNIQUE constraint on `stripe_invoice_id` makes the legitimate-retry case safe (PG `23505` = duplicate Stripe re-fire), but it was also masking real transient failures.

Now distinguishes by error code: `23505` swallowed (legitimate dedupe), everything else re-thrown so Stripe retries with backoff. Applied at `http.ts:4180-4239` (`invoice.paid`) and `http.ts:4400-4458` (`invoice.payment_failed`).

The third site (`charge.refunded` at line 4480) uses `stripe_charge_id` which is NOT a UNIQUE column on `revenue_events`. Cannot apply the 23505 pattern there until a schema migration adds the constraint. Kept the swallow with a comment explaining the gap. Follow-up tracked.
