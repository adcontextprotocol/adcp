---
---

docs(creative): add inline Delivery Metrics field table to get_creative_delivery

Adds a curated "Delivery Metrics fields" sub-section to the `get_creative_delivery`
task reference, covering the commonly-used fields available on both `creative.totals`
and each `variant` entry. Includes explicit callouts that spend-derived metrics
(`roas`, `cost_per_acquisition`) appear at `totals` only (not inside `by_event_type`)
and that engagement fields are platform-conditional. Links to the full
`delivery-metrics` schema for the complete field list. Updates the Variant Object
"Standard metrics" row to cross-reference the new section. Closes #4362.
