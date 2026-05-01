---
---

`profile.company.is_member` and `orgMemberships[].is_paying_member` now use the canonical `MEMBER_FILTER` predicate (`subscription_status = 'active' AND subscription_canceled_at IS NULL`) — a canceled-but-still-in-period subscription correctly reads as not paying. Both call sites in `relationship-context.ts` now share an `isPayingMembership(row)` helper from `org-filters.ts`. Closes #3677.
