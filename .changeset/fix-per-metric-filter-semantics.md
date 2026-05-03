---
---

fix(registry): tighten metric_id+accreditation filter to per-metric semantics

When both `metric_id` and `accreditation` are passed to `/api/registry/agents`,
the same `metrics[]` element must now satisfy both constraints simultaneously.
Previously, independent JSONB containment predicates allowed loose cross-metric
matching (a vendor with `attention_units` on one metric and MRC accreditation on
a different metric would falsely match). Cross-product AND semantics apply for
multiple values: every `(metric_id, accreditation)` pair requires a dedicated
metrics element.

Also documents the combined-filter semantics in `docs/registry/index.mdx`.
