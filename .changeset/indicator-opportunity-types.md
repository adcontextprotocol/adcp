---
"adcontextprotocol": minor
---

Add `flight_extension_opportunity` (media buy) and `scale_budget_opportunity` (media buy or package) to `indicator-type`, so sellers can advertise outperforming buys through the existing `get_media_buys` indicators, `supported_indicator_types` gate, and `indicators.changed` invalidation. Rationale and any suggested action stay in `ext`; an indicator never pre-authorizes `update_media_buy`. Closes #4587.
