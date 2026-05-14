---
---

Make agent `type` a required, owner-declared field at every registration
surface, and auto-populate `primary_brand_domain` when an agent is registered
against a profile that has none.

**Why this changed.** A profile registered an agent at
`https://www.harvingupta.xyz/api/mcp` and showed up correctly in the dashboard,
but `GET /api/registry/operator?domain=harvingupta.xyz` returned
`{ member: null, agents: [] }`. Two compounding gaps:

1. The agent's stored `type` was absent. The `save_agent` MCP tool's
   schema explicitly did not accept a `type` field — it relied on a
   server-side capability-snapshot resolution that silently produced no value
   when the probe failed. The REST `POST /api/me/agents` accepted
   `Partial<AgentConfig>` and never validated `type` either. The operator
   endpoint masked the missing field with `type: ac.type || "unknown"`, so
   bad data flowed straight through to the public response.
2. The profile's `primary_brand_domain` was `NULL`. Agent registration writes
   `member_profiles.agents` JSONB but never backfilled
   `primary_brand_domain`, and the public operator lookup keys exact-match on
   that column. Result: a registered agent that the profile owner could see
   in the dashboard but no peer could discover via the registry.

**What this PR does.**

- `save_agent` (Addie MCP tool) requires `type` in its `input_schema`
  (`brand` | `rights` | `measurement` | `governance` | `creative` |
  `sales` | `buying` | `signals`) and persists it. The handler also updates
  `type` on re-runs against an existing agent (so an owner who initially
  declared the wrong type can correct it by re-saving). Tool description and
  intake script in `behaviors.md` now instruct Addie to ask for type before
  calling `save_agent` — the prior "do not ask about agent type" rule, and
  the "resolved server-side from the capability snapshot" framing, are
  removed. If the user describes capabilities, Addie may suggest a fit, but
  the user must confirm before save.
- `POST /api/me/agents` (REST) returns `400` when `type` is missing or not
  one of the eight valid values; `'unknown'` is rejected on input. `PATCH
  /api/me/agents/:url` validates `type` when present (omission preserves the
  existing value).
- The mutation helper backs an agent register/update with a single
  transaction: when the profile's `primary_brand_domain` is `NULL` and every
  agent in the resulting array agrees on the same hostname (after stripping
  `www.`), the column is backfilled atomically with the JSONB write.
  Conflicting hostnames are deliberately skipped — picking one would
  mis-key registry lookups.
- `/api/registry/operator` no longer hides missing/invalid `type` behind a
  `|| "unknown"` fallback. Out-of-enum values still serialize as `"unknown"`
  to preserve the OpenAPI response contract, but a `warn`-level log fires so
  ops can spot corrupt rows that slipped past the write gates. Server-side
  smuggle protection (`resolveAgentTypes`) is unchanged: it remains the only
  path that may stamp `'unknown'` on a write, when the capability snapshot
  contradicts a client declaration without producing a classification.
- `MemberAgentInputSchema` (OpenAPI) now requires `type` and uses a new
  `MemberAgentTypeInput` enum that excludes `'unknown'`; the read-side
  `MemberAgentType` schema keeps `'unknown'` for the smuggle-protection
  outcome.

**Existing rows.** Pre-existing profiles with `primary_brand_domain IS NULL`
or agents missing `type` are not touched by this PR — they were handled by a
manual migration run on the pod (backfill `primary_brand_domain` from the
unanimous agent hostname; default any agent with missing/invalid `type` to
`sales`). Keeping the migration out of `release_command` so it doesn't
auto-fire on deploy.
