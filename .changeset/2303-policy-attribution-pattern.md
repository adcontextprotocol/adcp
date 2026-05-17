---
---

docs(governance): policy attribution pattern + tighten reserved-field descriptions

The `policy_id` field on `core/feature-requirement.json` and `creative/creative-feature-result.json` was reserved in 3.0 with placeholder descriptions ("populated by producers in 3.1, see issue #2303"). 3.1 formalizes the contract.

Adds [`docs/governance/policy-attribution.mdx`](https://docs.adcontextprotocol.org/docs/governance/policy-attribution) documenting:

- The split between **plan-level `policy_ids[]`** (declares applicability to the buyer's governance agent) and **filter-level `policy_id`** (declares authorship of a specific mechanism-level threshold or measurement).
- When producers SHOULD vs SHOULD NOT populate `policy_id` — only when the mechanism exists because of a specific authorizing policy, not when a policy merely applies.
- The round-trip via governance findings: buyer authors `feature_requirements[i].policy_id` → sales agent calls `check_governance` → buyer's governance agent emits a finding echoing the same `policy_id` → audit trail closes the loop.
- Worked examples for UK HFSS (buyer-encoded threshold), US COPPA (delegated to seller's `registry:` feature), and creative measurement attribution.
- Explicit non-scope: audience-selector and targeting overlays do NOT carry `policy_id` — those should be derived from plan-level declarations, not hand-authored with policy authority.

Tightens the `policy_id` descriptions on both schemas to point at the new doc page and replace the placeholder "see issue #2303" references. No structural schema changes; the field was already reserved with `additionalProperties: false` permitting populated values in 3.1+.

Closes #2303. Related: #4629 (3.2 RFC on top-down `applicable_policies` from buyer to seller — complementary direction).
