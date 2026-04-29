---
---

backend(verification): per-major-version badge data model. Stage 1 of #3524 — extends `agent_verification_badges` so an agent can hold parallel `(Spec)` / `(Live)` badges across AdCP minor versions (3.0, 3.1, 4.0…). The previous PK `(agent_url, role)` becomes `(agent_url, role, major_version)`.

Behavior change is gated to Stage 2. This PR ships:

- **Migration 457**: adds `major_version TEXT NOT NULL` to `agent_verification_badges`, backfills existing rows from `verified_protocol_version` (`X.Y.Z` → `X.Y`, falling back to `'3.0'` for null/malformed), rebuilds the PK to include `major_version`, drops the temporary default so future writes must specify the version explicitly. Adds an index on `(role, major_version, status)` for the per-version listings the panel and brand.json enrichment will need in later stages.
- **DB layer**: `AgentVerificationBadge` type gains `major_version`. `upsertBadge` / `getActiveBadge` / `revokeBadge` / `degradeBadge` now take a `majorVersion` parameter. `getBadgesForAgent` / `bulkGetActiveBadges` / `getVerifiedAgentsByRole` order by `major_version DESC` so callers see the most recent first.
- **New helper**: `getHighestVersionActiveBadge(agentUrl, role)` powers the legacy `/badge/{role}.svg` URL — embedded badges in the wild auto-upgrade to the newest version the agent has earned without changing the URL. Per Q3 of the resolved-decisions thread on #3524.
- **`processAgentBadges()`**: accepts an optional `majorVersion` parameter (defaults to `DEFAULT_BADGE_MAJOR_VERSION = '3.0'` for Stage 1 callers). The function now scopes existing-badge reads and writes to that single version — a `failing` 3.1 run never touches a 3.0 badge and vice versa. This is the load-bearing isolation property: it's what lets old-version badges persist while new versions are evaluated independently.

Four new tests cover the version-isolation invariant: only-touch-version-under-test, upsertBadge receives the version, default fallback when callers don't specify, and membership-lapse only affects the version under test.

What this PR does NOT change:
- The heartbeat job still calls `processAgentBadges()` without a `majorVersion` — defaults to `'3.0'`. Stage 2 wires per-version fan-out.
- Storyboards have no `since:` field yet. Added in Stage 2.
- Badge SVG labels still read "Media Buy Agent (Spec)" — version segment lands in Stage 3.
- Verification panel still renders one row per role. Stage 4 splits into one row per (role, version).
- brand.json enrichment shape unchanged. Stage 5 adds the `badges[]` array.

Per the resolved-decisions comment on #3524: badge granularity is minor-level (`'3.0'`, `'3.1'`), JWT keeps `protocol_version` as informational metadata while a future stage adds `major_version` as the load-bearing claim, and the legacy SVG URL serves the highest active version.
