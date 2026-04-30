---
"adcontextprotocol": minor
---

Add `measurement` capability block to `get_adcp_capabilities`. Closes
#3612 (the protocol surface piece of the per-metric catalog discovery
design from #3586). Unblocks #3613 (AAO crawler + index
implementation).

**Adds `measurement` to `supported_protocols` and `enums/adcp-protocol.json`.**
Measurement is a protocol-in-development. The capability block ships
now so measurement vendors can publish their catalogs and AAO can
crawl them; additional measurement tasks (reporting, attribution,
panel queries) and a baseline compliance storyboard land in
subsequent minors. Same as every other protocol — `creative` is in
`supported_protocols` AND has a capability block; same for
`governance`. Measurement follows the same model.

**Self-describing, parallels other agents.** Every AdCP agent type
publishes capabilities at the agent itself (sales / creative /
governance / brand / buying / signals / rights). Measurement now
follows the same pattern with a new `measurement` block whose
`metrics[]` array carries the per-metric catalog. The shape mirrors
`governance.property_features[]` (typed feature objects in an array)
including the `methodology_url` and `methodology_version` fields.

**No coarse filter on brand.json.** An earlier draft mirrored the
rights-agent precedent (`available_uses[]` / `right_types[]`) by
putting `metric_categories[]` on the brand.json measurement-agent
entry. WG review pushed back: rights types meaningfully partition who
you'd ever call (a podcast buyer never wants CTV rights), but
measurement categories are correlative — buyers typically want a
basket (viewability + IVT + brand_safety travel together), so a
coarse-filter on brand.json doesn't reliably narrow the agent set.
Capability blocks are queryable and cacheable; AAO crawls them on a
TTL anyway. Discovery happens against the canonical per-metric
catalog, not a brand.json shortcut.

**Schema additions.**

- `enums/measurement-category.json`: closed 12-value enum
  (`attention`, `viewability`, `invalid_traffic`, `brand_safety`,
  `brand_lift`, `incrementality`, `audience`, `reach`,
  `creative_quality`, `emissions`, `outcomes`, `other`). Includes
  the three categories surfaced as gaps in expert review:
  `viewability` (MRC Viewable Impression Measurement Guidelines —
  IAS, DV, MOAT), `invalid_traffic` (TAG/MRC IVT — HUMAN, DV, IAS),
  and `brand_safety` (GARM Brand Safety Floor + Suitability
  Framework). Used on each metric's `category` field.
- `protocol/get-adcp-capabilities-response.json`: new `measurement`
  block with `metrics[]`. Each metric carries `metric_id` and
  `category` (required), plus optional `standard_reference`,
  `accreditations[]` (third-party certification list, distinct from
  `standard_reference` — accrediting body, optional cert ID, validity
  date, evidence URL), `unit`, `description`, `methodology_url`, and
  `methodology_version`. `additionalProperties: false` with explicit
  `ext` slot, matching the governance pattern.

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
capability declaration. Three independent expert reviews plus WG
pushback shaped this version: kept `measurement` in
`supported_protocols` per the protocol-in-development framing, added
missing categories, added `methodology_version`, added structured
`accreditations[]` to separate "implements a standard" from
"third-party certified," and dropped the brand.json coarse-filter
field after partition-quality critique.

Closes #3612.
