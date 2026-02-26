---
"adcontextprotocol": minor
---

Add percent_of_media pricing model and transaction context to signals protocol:

- **`signal-pricing.json`**: New schema for signal-specific pricing — discriminated union of `cpm` (fixed CPM) and `percent_of_media` (percentage of spend, with optional `max_cpm` cap for TTD-style hybrid pricing)
- **`signal-pricing-option.json`**: New schema wrapping `pricing_option_id` + `signal-pricing`. The `get_signals` response now uses this instead of the generic media-buy `pricing-option.json`
- **`signal-filters.json`**: New `max_percent` filter for percent-of-media signals
- **`get_signals` request**: Optional `account_id` (per-account rate cards) and `buyer_campaign_ref` (correlate discovery with settlement)
- **`activate_signal` request**: Optional `account_id` and `buyer_campaign_ref` for transaction context
