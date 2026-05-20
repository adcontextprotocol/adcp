---
"adcontextprotocol": minor
---

feat(adagents): permit parent-file inline resolution of `publisher_properties` selectors when matched top-level properties carry a `publisher_domain` matching the selector's addressed domains.

Federated per-child resolution remains the default and the trust root. Inline is a per-domain optimization: consumers SHOULD prefer it when the parent file's `properties[]` contains entries whose `publisher_domain` matches the selector's `publisher_domains[]` and whose tags satisfy the predicate. Production managed-network deployments inline properties (~6,800 represented domains in a single authoritative file) — strict federation requires N HTTP fetches per authorization check, infeasible at scale.

`by_id` selectors remain federated-only. Property IDs are publisher-scoped; fanning a fixed ID set across multiple publishers would silently authorize inventory at unintended publishers.

Divergence rule: if inline and federated resolutions disagree on the same `(publisher_domain, property_id)`, federated wins. Revocation: inline path MUST honor parent-file `revoked_publisher_domains[]`; consumers SHOULD also cross-check the child's own when federated.

Trust invariant: every matched inline property MUST carry an explicit `publisher_domain`. Properties missing this field MUST NOT be included in the inline resolution result set.

Companion: adcp-client-python needs a matching SDK update to fan `publisher_domains[]` into per-domain resolution and consult parent-file inline first when matching properties carry `publisher_domain`. Tracked in adcontextprotocol/adcp-client-python#746.
