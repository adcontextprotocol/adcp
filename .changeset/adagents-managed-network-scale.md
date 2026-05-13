---
---

feat(adagents): managed-network scale unlocks — bump authoritative-file size cap to 20 MB and add `publisher_domains[]` compact form to `publisher_properties` selectors.

**Why.** Managed-network authoritative files routinely need to enumerate thousands of publisher domains under the same authorization predicate (the typical WordPress/network case where every represented site is tagged `managed_network` and authorized to one sales agent). Two friction points were forcing partners toward either weakening the `managerdomain` fallback safety rule or listing N entries with identical selectors. Neither is necessary.

**What changes.**

1. `docs/governance/property/managed-networks.mdx`: validator response-size recommendation for authoritative `adagents.json` files moves from 5 MB to 20 MB. The general SSRF body cap in `docs/building/by-layer/L1/security.mdx` stays at 5 MB; the authoritative-file exception is now called out in both places.

2. `static/schemas/source/core/publisher-property-selector.json`: each selector variant (`all`, `by_id`, `by_tag`) now accepts a `publisher_domains: [...]` array as a mutually-exclusive alternative to the singular `publisher_domain`. Semantics are exactly "repeat this entry once per listed domain." Existing files using `publisher_domain` continue to validate unchanged.

3. `docs/governance/property/adagents.mdx`: Pattern 4 documents the compact form with a managed-network example. The `managerdomain`-fallback safety rule is reworded to enumerate the three valid authorization-path forms (`publisher_properties[].publisher_domain`, `publisher_properties[].publisher_domains[]`, `collections[].publisher_domain`) and to make clear that a `publisher_domain` reachable only through `properties[]` or through resolving a top-level `property_tags` selector does not satisfy explicit scoping.

**Follow-ups (out of scope for this PR).** Server consumers that walk `publisher_properties[*].publisher_domain` (`server/src/validator.ts`, `server/src/registry-sync/authorization-index.ts`, `server/src/federated-index.ts`, `server/src/adagents-manager.ts`, `server/src/routes/registry-api.ts`, `server/src/db/publisher-db.ts`, `server/src/db/federated-index-db.ts`, `server/src/types.ts`, `server/src/training-agent/product-factory.ts`) must learn to fan `publisher_domains[]` into N logical entries before the compact form is honored end-to-end. Filing a tracking issue.
