---
"adcontextprotocol": minor
---

Add an optional `metric_id` to performance standards (`core/performance-standard.json`, `core/canonical-performance-standard.json`, and the canonical `required_performance_standards` discovery filter). It names which of the standard's vendor's metrics carries the value judged against `threshold`, in the vendor's own vocabulary.

When present, the standard is judged only against `vendor_metric_values[]` entries with the same `vendor` and `metric_id`; the vendor's other metrics are not evidence for it. The judged value is a rate on `threshold`'s 0–1 scale, and a value outside 0–1 is not evidence and MUST NOT be converted. A package whose standard carries `metric_id` SHOULD also carry a matching vendor-scope `committed_metrics` entry. `metric_id` is allowed only for `ivt`, `brand_safety`, and `attention_score`; `viewability` and `completion_rate` keep their delivery scalars.

When absent on an `ivt`, `brand_safety`, or `attention_score` standard, parties MUST NOT infer which vendor metric carries it and treat the standard as not judged from `vendor_metric_values`. Additive: 3.2 receivers reject the field on canonical surfaces (`additionalProperties: false`), so senders omit it toward 3.2 counterparties.
