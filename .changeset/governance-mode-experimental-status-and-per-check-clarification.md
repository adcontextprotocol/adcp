---
"adcontextprotocol": patch
---

Mark `governance-mode.json` enum as `x-status: experimental` and clarify the per-check semantics of the audit-entry `mode` field.

The enum is referenced exclusively from experimental schemas (`check-governance-response.json`, `get-plan-audit-logs-response.json` `entries[]`); annotating it explicitly prevents the enum from being treated as stable while its consumers are still experimental. The `entries[].mode` description is tightened to clarify that the field reflects the mode active for that specific check, distinct from a future `governed_actions[].mode` (which would describe the action's current mode and may differ if the plan has been re-synced since).
