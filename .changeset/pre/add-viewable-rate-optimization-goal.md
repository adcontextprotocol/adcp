---
"adcontextprotocol": minor
---

Add `viewable_rate` as a `kind: "metric"` optimization goal, closing a schema omission: the optimization docs already described viewability as a standard metric goal, but neither goal schema accepted it. A `viewable_rate` goal requires a viewability `standard` (`mrc` or `groupm`), takes an optional measurement `vendor`, and bounds `threshold_rate.value` to at most 1. Products and seller capabilities can advertise `viewable_rate` in their supported optimization metrics, and products can declare `metric_optimization.supported_viewability_standards`. When a package carries both a `viewable_rate` goal and a viewability performance standard, a lower goal never relaxes the standard.
