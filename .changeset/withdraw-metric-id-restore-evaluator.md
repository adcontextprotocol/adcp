---
"adcontextprotocol": minor
---

Withdraw `metric_id` from performance standards and restore the `evaluator` value of `x-entity-types` as deprecated (adcp#8501, entries 6 and 26). A minor release doesn't change what a signed term means or remove an existing enum value (DR-0036).

**`metric_id` on performance standards (#8436, `3.3.0-beta.1` through `3.3.0-beta.5`).** Removed from `core/canonical-performance-standard.json`, `core/performance-standard.json` and the `required_performance_standards` entries of `core/product-offer-filters.json`, with the guard that kept it off `viewability` and `completion_rate`. The three schemas and the `performance-standard-metric` description return to their 3.2.8 form. The field selects which vendor value decides a signed performance standard, so a 3.2 buyer would read the same standard differently. It is planned for 4.0 as `performance_standard_metric_id_required_in_4_0` in the 4.0 compatibility registry, which keeps the design.

**`evaluator` in `x-entity-types`.** Restored with its definition and listed in `x-deprecated-enum-values`. The 3.2.8 versioning page says "Existing values are never removed or renamed." The removal of the experimental `evaluator_id` source form (#8045) stands, so no 3.3 field carries the value.

These are beta-to-beta changes, not changes to a stable release: 3.2.8 has no `metric_id` on performance standards. The betas are immutable, so a seller or SDK built from a beta bundle stops sending and emitting the field. `scripts/lint-additive-minor-baseline.json` drops the two rows these entries covered and is now empty.
