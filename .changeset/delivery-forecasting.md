---
"adcontextprotocol": minor
---

Add delivery forecasting to the Media Buy protocol

- Add `DeliveryForecast` core type with budget curve, forecast method, currency, and measurement context
- Add `ForecastRange` core type (low/mid/high) for metric forecasts
- Add `ForecastPoint` core type — pairs a budget level with metric ranges; single point is a standard forecast, multiple points form a budget curve
- Add `forecast-method` enum (estimate, modeled, guaranteed)
- Add `forecastable-metric` enum defining standard metric vocabulary (audience_size, reach, impressions, clicks, spend, etc.)
- Add `demographic-system` enum (nielsen, barb, agf, oztam, mediametrie, custom) for GRP demographic notation
- Add `reach-unit` enum (individuals, households, devices, accounts, cookies, custom) for cross-channel reach comparison
- Add `demographic_system` to CPP pricing option parameters
- Add optional `forecast` field to `ProductAllocation`
- Add optional `forecast` field to `Proposal`
