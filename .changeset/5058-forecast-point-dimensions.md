---
"adcontextprotocol": minor
---

Add dimensional and measurement-aware fields to delivery forecast points.

`ForecastPoint` now supports dimensional rows for geography, placement, device, platform, and audience planning via `dimensions`, letting sellers expose country and placement availability without splitting one sellable product into product-per-dimension variants. Forecast points also support `viewability` and `vendor_metric_values` using `ForecastRange` values so pre-buy forecasts can mirror delivery reporting while remaining independent of product `pricing_options`.
