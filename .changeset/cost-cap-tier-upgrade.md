---
---

Resolve real tier for authenticated callers of the Addie cost cap
(#2945 follow-up; closes the deferred tier-upgrade path from
#2790 / #2946 / #2950).

Paying members were silently capped at `member_free` ($5/day) rather
than their `member_paid` ceiling ($25/day) because every caller site
hardcoded `tier: 'member_free'`. This lands a new async helper
`resolveUserTierForScopeKey(userId)` in `claude-cost-tracker.ts` and
wires it into every authenticated caller site (10 total across
`bolt-app.ts`, `handler.ts`, `addie-chat.ts`, `tavus.ts`).

**Resolution rule:**
- Bare WorkOS id (`user_…`): DB probe against
  `organization_memberships` + `organizations`. Active, non-canceled
  subscription → `member_paid`. Otherwise → `member_free`.
- Non-WorkOS scope keys (`slack:…`, `email:…`, `mcp:…`, `tavus:ip:…`,
  `anon:…`): no lookup, stays `member_free`.
- DB error: fail-closed to `member_free` so a transient outage can't
  accidentally grant the $25/day ceiling to unverified callers.

Tests cover the four cases (non-WorkOS bypass, active-sub promotion,
no-sub fallback, DB-error fail-closed) via the `db/client.js` mock
seam.
