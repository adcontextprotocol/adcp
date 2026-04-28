---
---

Fix `get_plan_audit_logs` doc to match schema: rename `human_reviews` → `escalations` and `human_review_rate` → `escalation_rate` throughout the response example and field table. The schema (`get-plan-audit-logs-response.json`) uses `escalations`/`escalation_rate` and has `additionalProperties: false` on `summary`, so the previous doc example would fail schema validation. Also adds the missing `escalation_rate_max` threshold entry and clarifies that `human_reviewed` counts only `approved`/`denied` outcomes — `conditions` is an agent-issued flow-control state, not a human resolution.
