---
---

fix(registry): canonicalize agent_url at federated-index merge + discovered writes (closes #3573)

The registered/discovered collapse in `listAllAgents` and `lookupDomain`
keyed on raw `agent_url` strings. A registered `https://agent.example/`
and a discovered `https://agent.example` would surface as two separate
entries instead of collapsing to the registered row.

Read-side (`server/src/federated-index.ts`): map keys + lookups now go
through the existing `canonicalizeAgentUrl` helper (lowercase, trailing
slash stripped) so case- and slash-only differences collapse.

Write-side (`recordAgentFromAdagentsJson`, `recordPublisherFromAgent`,
`updateAgentMetadata`): canonicalize before persisting so legacy
`discovered_agents` and `agent_publisher_authorizations` rows match the
shape the catalog-side already enforces. Forward-only — existing rows
are not migrated.

Tests pin slash collapse, host-case collapse, and that scheme mismatch
(http vs https) intentionally does NOT collapse.
