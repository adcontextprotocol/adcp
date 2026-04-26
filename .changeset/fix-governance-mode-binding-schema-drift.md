---
"adcontextprotocol": patch
---

Add `mode` to `check_governance` response schema and fix `binding`→`check_type` drift in training agent audit entries.

`check-governance-response.json` now declares the optional `mode` field (enforce/advisory/audit) that the training agent was already emitting, letting counterparties and regulators distinguish `approved`-with-finding decisions made under `enforce` from those made under `audit`. The training agent audit log handler no longer emits the non-canonical `binding` field (which caused schema-validation failures on the strict `entries[]` schema); it now emits `check_type: "intent"|"execution"` per the existing schema contract. The schema carries `x-status: experimental`. Audit-entry `mode` is added separately by #3160.
