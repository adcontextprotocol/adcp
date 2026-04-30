---
"adcontextprotocol": minor
---

Add `plays` scalar to `delivery-metrics.json` and `available-metric.json` —
closes a forecast↔delivery asymmetry where `plays` was declared as a
forecastable metric (`forecastable-metric.json:23`, `forecast-point.json:38`)
but absent from delivery reporting. Closes #3516.

**The shape.** Top-level `type: number, minimum: 0`. Description
cross-references the forecast-side definition and explicitly distinguishes
from `dooh_metrics.loop_plays` (per-screen rotation count) and
`impressions` (multiplied audience figure). Used for DOOH and broadcast
inventory where buyers reconcile against forecast `plays`.

Why top-level (Option A) over nesting in `dooh_metrics` (Option B):

- Forecast side declares `plays` at the same level as `impressions` /
  `views` (top-level on `forecast-point`); reconciliation pairs cleanly
  when the delivery-side field mirrors that placement
- Used for broadcast inventory too (not DOOH-only), so confining to
  `dooh_metrics` would force a separate field for non-DOOH plays
- Matches the type convention of other top-level count scalars
  (`type: number`, not the `integer` used inside `dooh_metrics`)

**Test plan** — `build:schemas`, `test:schemas`, `test:examples`,
`typecheck` all green.

Closes #3516.
