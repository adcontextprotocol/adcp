---
---

Extend `POST /api/admin/accounts/:orgId/sync` to backfill `revenue_events` rows for paid Stripe invoices that were never recorded (missed `invoice.paid` webhooks due to orphaned customer metadata). The backfill walks all paid invoices for the customer using paginated auto-iteration, upserts with `ON CONFLICT (stripe_invoice_id) DO NOTHING` so webhook-written rows win, and returns `revenue_events_synced: N` at the top level of the sync response. The admin sync UI now surfaces the count. Fixes silent MRR undercounting when a Stripe customer is re-linked after an orphan scenario.
