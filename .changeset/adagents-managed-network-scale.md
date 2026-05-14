---
---

feat(adagents): managed-network scale package — `publisher_domains[]` compact form, two-tier size cap, conditional-refresh + revocation lifecycle.

**Why.** Managed-network authoritative files routinely need to enumerate thousands of publisher domains under the same authorization predicate (the typical WordPress/network case where every represented site is tagged `managed_network` and authorized to one sales agent). Two friction points were forcing partners toward either weakening the `managerdomain` fallback safety rule or listing N entries with identical selectors, and the original 5 MB cap was an arbitrary block at scale. This changeset closes those gaps and adds the operational primitives (conditional refresh, per-publisher revocation) the buy side needs to consume the result.

**What changes.**

1. **`publisher_domains[]` compact form** on `publisher_properties` selectors (`static/schemas/source/core/publisher-property-selector.json`). Each `all` and `by_tag` selector now accepts a `publisher_domains: [...]` array as a mutually-exclusive alternative to the singular `publisher_domain` (XOR enforced via `allOf` + `not` + `anyOf`). The `by_id` selector intentionally does NOT accept the compact form — property IDs are publisher-scoped and fanning a fixed ID set across publishers would silently authorize wrong inventory. Existing files using `publisher_domain` validate unchanged.

2. **Compact form is adagents-only** (`static/schemas/source/core/product.json`). Products MUST use the singular `publisher_domain` form on each selector entry; the compact form is rejected on product selectors so DSP-side traffic-and-pricing flatteners can always treat each entry as exactly one publisher.

3. **Two-tier size cap** (`docs/governance/property/managed-networks.mdx`, `docs/building/by-layer/L1/security.mdx`). Pointer files at `/.well-known/adagents.json` keep the 5 MB general SSRF cap. Authoritative files reached by dereferencing `authoritative_location` (second hop) use a recommended 20 MB cap because that origin has explicitly opted in to fanning out across a publisher network.

4. **Conditional refresh** (`docs/governance/property/managed-networks.mdx`). Authoritative origins SHOULD emit `ETag`/`Last-Modified`; validators SHOULD send `If-None-Match`/`If-Modified-Since` and treat `304 Not Modified` as a successful cache-lifetime refresh. New optional per-`authorized_agents[]` `last_updated` field on `adagents.json` enables partial-walk indexing. Without conditional requests, a network with 3,000 publishers churning weekly forces every validator to download 20 MB per refresh.

5. **Publisher revocation lifecycle** (`docs/governance/property/managed-networks.mdx`, `static/schemas/source/adagents.json`). New top-level `revoked_publisher_domains[]` block with `publisher_domain` + `revoked_at` + optional `reason`. Validators MUST treat any listed domain as no-longer-authorized regardless of where else it appears in the file. Lets per-publisher revocations propagate on the next refresh instead of waiting for the 7-day cache cap.

6. **Fan-out resolution semantics** (`docs/governance/property/adagents.mdx`). Normative paragraph specifying consumer-side resolution, per-domain independent reachability, and partial-resolution behavior (one unreachable publisher does not poison the rest of a compact entry).

7. **Fallback safety rule clarified** (`docs/governance/property/adagents.mdx`). Reworded to enumerate two valid reachability paths: per-agent (`publisher_properties[].publisher_domain` / `.publisher_domains[]` / `collections[].publisher_domain`) and property-level (agent's `property_ids` / `property_tags` resolving to a top-level `properties[]` entry whose `publisher_domain` matches). The property-level path matches the in-tree reference implementation at `server/src/adagents-manager.ts:380-447` (Mediavine production shape). Implicit scoping — authorization that never names the publisher in a `publisher_domain` field — is what's rejected.

8. **Cross-doc plumbing.** `docs/governance/property/managed-networks.mdx` now points to the compact form near the file-efficiency section; `security.mdx` cross-references the authoritative-file size-cap exception.

**Follow-ups.** SDK consumers walking `publisher_properties[*].publisher_domain` must learn to fan `publisher_domains[]` into N logical entries and to honor `revoked_publisher_domains[]`. Tracking issues filed: adcp-client#1737 (TS), adcp-client-python#729 (Py), adcp-sdk-java#5 (Java), adcp-go#120 (Go). Server-side: `server/src/validator.ts`, `server/src/registry-sync/authorization-index.ts`, `server/src/federated-index.ts`, `server/src/adagents-manager.ts`, `server/src/routes/registry-api.ts`, `server/src/db/publisher-db.ts`, `server/src/db/federated-index-db.ts`, `server/src/types.ts`, `server/src/training-agent/product-factory.ts`.
