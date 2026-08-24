---
"adcontextprotocol": minor
---

Fix the vendor-scope qualifier on `delivery-metric-aggregate` (previously a closed object with no properties, so only `{}` could validate) and add the optional 5-key qualifier to the vendor branches of `committed-metric`, `missing-metric`, `package-request` committed_metrics, the performance-feedback surfaces, and — critically — the `vendor-metric-value` delivery carrier, whose row uniqueness re-keys from `(vendor, metric_id)` to `(vendor, metric_id, qualifier)` so a vendor metric committed under two attribution windows is representable in the delivery report. Container tokens (`viewability`, `quartile_data`, `dooh_metrics`) are barred as value-bearing aggregate `metric_id`s — leaf identities exist for that. Matches what `canonical-reporting-commitment` already allows; a qualifier parity contract test now enforces an identical closed key set across every hand-maintained copy.
