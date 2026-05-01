---
---

feat(billing): lazy reconcile on certification paywall hit (#3623 step 3).

When a Stripe customer is re-linked between orgs (admin audit, support fix-up) without subscription state being transferred to the new org row, the user shows up as a non-member at the next paywall hit despite holding an active membership in Stripe. Three real cases observed in production (Lina/HYPD/Yoshihiko, all manually fixed via `/sync`).

Adds `attemptStripeReconciliation(orgId)` in `server/src/billing/lazy-reconcile.ts`. The four certification gates (`get_certification_module`, `start_certification_module`, `test_out_modules`, `start_certification_exam`) now call `ensureMembership()` before denying — which lazy-heals from Stripe when the org has a `stripe_customer_id` but no `subscription_status` and Stripe holds an active membership sub. The user clicking the paywall is the trigger; they never see the drift.

Idempotent: `WHERE subscription_status IS NULL OR = 'none'` ensures concurrent webhook writes always win. Filters via `pickMembershipSub` so a non-membership sub stacked alongside doesn't pollute the heal. Doesn't write attestation/audit/activity rows — the webhook handler is the canonical place for those side effects (paywall click is action-signal, not fresh consent).

Verified end-to-end against the sandbox `lina_class` fixture: drift detected → heal succeeds → row populated. Re-run on healed row → idempotent no-op (`already_entitled`).
