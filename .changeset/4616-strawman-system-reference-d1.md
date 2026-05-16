---
"adcontextprotocol": minor
---

Add `system-reference` primitive + `system-reference-fidelity` enum + `system-reference-conversion` schema — strawman for decision D1 of the signal epistemic-model umbrella (#4616).

Adds three reusable schema primitives that future row-level RFCs (#4472 PBA audience_model, #4475 structured market identifiers, @lszczesiak's pending ID-graph RFC) can adopt without re-litigating the shape per-RFC:

- `core/system-reference.json` — the canonical `{system, value, version?, name?}` shape for a value defined against an external identity, taxonomy, geographic, or measurement system. `system` is intentionally an open string at the primitive level; per-use constraints live in consuming schemas. Field named `value` (not `id`) because the primitive is cross-axis: identity systems issue IDs, taxonomies issue values/terms, measurement systems issue methodology labels.
- `enums/system-reference-fidelity.json` — `exact | converted | approximated | unsupported` for deployment-side fidelity. `converted` covers the case where the destination uses a different system but the conversion is deterministic and lossless (e.g. Nielsen DMA → Comscore Market via crosswalk, UID2 → ID5 via identity graph). Generalizes #4475's `market_fidelity` mechanism to all reference-system axes.
- `core/system-reference-conversion.json` — `{from, to, method, method_provider?, method_details?}` structure describing how a deployment converts between systems. REQUIRED when fidelity is `converted`, OPTIONAL when `approximated`. `method` enum covers `id_graph | name_match | crosswalk | upscaled | inferred | projected | custom`. `method_provider?` surfaces vendor identity (e.g. `LiveRamp`, `ID5`, `IAB`) as an opaque-by-convention string so buyer agents can branch on well-known providers without parsing free-text.

**Non-normative on its own.** None of the primitives is referenced by any existing schema in this PR. Adoption happens row-by-row in the follow-up RFCs (#4472 / #4475 / identity-substrate) against whatever D1 shape the WG settles on. If the WG counter-proposes a different shape, this PR is three files + one changeset — close and re-draft. No sunk cost.

Discussion: see https://github.com/adcontextprotocol/adcp/issues/4616
