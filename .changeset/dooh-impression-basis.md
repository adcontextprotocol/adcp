---
"adcontextprotocol": minor
---

Add the experimental DOOH impression basis (`media_buy.dooh_impression_basis`, RFC #7253). A DOOH `impressions` figure is `plays × audience multiplier`, and the new `enums/impression-estimation-basis.json` says where the multiplier comes from: `currency_measured`, `seller_modeled`, `sensor_measured` or `hybrid`.

- Delivery: `dooh_metrics` carries `impression_basis`, `audience_multiplier` and `basis_metric`, the `vendor_metric_values[]` row a sensor audience comes from. A row mixing tiers reports `impression_basis_breakdown[]` instead: at least two entries with distinct tiers, summing exactly to the row, and no row-level tier or multiplier. `venue_breakdown[]` rows may carry the tier and multiplier.
- Forecast: forecast points carry the same fields, outside `metrics`. A breakdown includes the fallback the seller expects.
- Discovery: `dooh_placement_attributes` carries the planned tier and multiplier.

`hybrid` is a seller model calibrated by the seller's own sensors, never a published currency nor a mix of tiers. All fields are optional. `ooh_metrics.estimation_basis` and the canonical forecast schemas are unchanged.
