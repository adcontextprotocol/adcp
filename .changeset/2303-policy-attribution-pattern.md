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

Tightens the `policy_id` descriptions across the four surfaces that carry the field to point at the new doc and replace placeholder cross-references:

- `core/feature-requirement.json` — buyer-authored threshold attribution
- `creative/creative-feature-result.json` — measurement attribution
- `property/validation-result.json` `features[].policy_id` — validation-result attribution (normalized to drop the registry-only `x-entity` since the same PolicyEntry-resolution logic applies as on the other two)
- `governance/check-governance-response.json` `findings[].policy_id` — adds the SHOULD-echo / MUST-NOT-invent contract so finding emitters see the rule from the schema side, not only from the doc

Back-links added from `docs/governance/policy-registry.mdx` (after the `registry:` prefix section) and `docs/governance/campaign/specification.mdx` (after the finding `policy_id` paragraph) so readers landing on existing pages find the attribution pattern.

No structural schema changes. All four `policy_id` fields existed before this PR; this is description-only normalization.

Closes #2303. Related: #4629 (3.2 RFC on top-down `applicable_policies` from buyer to seller — complementary direction).
