---
"adcontextprotocol": patch
---

Fix `billing_gate_dispatch` and `agent_notification_configs` storyboards incorrectly including `get_adcp_capabilities` in `required_tools`. Because `required_tools` uses OR semantics, listing a universal tool alongside a specific capability tool made the storyboard-level gate trivially satisfied for every conformant agent, causing the storyboard to run against agents that lack the required capability tool and fail at the first step instead of receiving a clean coverage-gap skip.
