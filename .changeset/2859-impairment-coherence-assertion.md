---
"adcontextprotocol": minor
---

`impairment.coherence` — cross-resource invariant tying `media_buy.impairments[]` to the underlying resource state.

**Rule (lifecycle.mdx § Compliance — expanded)**
- **Forward.** Every entry in a buy's `impairments[]` MUST reference a resource whose current status is an offline state (`audience: suspended`, `creative: rejected`, `catalog_item: withdrawn`, `event_source: insufficient`, depublished property). Stale impairments on the buy fail the check.
- **Inverse.** Any resource in an offline state referenced by a non-terminal buy MUST appear in that buy's `impairments[]`, and the buy's `health` MUST be `impaired` whenever `impairments[]` is non-empty (and `ok` when empty). Stale resources off the buy fail the check.
- **Out of scope.** Terminal-status buys (`completed`, `canceled`, `rejected`) MAY remain unreported; materiality is schema-enforced via `impairment.json#/properties/package_ids` `minItems: 1` (#2855) and is not re-checked here.

**Wiring** (`static/compliance/source/specialisms/*/index.yaml`)
- Added `impairment.coherence` alongside the existing `status.monotonic` invariant on the five specialisms whose storyboards exercise resource transitions that can drive impairments:
  - `audience-sync` — audience `suspended`
  - `sales-catalog-driven` — catalog_item `withdrawn`
  - `creative-ad-server`, `creative-template`, `creative-generative` — creative `rejected`
- Each specialism's invariants block now carries an inline comment describing the cross-resource rule and the not-applicable grading path until #2860 lands the storyboard exercise.

**Docs**
- `docs/media-buy/media-buys/lifecycle.mdx § Compliance` — replaces the two-bullet sketch with the precise forward/inverse rules, out-of-scope carve-outs, and the relationship to `status.monotonic`.
- `docs/building/verification/compliance-catalog.mdx` — new **Cross-resource invariants** section catalogs `status.monotonic` and `impairment.coherence` with scope and per-specialism applicability.

Complements `status.monotonic` (single-resource lifecycle observation). Grades `not_applicable` until [#2860](https://github.com/adcontextprotocol/adcp/issues/2860) wires the cross-resource exercise into the relevant specialism storyboards.

Additive — new invariant on existing specialisms, no breaking changes. Runner support for the `impairment.coherence` invariant ID is the adcp-client follow-up (mirrors the `status.monotonic` rollout pattern from #2664).

Closes #2859.
