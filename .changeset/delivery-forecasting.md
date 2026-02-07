---
"adcontextprotocol": minor
---

Add delivery forecasting to the Media Buy protocol

- Add `DeliveryForecast` core type with metrics map, forecast method, currency, and budget-to-outcome curve
- Add `ForecastRange` core type (low/mid/high) for metric forecasts
- Add `ForecastPoint` core type for budget-to-outcome curve points with metrics map
- Add `forecast-method` enum (estimate, modeled, guaranteed)
- Add `forecastable-metric` enum defining standard metric vocabulary (audience_size, reach, impressions, clicks, spend, etc.)
- Add optional `forecast` field to `ProductAllocation`
- Add optional `forecast` field to `Proposal`
