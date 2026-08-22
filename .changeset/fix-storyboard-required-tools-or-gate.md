---
"adcontextprotocol": patch
---

Fix 17 compliance storyboards that incorrectly included `get_adcp_capabilities` in `required_tools` alongside capability-specific tools. Because `required_tools` uses OR semantics, listing a universal tool made the storyboard-level gate trivially satisfied for every conformant agent — agents lacking the actual capability tool (e.g. `sync_accounts`, `build_creative`, `get_products`) would enter the storyboard and fail at the first capability-specific step instead of receiving a clean coverage-gap skip.

Affected storyboards: `billing_gate_dispatch`, `agent_notification_configs`, and 15 scenarios across the `media-buy` and `creative` protocol families.
