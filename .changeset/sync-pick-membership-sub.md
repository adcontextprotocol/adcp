---
---

fix(billing): `/sync` picks the membership sub, not `subscriptions.data[0]`.

`POST /api/admin/accounts/:orgId/sync` was reading `customer.subscriptions.data[0]` to derive the org's subscription state. Stripe doesn't guarantee subscription ordering — when a customer has a non-membership sub (one-off product, future ancillary sub) stacked alongside a real membership, the wrong sub could win and the org row would be overwritten with the non-membership sub's state.

Verified against the sandbox `multi_sub` fixture: Stripe returns the non-membership sub first; old behavior picked it, new behavior picks the membership sub regardless of order. Extracts `pickMembershipSub` + `isMembershipLookupKey` into `server/src/billing/membership-prices.ts` so the integrity invariant and `/sync` share one predicate.
