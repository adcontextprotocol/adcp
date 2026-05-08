---
---

Compliance heartbeat now picks up agents registered through the member-profile
surface, fixing a "registered but compliance status stays `unknown` forever"
bug that's the same shape as the operator-endpoint visibility miss.

**Why this changed.** A member registered an agent at
`https://www.harvingupta.xyz/api/mcp` and saw it correctly in
`/dashboard/agents`, but `GET /api/registry/agents/<url>/compliance` returned
`{ status: "unknown", last_checked_at: null }` indefinitely. The heartbeat's
"agents due for check" query (`compliance-db.ts:getAgentsDueForCheck`) keys off
a `known_agents` CTE that unioned `discovered_agents` (crawler-discovered) and
`agent_registry_metadata` (explicit registration). Member-registered agents
land in `member_profiles.agents` JSONB, not in either of those tables —
the heartbeat never picked them up, so `agent_compliance_status` stayed empty
and the API served `status: "unknown"` forever.

**Fix shape — both write-side and read-side.**

- **Write-side seed.** `applyMemberAgentMutation` (the helper backing
  `POST /api/me/agents` and `PATCH /api/me/agents/:url`) now bulk-upserts
  an `agent_registry_metadata` row for every URL in the resulting agents
  array, atomically with the JSONB write. `ON CONFLICT DO NOTHING`
  preserves any owner-customized `lifecycle_stage` /
  `check_interval_hours` / `compliance_opt_out` value the dashboard or
  heartbeat wrote earlier — the seed only fires when the row is absent.
  The Addie `save_agent` MCP handler does the same upsert after its
  profile write; failures are logged at `warn` and don't fail the
  registration.
- **Read-side defense in depth.** The `known_agents` CTE in
  `getAgentsDueForCheck` now has a third leg:
  `SELECT (a->>'url') FROM member_profiles, jsonb_array_elements(agents) a`.
  Any agent that slipped past the seed (write-side fallback fired,
  pre-fix row, direct SQL) is still picked up by the heartbeat.
  `ORDER BY` gains `ka.agent_url ASC` as a deterministic tiebreaker so
  two never-checked agents land in a stable order across runs.

**Behavior change.** None on existing API contracts. The heartbeat will
start picking up previously-orphaned member-profile agents on its next
cycle, which means a brief surge of compliance runs after deploy as the
backlog drains. Per-agent rate limits and the heartbeat's per-run
`limit` cap (default 10) bound the surge.

**Existing rows.** A backfill script seeds `agent_registry_metadata`
rows for every URL currently in `member_profiles.agents` that has no
metadata row. Manual run on the pod, intentionally out of
`release_command` so it doesn't auto-fire on deploy. The read-side CTE
widening means the heartbeat would pick those agents up regardless, but
seeding the metadata row keeps every other downstream consumer
(dashboard lifecycle / opt-out / monitoring settings) consistent.

**Tests.** Three new integration tests in `member-agents-api.test.ts`
pin the contract:

- POST seeds an `agent_registry_metadata` row when none exists
  (default `lifecycle_stage = 'production'`, `compliance_opt_out = false`)
- POST does NOT overwrite an existing metadata row on re-register
  (custom `lifecycle_stage = 'testing'`, `check_interval_hours = 24` survive)
- `getAgentsDueForCheck` picks up an agent that lives only in
  `member_profiles.agents` (read-side CTE widening verified in isolation
  by deliberately deleting the metadata row before the call)
