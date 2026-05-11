---
---

Partial completion of #4378: adds 6 explicit unit tests pinning the `is_owner` field semantics in `resolveOwnerMembership` — the load-bearing gate for `verdict_source` on the public compliance API. Covers anonymous, non-owner, orphan-profile (deleted org), and three distinct owner tiers (free Explorer, API-access, canceled-sub). Anchors the invariant that `is_owner` is broader than `is_api_access_tier` so free-tier owners still see the UX cue on their own dashboard. Full route-level integration test deferred to a follow-up — requires DB-fixture scaffolding not currently in place for this endpoint.
