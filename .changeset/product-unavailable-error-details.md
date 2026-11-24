---
"adcontextprotocol": minor
---

Add typed `details` for `PRODUCT_UNAVAILABLE`, so a buyer whose packages ask for more than a seller can deliver learns how much it can buy (adcp#9184). New `error-details/product-unavailable.json` (`x-added-in: 4.0.0`) carries `packages[]`, one entry per package:

- `package_field`, `package_id`, and `product_id` identify the package. `package_field` is a JSONPath-lite locator of its row: `purchases[i]`, `packages[i]`, or `new_packages[i]` in the request, or `commercial_terms.purchases[i]` in the committed proposal on `accept_proposal`.
- `unit` is a delivery unit named as in forecasts (`impressions`, `viewable_impressions`, `clicks`, and so on), never money. `requested` is what the package asks for in `unit`, derived from the budget at the package's rate when the package states only a budget.
- `available` is the advisory forecast range. `bookable` is the most the seller will accept right now, which may exceed the forecast.
- `max_budget` is the budget that fits within `bookable`. It names the `pricing_option_id` it was computed at.
- `availability_status` reuses `enums/availability-status.json`.
- `reason` is `over_forecast`, `not_forecastable`, or `forecast_unavailable` on refused packages. `forecast_unavailable` is the transient case.

The shape is task-agnostic. The error-handling reference defines its rules, and the task pages for `buy_products`, `accept_proposal`, `control_media_buy`, and the 3.x `create_media_buy` and `update_media_buy` facades reference it:

- every refused package is listed;
- sellers MAY list packages that fit, with their headroom, and an absent package carries no availability claim;
- figures are snapshots, not holds;
- a refusal on a `submitted` task that ends in `failed` carries the same details on that task's `errors[]` entry;
- sellers MAY round, coarsen, or omit `available` but SHOULD still give `bookable`, and round down when they round;
- an increase outside the accepted envelope stays `REQUOTE_REQUIRED`, checked before inventory;
- a ranked hold declined while a hold ahead stands does not use these details.

The `PRODUCT_UNAVAILABLE` enum description and suggestion reference the new shape. Its registered recovery stays `correctable`.
