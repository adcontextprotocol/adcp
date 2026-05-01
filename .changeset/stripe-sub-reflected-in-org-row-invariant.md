---
---

audit: add `stripe-sub-reflected-in-org-row` integrity invariant.

Walks Stripe (active + trialing membership subs), flags orgs whose row doesn't reflect the live Stripe state — the inverse direction of the existing `org-row-matches-live-stripe-sub`. Catches the missed-`customer.subscription.created` failure mode that left a paying member blocked from entitlement for ~40 days. Detect-only; auto-remediation is a separate follow-up. Orphan Stripe customers (paid sub, no AAO org link) are flagged as `warning`, never auto-linked. Closes detect path of #3623.
