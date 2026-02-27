---
"adcontextprotocol": minor
---

Add dimension breakdowns to delivery reporting and device_type targeting.

New enums: `device-type.json` (desktop, mobile, tablet, ctv, dooh, unknown), `audience-source.json` (synced, platform, third_party, lookalike, retargeting, unknown), `sort-metric.json` (sortable numeric delivery-metrics fields). New shared schema: `geo-breakdown-support.json` for declaring geographic breakdown capabilities. Add `device_type` and `device_type_exclude` to targeting overlay. Add `reporting_dimensions` request parameter to `get_media_buy_delivery` for opting into geo, device_type, device_platform, audience, and placement breakdowns with configurable sort and limit. Add corresponding `by_*` arrays with truncation flags to the delivery response under `by_package`. Declare breakdown support in `reporting_capabilities` (product-level). Add `device_type` to seller-level targeting capabilities in `get_adcp_capabilities`.

Note: the speculative `by_geography` example in docs (never in the schema or spec) has been replaced with the formal `by_geo` structure.
