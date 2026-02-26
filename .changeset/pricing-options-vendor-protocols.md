---
"adcontextprotocol": minor
---

Add structured pricing options to signals and content standards protocols.

`get_signals` now returns `pricing_options` (array of typed pricing option objects) instead of the legacy `pricing: {cpm, currency}` field. This enables signals agents to offer time-based subscriptions, flat-rate, CPCV, and other pricing models alongside CPM.

`list_content_standards` / `get_content_standards` now include `pricing_options` on content standards objects as an optional field, using the same structure. Full billing integration for governance agents will be defined when the account setup flow for that protocol is designed.

`report_usage` has been simplified: `kind` and `operator_id` are removed. The receiving vendor agent already knows what type of service it provides, and the billing operator is captured by the account reference (`brand + operator` form or implied by account setup when using `account_id`).
