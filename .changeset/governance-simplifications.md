---
"adcontextprotocol": major
---

Simplify governance protocol for 3.0:

1. Remove `binding` field from `check_governance` request — governance agents infer check type from discriminating fields: `tool`+`payload` (intent check, orchestrator) vs `media_buy_id`+`planned_delivery` (execution check, seller). Adds `AMBIGUOUS_CHECK_TYPE` error for requests containing both field sets.
2. Remove `mode` (audit/advisory/enforce) from `sync_plans` — mode is governance agent configuration, not a protocol field.
3. Remove `escalated` as a `check_governance` status — human review is handled via standard async task lifecycle. Three terminal statuses remain: `approved`, `denied`, `conditions`.
4. Simplify `get_plan_audit_logs` response schema.
