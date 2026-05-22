---
---

fix(adagents): server-side fan-out for `publisher_domains[]` + `revoked_publisher_domains[]` precedence

Closes the in-tree server portion of #4506 — the catalog projection writer's two missing behaviors from the PR #4504 spec additions.

**1. Compact-form fan-out in `publisher-db.projectAuthorizationToCatalog`.** The writer previously checked only `publisher_properties[].publisher_domain` (singular) and refused as "cross-publisher" if missing. With the compact form, a managed-network manifest authorizes the publisher via `publisher_domains[]` (plural) and the source publisher_domain appears inside that array. The writer now accepts a selector if **either** the singular `publisher_domain` matches the source **or** the source appears in the compact `publisher_domains[]` list. Same projection semantics as the singular form — no special-case downstream.

**2. `revoked_publisher_domains[]` precedence in `upsertAdagentsCache`.** When a manifest's top-level `revoked_publisher_domains[]` lists the source publisher domain, the writer now skips **all** property and authorization projection for that source. The `publishers` row is still upserted (cache reflects the manifest verbatim) but no `catalog_properties` or `catalog_agent_authorizations` rows land. Revocation takes precedence over any other appearance of the publisher in `publisher_properties[]` or top-level `properties[]`, matching the spec MUST.

**Type model**: added `publisher_domains?: string[]` to the internal `AdagentsAuthorizedAgent.publisher_properties[]` element type. Tolerant of malformed input — every consumer path uses runtime `typeof`/`Array.isArray` guards before string operations.

**Tests** (integration, against a real postgres): two compact-form cases (acceptance when source listed, refusal when not) plus two `revoked_publisher_domains[]` cases (revocation wins; unrelated revocation entry doesn't block projection). Lives in `server/tests/integration/registry-catalog-agent-auth-writer.test.ts`.

**Out of scope (tracked in #4506)**: in-memory `AuthorizationIndex` revocation propagation (currently event-driven — would need crawler-side emission of `authorization.revoked` events for each entry in `revoked_publisher_domains[]`), per-`authorized_agents[]` `last_updated` partial-walk indexing (advisory optimization), and `federated-index-db` SQL-layer changes (only invoked from product paths, which #4508 restricted to singular form).
