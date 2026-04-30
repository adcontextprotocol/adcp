---
---

fix(billing): re-throw on core subscription UPDATE failure (catch-block audit, #3623 step 5).

The `customer.subscription.created/updated/deleted` webhook handler in `http.ts:3727-3957` wrapped the core column UPDATE plus all downstream side effects in a single try/catch that returned 200 on any error. If the UPDATE itself failed (DB outage, constraint violation, race), Stripe never retried and the org row was left silently stale — the silent-swallow path the experts warned about during #3681 review.

Hoists the core UPDATE outside the swallow-on-error block. UPDATE on a single row by primary key is idempotent — exception now propagates so Stripe retries. Downstream side effects (tier-change enforcement, welcome DMs, autopublish, .deleted audit/activities) keep their existing log+continue pattern because they're non-idempotent and a Stripe retry would refire them.

Adds `server/tests/integration/admin-stripe-link-unlink.test.ts` covering the link/unlink hardening from #3681 + #3692:
- link picks the membership sub when customer has multi-sub (data[0] regression)
- link writes admin_stripe_link audit log
- unlink clears all subscription_* columns
- unlink clears Stripe customer metadata.workos_organization_id (closes webhook re-link race)
- unlink writes admin_stripe_unlink audit log with prior state

Out of scope (follow-up identified): the same silent-swallow pattern exists at `http.ts:4195` (revenue_events INSERT in `invoice.paid`) and lines 4393, 4469, 4506. `revenue_events.stripe_invoice_id` already has a UNIQUE constraint so retries are safe; the right fix is `ON CONFLICT (stripe_invoice_id) DO NOTHING` plus re-throw on real errors. Tracked separately rather than expanding this PR.
