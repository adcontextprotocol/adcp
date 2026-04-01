---
"adcontextprotocol": minor
---

Support availability forecasts for guaranteed and direct-sold inventory

- Make `budget` optional on `ForecastPoint` — when omitted, the point represents total available inventory for the requested targeting and dates
- Add `availability` value to `forecast-range-unit` enum for forecasts where metrics express what exists, not what a given spend level buys
- Guaranteed products now include availability forecasts with `metrics.spend` expressing estimated cost
- Update delivery forecast documentation with availability forecast examples and buyer-side underdelivery calculation guidance
