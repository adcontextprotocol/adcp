---
"adcontextprotocol": major
---

Remove `estimated_exposures` from Product, replace with optional `forecast`

- Remove the unitless `estimated_exposures` integer field from the Product schema
- Add optional `forecast` field using the existing `DeliveryForecast` type, giving buyers structured delivery estimates with time periods, metric ranges, and methodology context during product discovery
