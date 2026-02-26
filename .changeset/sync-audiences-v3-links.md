---
"adcontextprotocol": patch
---

Add schema link checker workflow for docs PRs. The checker validates that schema URLs in documentation point to schemas that exist, and warns when schemas exist in source but haven't been released yet.

Update schema URLs from v1/v2 to v3 across documentation for schemas that are only available in v3:
- Content standards tasks (calibrate_content, create/get/list/update_content_standards, get_media_buy_artifacts, validate_content_delivery)
- Creative delivery (get_creative_delivery)
- Conversion tracking (log_event, sync_event_sources, event-custom-data, user-match)
- Pricing options (cpa-option, cpm-option, time-option, vcpm-option)
- Property governance (base-property-source)
- Protocol capabilities (get-adcp-capabilities-response)
- Media buy operations (get_media_buys, sync_audiences)
- Migration guides and reference docs

Some of these schemas are already released in 3.0.0-beta.3, others will be available in the next beta release (3.0.0-beta.4).
