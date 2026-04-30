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

**Scope.** An agent claiming `measurement` computes one or more
quantitative metrics about ad delivery, exposure, or effect
(impression verification, viewability, IVT, attention, brand lift,
incrementality, outcomes, emissions — vendors define the surface in
`metrics[]`). Returns metric definitions (this block), not pricing
or coverage (negotiated per buy via `measurement_terms`) and not
live values (returned per buy via `vendor_metric_values`). Same
mechanical model as `compliance_testing` and `webhook_signing`.

**No closed category enum.** An earlier draft included a closed 12-value
`measurement-category.json` enum and a required `category` field on
each metric. WG review pushed back on two grounds: (1) categories
overlap (e.g., `brand_safety` measurement vs. governance's
`content_standards`), making the boundary fuzzy; (2) without a
buyer-side discovery primitive consuming the field, the enum was
adding schema surface and drift risk without earning its keep.
Dropped: `category` field, `measurement-category.json` enum file,
`metric_categories[]` on brand.json (already removed in this PR's
prior commit). AAO and buyer agents normalize across catalogs from
`metric_id`, `description`, `standard_reference`, and
`accreditations[]` — all already structured. If a category facet
proves useful once #3613's discovery primitive lands, it can be
added back as an open vendor-asserted string with real query
patterns shaping the taxonomy.

**Schema additions.**

- `protocol/get-adcp-capabilities-response.json`: new `measurement`
  block with `metrics[]`. Each metric carries `metric_id` (required),
  plus optional `standard_reference`, `accreditations[]` (third-party
  certification list, distinct from `standard_reference` — accrediting
  body, optional cert ID, validity date, evidence URL), `unit`,
  `description`, `methodology_url`, and `methodology_version`.
  `additionalProperties: false` with explicit `ext` slot, matching
  the governance pattern. `uniqueItems: true` on `metrics[]` — duplicate
  `metric_id` within one agent's catalog is a conformance bug.

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
  `methodology_version`, the discovery-vs-settlement framing, an
  explicit Scope subsection ("what does claiming `measurement` mean?"),
  and an explicit "this is a discovery surface, not a rate card" callout
  (pricing/SLAs/coverage are negotiated per buy via
  `measurement_terms`).
- `docs/registry/index.mdx`: refines the measurement-vendor discovery
  section to reference the now-defined `measurement` capability block
  and forward-references the AAO index endpoint (#3613) and the
  buyer-agent direct-call docs (#3614).
- `core/reporting-capabilities.json`: updated `vendor_metrics[]` prose
  to point at `get_adcp_capabilities.measurement.metrics[]` as the
  canonical metric-definition source (was previously brand.json).

**Backwards compatibility.** All additions are optional and additive.
Sellers without measurement capability are unchanged; sellers with
measurement capability gain a structured catalog surface.

**WG review.** This is the protocol surface for measurement-vendor
capability declaration. Three independent expert reviews plus WG
pushback shaped this version: kept `measurement` in
`supported_protocols` per the protocol-in-development framing, added
`methodology_version`, added structured `accreditations[]` to separate
"implements a standard" from "third-party certified," dropped the
brand.json coarse-filter field, and dropped the closed category enum
in favor of letting real catalogs shape the taxonomy.

Closes #3612.
