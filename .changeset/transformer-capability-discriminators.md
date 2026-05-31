---
"adcontextprotocol": minor
---

spec(creative): add pre-call discriminators for creative-transformer refinement retention and fan-out multiplicity.

Lets a buyer agent know — before sending — what a creative agent supports, instead of probing and handling failures. Additive and optional (all fields default to "unsupported / unbounded"), and the keystone the spend-control and conformance follow-ons build on.

- `get_adcp_capabilities` → `creative.refinable_retention_seconds` (integer): the guaranteed-minimum window a produced `build_variant_id` stays refinable. Replaces the prose-only "agent-defined window" with a machine-readable floor; omit to keep it agent-defined.
- `get_adcp_capabilities` → `creative.multiplicity` (object): `supports_catalog_fanout` + `max_creatives_limit`, `supports_variants` + `max_variants_limit`, and `variant_dimensions[]`. Over-limit `max_creatives`/`max_variants` are **clamped** to the ceilings (shortfall via `items_returned` < `items_total`), not rejected — consistent with `item_limit`'s "use the lesser" rule. Absent means no fan-out.
- `transformer.json` → optional `multiplicity` that narrows the agent-level object per transformer (ceilings ≤ agent, `variant_dimensions` ⊆ agent).
- `build_creative` docs note the clamp behavior on `max_creatives`/`max_variants`.
