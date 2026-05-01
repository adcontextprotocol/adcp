---
---

fix(billing): re-throw on demotePublicAgentsOnTierDowngrade failure (closes #3694).

When an org's tier downgrade flips it from a tier with API access to one without, `demotePublicAgentsOnTierDowngrade` must demote any `public`-marked agents to `members_only` and strip them from the org's brand.json — otherwise they stay publicly listed on a tier that doesn't allow it (silent entitlement leak).

The call site at `http.ts:3792` was wrapped in a try/catch that logged the failure and continued. A transient DB error during demotion would silently leave the org with stale public agents until the next tier change.

Hoists the demote call outside the swallow-on-error block, alongside the core subscription UPDATE — they're a pair (the UPDATE writes the new tier; demote enforces the corresponding agent visibility). The helper is idempotent on retry (`FOR UPDATE` on member_profiles row; returns null when no public agents remain), so a Stripe retry that re-fires the tier-downgrade webhook does the right thing.

Closes the second of the three follow-ups identified in the #3691 catch-block audit.
