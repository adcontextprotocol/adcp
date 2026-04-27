---
---

Reader cutover for property-registry agent/authorization unification (PR 4b-readers
of #3177). Nine federated-index/property-db readers now UNION over the legacy
`agent_publisher_authorizations` / `agent_property_authorizations` /
`discovered_properties` graph and the catalog-side
`v_effective_agent_authorizations` view, with legacy winning on collision
during the dual-read window.

Functions cut over:
- `getAgentsForDomain`
- `getDomainsForAgent`
- `bulkGetFirstAuthForAgents`
- `getAllAgentDomainPairs`
- `getPropertiesForAgent`
- `getPublisherDomainsForAgent`
- `findAgentsForPropertyIdentifier`
- `getAuthorizationSource` (drives `validateAgentForProduct`)
- `isPropertyAuthorizedForAgent`
- `PropertyDatabase.getAgentAuthorizationsForDomain`

The `validateSelector*` and `getAuthorizedProperties*` helpers are derived
in-memory from the unioned property reads so the catalog/legacy union
shape is materialized in exactly one place per relation.

Catalog `evidence` values are coerced to the legacy `source` vocabulary
('override' → 'adagents_json' as moderator-authoritative; 'community' →
'agent_claim' as lower trust) so the API contract for source field
remains 'adagents_json' | 'agent_claim' | 'none'.

Override layer (suppress / add) flows through `v_effective_agent_authorizations`
unchanged: suppress hides matching base rows, add surfaces phantom rows
with publisher_domain set to the override's host_domain.

Writers (`upsertAuthorization`, `upsertAgentPropertyAuthorization`) and
cleanup ops (`deleteExpired`, `clearAll`, `getStats`) remain legacy-only —
PR 5 will collapse those after the dual-write window closes.

Refs #3177. Builds on #3244 (property-side reader cutover), #3274 (schema),
#3314 (writer extension), #3312 (change-feed authorization events).
