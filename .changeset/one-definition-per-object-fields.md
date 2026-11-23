---
"adcontextprotocol": patch
---

Values, ranges, and geographic objects that still drifted have one definition each. `core/open-ended-numeric-range.json` is the range with a minimum, a maximum, or both; the audience characteristic range, the capabilities `matching_latency_hours`, and the job salary range compose it, and the salary range requires `min` or `max`, as its description says. `core/distance.json` is a non-negative distance with its unit; `core/radius.json` and the vehicle mileage refine it. `core/plan-adjustment-amount.json` refines `core/money.json`, and the insertion order `total_budget` references it, so its currency is an ISO 4217 code. Postal address fields reference `core/address-street.json`, `core/address-city.json`, `core/address-region.json`, and `core/address-postal-code.json`, which take the bounds the business entity address published. Delivery rows at the country and region levels carry ISO 3166 codes in `geo_code`.
