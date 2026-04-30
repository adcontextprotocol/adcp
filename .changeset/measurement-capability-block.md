---
"adcontextprotocol": minor
---

Add `measurement` capability block to `get_adcp_capabilities` and
optional `metric_categories[]` to `brand.json` measurement-agent
entries. Closes #3612 (the protocol surface piece of the per-metric
catalog discovery design from #3586). Unblocks #3613 (AAO crawler +
index implementation).

**Modeled as a capability block, not a `supported_protocols` value.**
Measurement agents have one surface — this catalog — not a tool-set
with mandatory tasks the way `media_buy` / `signals` / `governance` do.
Following the `compliance_testing` / `webhook_signing` precedent: the
presence of the capability block is the support signal, no
companion `supported_protocols` enum value or compliance storyboard
required.

**Self-describing, parallels other agents.** Every AdCP agent type
publishes capabilities at the agent itself (sales / creative /
governance / brand / buying / signals / rights). Measurement now
follows the same pattern with a new `measurement` block whose
`metrics[]` array carries the per-metric catalog. The shape mirrors
`governance.property_features[]` (typed feature objects in an array)
including the `methodology_url` and `methodology_version` fields.

**Optional `metric_categories[]` on brand.json** parallels rights
agents' `available_uses[]` / `right_types[]` — the one precedent in
AdCP for putting *coarse-filter* metadata on `brand.json` for cheap
directory queries. AAO can pre-filter measurement agents by category
without crawling each one. The full catalog stays at the agent
(canonical); brand.json carries only the category list.

**Schema additions.**

- `enums/measurement-category.json`: closed 12-value enum
  (`attention`, `viewability`, `invalid_traffic`, `brand_safety`,
  `brand_lift`, `incrementality`, `audience`, `reach`,
  `creative_quality`, `emissions`, `outcomes`, `other`). Includes
  the three categories surfaced as gaps in expert review:
  `viewability` (MRC Viewable Impression Measurement Guidelines —
  IAS, DV, MOAT), `invalid_traffic` (TAG/MRC IVT — HUMAN, DV, IAS),
  and `brand_safety` (GARM Brand Safety Floor + Suitability
  Framework).
- `protocol/get-adcp-capabilities-response.json`: new `measurement`
  block with `metrics[]`. Each metric carries `metric_id` and
  `category` (required), plus optional `standard_reference`,
  `accreditations[]` (third-party certification list, distinct from
  `standard_reference` — accrediting body, optional cert ID, validity
  date, evidence URL), `unit`, `description`, `methodology_url`, and
  `methodology_version`. `additionalProperties: false` with explicit
  `ext` slot, matching the governance pattern.
- `brand.json` `brand_agent_entry`: optional `metric_categories[]`
  array referencing the new enum.

**Why `accreditations[]` is separate from `standard_reference`.**
A metric can implement a published standard (URL points at the spec)
without holding independent third-party accreditation. Buyers asking
"is this MRC-accredited?" need a structured answer that survives URL
parsing — every vendor pasting the same MRC URL whether accredited
or not gives a false signal of comparability. The split surfaces
the distinction at the schema layer.

**Doc updates.**

- `docs/protocol/get_adcp_capabilities.mdx`: new `measurement` section
  with field table, response example showing `accreditations[]` and
  `methodology_version`, the discovery-vs-settlement framing, and an
  explicit "this is a discovery surface, not a rate card" callout
  (pricing/SLAs/coverage are negotiated per buy via
  `measurement_terms`).
- `docs/registry/index.mdx`: refines the measurement-vendor discovery
  section to reference the now-defined `measurement` capability block
  and forward-references the AAO index endpoint (#3613) and the
  buyer-agent direct-call docs (#3614).

**Backwards compatibility.** All additions are optional and additive.
Sellers without measurement capability are unchanged; sellers with
measurement capability gain a structured catalog surface.

**WG review.** This is the protocol surface for measurement-vendor
capability declaration. Hybrid design (live capability response +
optional brand.json coarse filter) reached via #3586 / #3612
discussion. Three independent expert reviews shaped this version:
moved measurement out of `supported_protocols` (capability-block
pattern), added missing categories, added `methodology_version`, and
added structured `accreditations[]` to separate "implements a
standard" from "third-party certified."

Closes #3612.
