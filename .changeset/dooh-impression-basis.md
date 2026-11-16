---
"adcontextprotocol": minor
---

Add the experimental DOOH impression basis (`media_buy.dooh_impression_basis`, RFC #7253). A DOOH `impressions` figure is `plays × audience multiplier`, and the new `enums/impression-estimation-basis.json` says where the multiplier comes from: `currency_measured`, `seller_modeled`, `sensor_measured` or `hybrid`.

- Delivery: `dooh_metrics` carries `impression_basis`, `audience_multiplier` and `basis_metric`, the `vendor_metric_values[]` row a sensor audience comes from. A row mixing tiers reports `impression_basis_breakdown[]` instead: at least two entries with distinct tiers, summing exactly to the row, and no row-level tier or multiplier. `venue_breakdown[]` rows may carry the tier and multiplier.
- Forecast: forecast points, canonical ones included, carry `impression_basis`, `audience_multiplier` and `impression_basis_breakdown[]`, outside `metrics`. A breakdown includes the fallback the seller expects.
- Discovery: `dooh_placement_attributes` carries the planned tier and multiplier.

`impressions` is authoritative and the multiplier is `impressions / plays`, rounded. `hybrid` is a seller model calibrated by sensors on the seller's own screens, never a published currency nor a mix of tiers. All fields are optional. `ooh_metrics.estimation_basis` is unchanged.
