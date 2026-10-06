---
"adcontextprotocol": minor
---

Add experimental composable delivery breakdowns to `get_media_buy_delivery` (feature id `media_buy.delivery_composition`): request `breakdown_composition` (2 to 3 of `date`, `geo` at country/region/metro, `device_type`, `device_platform`, `placement`, `creative`, `property`) returns one cross-tabulated `by_package[].by_composition` result with whole-request cursor pagination, `truncated`/`suppressed` flags, and an applied-sort echo, declared by `reporting_capabilities.supports_breakdown_composition` (`max_dimensions`, `composable_dimensions`). Adds `BREAKDOWN_COMPOSITION_UNSUPPORTED` and `BREAKDOWN_DIMENSION_NOT_COMPOSABLE` error codes, extends `CURSOR_EXPIRED` to composition cursors, and adds conformance vectors under `test-vectors/breakdown-composition/`. Existing marginal `by_*` arrays are unchanged; `audience`, `keyword`, `catalog_item`, and `postal_area` geo are deferred.
