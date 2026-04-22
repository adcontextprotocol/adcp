---
---

Three-tier agent visibility: each registered agent is now `private`,
`members_only`, or `public`, replacing the boolean `is_public` flag.

- Setting an agent to `public` requires an API-access membership tier
  (Professional and above). Non-paying users and Explorer can still set
  `private` or `members_only`.
- `members_only` is the discovery pool for paid-member-only agents: a
  non-paying org can register agents and be found by Professional+
  members without landing in the public directory. This solves the
  Scope3-style discovery case.
- On Stripe tier downgrade (or full cancellation), public agents are
  auto-demoted to `members_only` and stripped from the org's community
  brand.json manifest.

New surfaces:
- `PATCH /api/me/member-profile/agents/:index/visibility` — canonical
  endpoint for tier changes. Returns 403 with `error: 'tier_required'`
  when `public` is requested without API access.
- `POST /publish` / `DELETE /publish` kept as thin wrappers.
- `POST /check` is now report-only — returns a `drift` value instead of
  silently mutating visibility.
- `PUT /api/me/member-profile` coerces smuggled `visibility: 'public'`
  on any agent to `members_only` for non-API-access callers and surfaces
  the change via a `warnings[]` array.
- MCP `list_agents`, `get_agent`, `list_members`, `get_member` receive
  the caller's org tier and return `members_only` agents to API-access
  callers. Non-API callers never see `members_only` or `private`.
- MCP responses omit the `visibility` field for non-API callers (it's
  always `public` for them — cuts context).

UI: the member dashboard ships a three-state selector; new agents
default to `members_only`. Migration 419 rewrites existing agents
JSON. Includes a drive-by fix for `brand_revisions.domain`
(column was renamed to `brand_domain` in migration 389; code still
queried the old name).
