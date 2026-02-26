---
"adcontextprotocol": minor
---

Add dimension breakdowns to delivery reporting and device_type targeting.

New enums: `device-type.json` (desktop, mobile, tablet, ctv, dooh, unknown), `audience-source.json` (synced, platform, third_party, lookalike, retargeting, unknown). Add `device_type` and `device_type_exclude` to targeting overlay. Add `reporting_dimensions` request parameter to `get_media_buy_delivery` for opting into geo, device_type, device_platform, audience, and placement breakdowns. Add corresponding `by_*` arrays with truncation flags to the delivery response under `by_package`. Declare breakdown support in both `get_adcp_capabilities` (seller-level) and `reporting_capabilities` (product-level).
