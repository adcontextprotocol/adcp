---
---

feat(adagents): endorse parent-file inline resolution of `publisher_properties` selectors when matched top-level `properties[]` carry a `publisher_domain` matching the selector's `publisher_domain` / `publisher_domains[]`.

**Why.** The production reference for the managed-network pattern (cafemedia.com, ~6,800 represented domains, 2.6 MB authoritative file with 6,843 inline `properties[]`) inlines properties — strict federation requires N HTTP fetches per authorization check, infeasible at managed-network scale. The previous "manager file MUST NOT inline copies of each represented publisher's properties" sentence at `docs/governance/property/adagents.mdx:498` mandated a resolution path no production consumer can take. Either the spec endorses the shape, or every conformant consumer reports cafemedia as broken — and the spec was the wrong answer.

**What changes** (`docs/governance/property/adagents.mdx`).

1. Replaced the "Fan-out resolution semantics" section under `publisher_properties` with a "Resolution paths" section that defines two paths:
   - **Federated (default)** — fetch each listed publisher's `adagents.json` and apply the selector. Unchanged from the prior wording; remains the trust root.
   - **Parent-file inline (managed-network optimization)** — MAY satisfy the selector from the parent file's top-level `properties[]` when every matched property carries a `publisher_domain` matching one of the selector's domains AND the selector's predicate (by_tag / by_id / all) is satisfied by the inline entry. `by_id` retains its singular-`publisher_domain`-only restriction; the compact `publisher_domains[]` form remains rejected for `by_id`.
2. Added a **safety rationale**: the trust anchor is `publisher_domain` on each property. The inline path preserves the "publisher whose inventory is being authorized must be explicitly named" invariant the [`managerdomain` fallback safety rule](#safety-rules-for-this-fallback) protects. A manager file cannot use inline resolution to authorize inventory for a publisher it doesn't list.
3. Added a **divergence rule**: if inline and federated resolutions disagree on the same `(publisher_domain, property_id)`, the federated result is authoritative. Consumers SHOULD log the divergence as a publisher-side data-integrity warning. Consumers that prefer strict federation MAY ignore the inline path entirely.
4. Added a **revocation rule under inline resolution**: inline path MUST honor `revoked_publisher_domains[]` on the parent file. Consumers that also resolve federated SHOULD cross-check the child's own `revoked_publisher_domains[]`; first match (parent or child) revokes.
5. Tightened the reachability invariant clause at `:244` to acknowledge `publisher_properties` selectors satisfied via parent-file inline (the property-level resolution path the managed-network-scale changeset established now extends to `publisher_properties` selectors, not just `property_ids` / `property_tags` on the agent entry).

**Schema** (`static/schemas/source/core/publisher-property-selector.json`).

Updated descriptions on the `selection_type: "all"` and `selection_type: "by_tag"` selectors to acknowledge the inline resolution path. No structural schema change — this is resolution-semantics clarification, not a new field shape. Existing files validate unchanged.

**SDK companions.** Consumers walking `publisher_properties` selectors should learn to consult parent-file `properties[]` matching the selector's `publisher_domain` / `publisher_domains[]` set before initiating per-child fetches. `_resolve_agent_properties` in `adcp-client-python` (gap at `adcp/adagents.py:909-959`) is the canonical site; tracking issue: adcontextprotocol/adcp-client-python (companion). The SDK fan-out bug (`publisher_domains[]` not being expanded into N per-domain resolutions) is orthogonal and lands separately.

**Companion ticket.** adcontextprotocol/adcp#4823 (AAO directory inverse-lookup) is a hard consumer of this rule — the directory's `properties_total` per publisher cannot be computed on managed-network-shape files without this resolution path settled.
