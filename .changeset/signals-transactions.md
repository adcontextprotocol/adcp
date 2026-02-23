---
"adcontextprotocol": minor
---

Extend signals protocol with transaction support:

- **Pricing models**: Signal pricing now supports `cpm` and `percent_of_media` models via the new `signal-pricing.json` discriminated union schema. Percent-of-media supports an optional `max_cpm` cap (the hybrid model used by platforms like The Trade Desk).
- **Pricing options**: `get_signals` now returns `pricing_options[]` per signal (replacing the single `pricing` field), each with a `pricing_option_id` and pricing model. Pass `account_id` for per-account rate cards and `buyer_campaign_ref` to correlate discovery with settlement.
- **New `max_percent` filter**: Signal discovery can filter percent-of-media signals by maximum percentage.
- **`account_id` and `buyer_campaign_ref` on `activate_signal`**: Links custom signal activations to a vendor account and specific campaign.
- **New generic vendor task `report_usage`**: Reports vendor service consumption (impressions, media spend, vendor cost) across protocols (signals, governance, creative). Supports batching multiple campaigns in a single request via per-record `buyer_campaign_ref`. Requires `operator_id` to characterize billing responsibility. Usage records reference `pricing_option_id` so signals agents can verify the correct rate was applied.
