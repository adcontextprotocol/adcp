---
"adcontextprotocol": minor
---

Agent ergonomics improvements from #1240 tracking issue.

**Media Buy**
- `get_products`: Add `fields` parameter for response field projection, reducing context window cost for discovery calls
- `get_media_buy_delivery`: Add `include_package_daily_breakdown` opt-in for per-package daily pacing data
- `get_media_buy_delivery`: Add `attribution_window` on request for buyer-controlled attribution windows (model optional)
- `get_media_buys`: Add buy-level `start_time`/`end_time` (min/max of package flight dates)

**Capabilities**
- `get_adcp_capabilities`: Add `supported_pricing_models` and `reporting` block (date range, daily breakdown, webhooks, available dimensions) at seller level

**Audiences**
- `sync_audiences` request: Add `description`, `audience_type` (crm/suppression/lookalike_seed), and `tags` metadata
- `sync_audiences` response: Add `total_uploaded_count` for match rate calculation

**Forecasting**
- `ForecastPoint.metrics`: Add explicit typed properties for all 13 forecastable-metric enum values
