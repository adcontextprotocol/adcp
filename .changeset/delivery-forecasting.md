---
"adcontextprotocol": minor
---

Add delivery forecasting to the Media Buy protocol

- Add `DeliveryForecast` core type with metric ranges, confidence level, currency, and budget-to-outcome curve
- Add `ForecastRange` core type (low/mid/high) for metric forecasts
- Add `ForecastPoint` core type for budget-to-outcome curve points
- Add `forecast-confidence` enum (estimate, modeled, guaranteed)
- Add optional `forecast` field to `ProductAllocation`
- Add optional `forecast` field to `Proposal`
