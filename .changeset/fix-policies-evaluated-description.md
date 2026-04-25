---
"adcontextprotocol": patch
---

Clarify `policies_evaluated` description in `check-governance-response.json` and `get-plan-audit-logs-response.json`. The previous wording ("Registry policy IDs...") was incomplete and misleading: governance agents also record inline `policy_id`s from `custom_policies` in this field, and a consumer reading the description literally could write a parser that filters them out. The new wording names both sources. Both schemas carry `x-status: experimental`. Description-only clarification; no type, enum, or wire change.
