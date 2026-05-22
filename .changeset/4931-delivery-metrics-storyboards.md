---
"adcontextprotocol": patch
---

Add 3.1 compliance storyboards for `reach_window` (cumulative/period/rolling) and `viewability.viewed_seconds` in delivery reporting (closes #4931).

**Storyboard additions:**

`reach_buy_flow.yaml` gains four new phases after the existing `reach_delivery` phase:
- `reach_window_cumulative` — injects a delivery row with `reach_window.kind: cumulative` (no `period` field) and verifies the seller surfaces the window semantics.
- `reach_window_period` — injects with `kind: period` + `period: {interval:1, unit:"days"}` and asserts both `kind` and `period` present on the delivery row.
- `reach_window_rolling` — injects with `kind: rolling` + `period: {interval:7, unit:"days"}` and asserts both fields present.
- `reach_window_absent_advisory` — injects a reach row without `reach_window`; issues a `severity: advisory` + `permanent_advisory` check (schema-valid SHOULD, not MUST — buyers warned but sellers not failed; promotion to required is a 4.0 concern).

`delivery_reporting.yaml` gains a new `viewability_delivery` phase that:
- Creates a media buy for a viewability-capable vCPM video product.
- Injects a full viewability block (`measurable_impressions`, `viewable_impressions`, `viewable_rate`, `viewed_seconds: 4.3`, `standard: "mrc"`).
- Asserts `viewability.viewed_seconds`, `viewability.measurable_impressions`, and `viewability.standard` present on the delivery row.

**Schema addition (`comply-test-controller-request.json`):**

`params` block gains four new named properties for `simulate_delivery`:
- `reach` (number) and `frequency` (number) — formally declared (previously used in `reach_buy_flow.yaml` but undeclared).
- `reach_window` (object: `{kind, period?}`) — typed declaration so controller implementers have a schema-grounded contract for injecting window semantics.
- `viewability` (object: `{measurable_impressions?, viewable_impressions?, viewable_rate?, viewed_seconds?, standard?}`) — typed declaration for the viewability block.

All additions are additive (`additionalProperties: true` was already set on `params`); existing controller implementations that ignore unknown params are unaffected. Conformant 3.1 implementations that populate `reach_window` and `viewability` on delivery responses will pass the new assertions.
