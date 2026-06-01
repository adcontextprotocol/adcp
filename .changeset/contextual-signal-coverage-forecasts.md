---
"adcontextprotocol": minor
---

Add contextual signal coverage forecasts for signal discovery and product-relative availability planning.

Signals can now include optional `coverage_forecast` data with an explicit denominator, bucket overlap semantics, bucket completeness, and forecast points keyed by canonical signal dimensions. Forecast points gain a `signal` dimension kind and `coverage_rate` becomes a standard forecastable metric for availability breakdowns.

The feature is additive on the wire. Existing `coverage_percentage` remains available for compatibility, but richer planning should use `coverage_forecast` when sellers can disclose the denominator and value-level distribution.
