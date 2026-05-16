---
"adcontextprotocol": minor
---

Add `system-reference` primitive + `system-reference-fidelity` enum — strawman for decision D1 of the signal epistemic-model umbrella (#4616).

Adds two reusable schema primitives that future row-level RFCs (#4472 PBA audience_model, #4475 structured market identifiers, @lszczesiak's pending ID-graph RFC) can adopt without re-litigating the shape per-RFC:

- `core/system-reference.json` — the canonical `{system, id, version?, name?}` shape for a value defined against an external identity, taxonomy, geographic, or measurement system. `system` is intentionally an open string at the primitive level; per-use constraints live in consuming schemas.
- `enums/system-reference-fidelity.json` — `exact | approximated | unsupported` for deployment-side fidelity. Generalizes #4475's `market_fidelity` mechanism to all reference-system axes.

**Non-normative on its own.** Neither primitive is referenced by any existing schema in this PR. Adoption happens row-by-row in the follow-up RFCs (#4472 / #4475 / identity-substrate) against whatever D1 shape the WG settles on. If the WG counter-proposes a different shape, this PR is one file + one enum + this changeset — close and re-draft. No sunk cost.

Discussion: see https://github.com/adcontextprotocol/adcp/issues/4616
