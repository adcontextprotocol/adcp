---
"adcontextprotocol": minor
---

Add typed `details` for `PRODUCT_UNAVAILABLE`, so a buyer whose packages ask for more than a seller can deliver learns how much it can buy (adcp#9184). New `error-details/product-unavailable.json` (`x-added-in: 4.0.0`) carries `packages[]`, one entry per package:

- `package_field`, `package_id`, and `product_id` identify the package; every entry carries `package_field`, `package_id`, or both. `package_field` is a JSONPath-lite locator of its row: `purchases[i]`, `packages[i]`, or `new_packages[i]` in the request, or `commercial_terms.purchases[i]` in the committed proposal on `accept_proposal`.
- `unit` is a delivery unit named as in forecasts (`impressions`, `viewable_impressions`, `clicks`, and so on), never money. `requested` is what the package asks for in `unit`: its own goal, or, for a fixed allocation at a positive `fixed_price`, the quantity its budget buys. It is never derived from a floor, price guidance, a bid, a zero price, or a seller-optimized package ceiling. Counts are whole numbers except `grps`.
- `available` is the advisory forecast range. `bookable` is the most the seller will accept right now, which may exceed the forecast.
- `max_budget` is the budget that fits within `bookable` at a `fixed_price`. It names the `pricing_option_id` it was computed at, and is omitted for auction pricing and seller-optimized allocation.
- `availability_status` reuses `enums/availability-status.json`.
- `reason` is `over_forecast`, `not_forecastable`, or `forecast_unavailable` on refused packages. `forecast_unavailable` is the transient case.

The shape is task-agnostic. The error-handling reference defines its rules, and the task pages for `buy_products`, `accept_proposal`, `control_media_buy`, and the 3.x `create_media_buy` and `update_media_buy` facades reference it:

- every refused package is listed;
- sellers MAY list packages that fit, with their headroom, and an absent package carries no availability claim;
- figures are snapshots, not holds;
- a refusal on a `submitted` task that ends in `failed` carries the same details on that task's `errors[]` entry;
- the complete details travel on the payload `errors[]`, and the transport-envelope `adcp_error` copy carries them only within the 4096-byte limit;
- sellers SHOULD set `mutation_outcome: not_applied` on a pre-write refusal, and buyers change the request only once nothing committed. A `forecast_unavailable` retry reuses the key after a synchronous refusal and needs a new key after a failed async task, whose key replays the original `submitted` response;
- sellers MAY round, coarsen, or omit `available` but SHOULD still give `bookable`, and round down when they round;
- an increase outside the accepted envelope stays `REQUOTE_REQUIRED`, checked before inventory;
- a ranked hold declined while a hold ahead stands does not use these details.

The `PRODUCT_UNAVAILABLE` enum description and suggestion reference the new shape. Its registered recovery stays `correctable`.
