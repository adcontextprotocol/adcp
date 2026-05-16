---
---

Lock down partial-truth subscription rows that misrender as Explorer / upgrade-to-Professional.

Background — Adzymic / Travis Teo (May 2026): a founding-member org row had `subscription_status='active'` but NULL `subscription_price_lookup_key`, NULL `stripe_subscription_id`, NULL `subscription_amount`. Tier resolution returned null, so `dashboard-organization.html` fell back to `DEFAULT_TIER` (label "Explorer") and rendered "Upgrade to Professional — $250/yr" to a paying corporate member. Five+ founding-era orgs were in the same state. Both existing Stripe-side invariants and the `lazy-reconcile` heal path treated `status='active'` as proof of full sync, so neither flagged or repaired the rows.

Changes:

- **New invariant** `every-entitled-org-has-resolvable-tier` (critical, DB-only). Walks every org with entitled `subscription_status` and asserts `resolveMembershipTier()` returns non-null. Backstop on the function the dashboard and Addie's prompt rules consume — catches the Adzymic shape and any future schema drift that leaves a class of entitled orgs unresolvable.
- **Tightened `stripe-sub-reflected-in-org-row`** healthy predicate to require entitled status AND populated `stripe_subscription_id` AND populated tier-resolving product fields (lookup_key non-null OR amount > 0). Previously skipped partial-truth rows on status alone.
- **Tightened `lazy-reconcile.ts` guard** with the same predicate, plus broadened the UPDATE WHERE clause so heals can write when the row is partial-truth (not only when status is null).
- **Dashboard fallback fix** in `server/public/dashboard-organization.html`: when `membership_tier` is null but the user is a member, render a neutral "Active membership" state and skip the upgrade teaser. Never silently fall through to `individual_academic` (the Explorer/Professional upsell path).
- **One-shot reconciliation script** `scripts/incidents/2026-05-heal-partial-truth-tier-rows.ts` — calls the new invariant, lists violations, and POSTs `/api/admin/accounts/:orgId/sync` for each. Defaults to `--dry-run`; pass `--execute` to heal.
- Tests: Adzymic-shape regression cases for the new invariant, the tightened `stripe-sub-reflected-in-org-row`, and `attemptStripeReconciliation`.
