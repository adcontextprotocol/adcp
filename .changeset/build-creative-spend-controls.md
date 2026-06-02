---
"adcontextprotocol": minor
---

spec(creative): add build_creative spend controls — `max_spend` cap + `mode: "estimate"` dry-run.

Follow-on from the persona/scenario review: fan-out (`max_creatives` × `max_variants`) and refinement produce many independently-billed leaves, and `per_unit` pricing gives a rate but not the unit count in advance — so an autonomous buyer had no protocol brake on spend. Both additions are optional and gated by a new `creative.supports_spend_controls` capability.

- **`mode: "estimate"`** (request) → new `BuildCreativeEstimate` response shape (6th `oneOf` member): a dry run that produces and bills nothing and returns a `cost_low`/`cost_high` band computed against the request's actual inputs, with `basis` (`fixed` exact / `estimated_units` / `cpm_deferred`) and an optional per-leaf breakdown. Advisory/non-binding in this revision.
- **`max_spend: { amount, currency }`** (request) → a hard per-call ceiling: the agent stops before the next leaf would exceed it and returns the partial `BuildCreativeVariantSuccess` with new `budget_status: "capped"` and an advisory `BUDGET_CAP_REACHED` in `errors[]` (every returned leaf real and billed; `items_returned` < `items_total`). First-leaf-over-cap → terminal `BUDGET_CAP_REACHED`; currency mismatch → `INVALID_REQUEST`.
- New error code **`BUDGET_CAP_REACHED`** (distinct from `BUDGET_EXCEEDED`/`BUDGET_EXHAUSTED`), in both `enumDescriptions` and `enumMetadata`.
- New capability **`creative.supports_spend_controls`** (default false).

Deferred to the working group (flagged, not omitted): whether an estimate can be **binding**, and whether a refinement-**loop** bound is a protocol-level session budget vs. a buyer responsibility (documented as buyer-side for now).
