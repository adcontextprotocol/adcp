---
"adcontextprotocol": minor
---

Add flexible-window availability discovery. `offer_filters.availability_horizon` lets a buyer ask "which dates can I run?" instead of filtering to one exact flight; sellers answer by partitioning the horizon into `time`-dimensioned forecast points (new `forecast-dimension-time` variant) carrying the new `availability_status` field (`available` | `unavailable`). Availability data is a snapshot bounded by the forecast's `valid_until`, never a hold — proposal finalization remains the firm-avails and commitment boundary. Forecast data is excluded from `list_products` feed-version scoping, and a `list_products` request whose `fields` includes `forecast` must not be answered with `outcome: "unchanged"`.
