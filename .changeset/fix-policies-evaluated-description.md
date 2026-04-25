---
"adcontextprotocol": patch
---

Clarify `policies_evaluated` description in `check-governance-response.json` and `get-plan-audit-logs-response.json`. The previous wording ("Registry policy IDs...") incorrectly implied only registry-resolved IDs are valid; governance agents also record inline `policy_id`s from `custom_policies`. Both schemas carry `x-status: experimental`. Description-only correction; no type, enum, or wire change.
