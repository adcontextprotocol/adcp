---
"adcontextprotocol": minor
---

Add `system-reference` primitive + `system-reference-fidelity` enum + `system-reference-conversion` schema — strawman for decision D1 of the signal-AND-measurement epistemic-model umbrella (#4616).

Adds three reusable schema primitives that future row-level RFCs can adopt without re-litigating the shape per-RFC. After @bokelley's 2026-05-17 third-sibling framing (#4616 issuecomment-4470049814), D1 covers BOTH the signals track (#4472 PBA audience_model, @lszczesiak's pending ID-graph RFC) AND the measurement track (#2041 measurement source attribution, with #3885 / #3652 / #3877 as already-shipped publishing/authorization-half prior art) AND the product-level audience-construction-metadata row surfaced by @tescoboy on 2026-05-19.

**Per @bokelley's 2026-05-24 WG-acceptance comment (issuecomment-4526559566):** D1 is scoped to newly-modeled rows ONLY — it does NOT replace per-dimension schemas that already work (`geo_metros`, `geo_postal_areas`). The primitive shape alone does NOT create interoperability — consuming row-level schemas MUST constrain or document which `system` values are meaningful for that row.

**Round 5 normative tightening per @bokelley:**

1. **Version semantics REVERSED:** omitted `version` now means UNKNOWN / unpinned, NOT a wildcard. Exact equality requires `(system, value, version)` to all match for versioned systems. Row-level schemas MAY declare a system version-insensitive; otherwise omitted version is a buyer-decision point.
2. **`converted` fidelity tightened:** reserved for deterministic AND row-semantics-preserving mappings. Deterministic ≠ lossless preservation; sellers MUST NOT advertise `converted` when the conversion changes the row's meaningful semantics even if per-record mapping is deterministic.
3. **`upscaled` and `crosswalk` cautions:** `upscaled` should typically pair with `approximated` fidelity (undefined inverse → lost granularity); only `converted` if the row explicitly says granularity does not matter. Same caution for `crosswalk` — deterministic mapping is not automatically lossless semantic preservation.
4. **Interop caveat:** explicit note in `system-reference.json` description that the primitive alone doesn't create interop; row-level schemas MUST constrain or document recognized systems.

**Round 6 — ads.txt-pattern anchor added per the @bokelley / @lukasz-pubx / @SimonaNemes / Addie thread on #4616:**

5. **`method_doc_url?`** added to `system-reference-conversion.json` — optional URI pointing at an attested methodology document (vendor's identity-graph methodology page, published crosswalk specification, etc.). Picks up Addie's "collapse to a pointer" recommendation at the primitive layer so downstream row-level RFCs have a canonical place to anchor link-out fields. Strictly informational on the wire; buyer agents MAY follow the link out-of-band to verify but MUST NOT branch on its content programmatically. Description notes that consuming row-level schemas MAY require this field in their row's binding if methodology disclosure matters for the row.

Plus a description-only note that consuming row-level schemas adopting this primitive MAY add their own row-level `last_updated` field on the row itself to surface signal-record freshness (which IS verifiable, even if underlying methodology freshness isn't — per Simona's framing).

**Round 7 — value-prop sharpening + single-party scope clarification per @bokelley's 2026-05-25 line reviews on PR #4622:**

6. **`system-reference.json` description** rewritten to lead with the **union-axis value proposition**: the primitive earns its keep on rows where a single field can carry any of several external systems with the same comparator semantics (identity substrate, measurement source, PBA taxonomy). For single-axis rows where only one system applies, inline per-dimension fields remain simpler — the primitive is overhead. Explicitly does NOT replace working per-dimension schemas like `geo_metros` / `geo_postal_areas` / existing `ramp_id`. Per @bokelley's "RampID is defined elsewhere" comment: yes, and that's fine — the primitive's value is in giving union-axis rows ONE comparator vs. N parallel inline shapes, not in wrapping single-system rows that already have a shape.

7. **`system-reference-conversion.json` description** rewritten to clarify **single-party observable scope** per @bokelley's comment that real programmatic chains have multiple hops (publisher / SSP / DSP / agency / vendor) and no single party observes the full chain. The structure describes ONE party's observable conversion (signals seller's in-agent translation, measurement vendor's projection), NOT the multi-hop chain. Downstream conversions are out of scope, observed by other parties; the protocol intentionally doesn't pretend the seller can speak to them.

Plus naming note in the primitive description acknowledging @lukasz-pubx's `system → type` suggestion but keeping `system` — the connotation of "named external reference frame with its own lifecycle" is what we want vs. `type` which is overloaded across AdCP for general type discrimination on discriminated unions.

- `core/system-reference.json` — the canonical `{system, value, version?, name?}` shape for a value defined against an external identity, taxonomy, geographic, or measurement system. `system` is intentionally an open string at the primitive level; per-use constraints live in consuming schemas. Field named `value` (not `id`) because the primitive is cross-axis: identity systems issue IDs, taxonomies issue values/terms, measurement systems issue methodology labels.
- `enums/system-reference-fidelity.json` — `exact | converted | approximated | unsupported` for deployment-side fidelity. `converted` covers the case where the destination uses a different system but the conversion is deterministic and lossless (e.g. Nielsen DMA → Comscore Market via crosswalk, UID2 → ID5 via identity graph). Generalizes #4475's `market_fidelity` mechanism to all reference-system axes.
- `core/system-reference-conversion.json` — `{from, to, method, method_provider?, method_details?}` structure describing how a deployment converts between systems. REQUIRED when fidelity is `converted`, OPTIONAL when `approximated`. `method` enum covers `id_graph | name_match | crosswalk | upscaled | inferred | projected | custom`. **`inferred` vs `projected` sharpening per @SimonaNemes (#4616 issuecomment-4493606229):** `inferred` is **entity-level attribution** ("given clues, who/what is this entity?" — uncertainty in per-record correctness); `projected` is **population-level estimation** ("given this sample, what should we expect at scale?" — uncertainty in the estimate, not individuals). Same underlying data can drive both; the distinction is the level at which uncertainty operates. `method_provider?` surfaces vendor identity (e.g. `LiveRamp`, `ID5`, `IAB`) as an opaque-by-convention string so buyer agents can branch on well-known providers without parsing free-text.

**Non-normative on its own.** None of the primitives is referenced by any existing schema in this PR. Adoption happens row-by-row in the follow-up RFCs (#4472 / #4475 / identity-substrate) against whatever D1 shape the WG settles on. If the WG counter-proposes a different shape, this PR is three files + one changeset — close and re-draft. No sunk cost.

Discussion: see https://github.com/adcontextprotocol/adcp/issues/4616
