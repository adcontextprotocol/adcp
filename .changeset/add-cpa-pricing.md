---
"adcontextprotocol": minor
---

Add CPA (Cost Per Acquisition) pricing model for outcome-based campaigns.

CPA enables advertisers to pay per conversion event (purchase, lead, signup, etc.) rather than per impression or click. The billable event type is determined by the package's `optimization_goal.event_type`, which ties to event sources configured via `sync_event_sources`.

This single model covers use cases previously described as CPO (Cost Per Order), CPL (Cost Per Lead), and CPI (Cost Per Install) — differentiated by event type rather than separate pricing models.

New schema:
- `cpa-option.json`: CPA pricing option with fixed and auction modes

Updated schemas:
- `pricing-model.json`: Added `cpa` enum value
- `pricing-option.json`: Added cpa-option to discriminated union
- `index.json`: Added cpa-option to registry
