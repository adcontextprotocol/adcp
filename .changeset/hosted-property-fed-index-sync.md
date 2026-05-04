---
---

Hosted properties now propagate into the federated index. Previously, when
a publisher opted into AAO-hosted adagents.json (a public
`hosted_properties` row), the agents and properties declared in its
`adagents_json` lived in isolation — `/api/registry/publisher` would
report 0 agents for that domain even though the canonical document AAO
served said otherwise. New `services/hosted-property-sync.ts` mirrors a
public hosted property into `discovered_properties`,
`discovered_agents`, `agent_publisher_authorizations`, and
`discovered_publishers`. Wired into the three primary write paths:
`/api/properties/save` (create + edit) and the Addie approval /
enrichment path.

Reconciliation semantics:
- `agent_publisher_authorizations` rows are fully reconciled — agents
  removed from the manifest are deleted (we own the `source='adagents_json'`
  label for this domain when AAO hosts).
- `discovered_publishers` row uses a stable AAO sentinel value
  (`aao://hosted`) for `discovered_by_agent` so re-syncs collapse to one
  row regardless of agent ordering.
- `discovered_properties` is additive only — the table has no source
  column, so we cannot safely distinguish hosted-written rows from
  crawler-written rows. Removed properties persist until manually cleared.
  Tracked as a follow-up.

Also: rate-limit the per-agent rollup on `/api/registry/publisher` to
50 agents per request to bound fan-out on an unauthenticated endpoint.
Above the cap, agents are returned without rollup data and a
`rollup_truncated: true` flag — call `/api/registry/publisher/authorization`
for the per-agent count.

Also: domain shape validation on `/publisher/:domain/.well-known/adagents.json`,
agent URL canonicalization on `/api/registry/publisher/authorization`,
brand.json walker capped at 5000 entries, identifiers preserved (not
dropped) for non-website brand.json types.

Finally: when `adagents_valid: false` on `/publisher/{domain}`, the badge
exposes a "why?" link that fetches `/api/adagents/validate` and inlines
the structured error list.
