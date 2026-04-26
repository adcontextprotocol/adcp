---
---

Property-side readers in `federated-index-db.ts` and `property-db.ts` now
union the catalog-side `publishers` cache (PR 1 of #3177) with the legacy
`discovered_properties` and `discovered_publishers` tables. Crawl-sourced
properties that landed via the new writer path but missed the legacy
table — gatavo.com surfaced via Setupad escalation #218 — now appear on
the registry surfaces alongside legacy data.

Affects `hasValidAdagents`, `getPropertiesForDomain`,
`getDiscoveredPropertiesByDomain`, `getAllPropertiesForRegistry`, and
`getPropertyRegistryStats`. Authorization-side readers
(`getPropertiesForAgent`, `findAgentsForPropertyIdentifier`,
`getPublisherDomainsForAgent`) stay on legacy tables — those need the
authorization model decision and ship in PR 4b.

Legacy wins on collisions so callers that hold a
`discovered_properties.id` keep dereferencing it correctly during the
dual-write window. After PR 5 drops the legacy tables the legacy half
of the union goes away.

Refs #3177. Builds on #3195 / #3218 / #3221.
