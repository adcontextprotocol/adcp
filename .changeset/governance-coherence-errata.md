---
"adcontextprotocol": patch
---

Campaign governance errata: make the task pages, audit-trail, safety-model and overview pages agree with the specification and schemas (adcp#8733, PR 1 of 3; 3.2.x backport of #8931 without the aggregation-key change, which ships in 3.3). No wire field, enum member or schema validation outcome changes.

- Governance mode is described as governance agent configuration, not a plan field set through `sync_plans`. An agent that reports `mode` records the mode in force on each check entry.
- The safety model no longer promises budget reservation. Budget checks are point-in-time, as the specification already says. Where the pages said an intent or governance "reserves" an amount, they now say the ledger commits it when the outcome is reported.
- The `get_plan_audit_logs` field table names `plans[].entries[].verdict` instead of `status`, and the `delivery` outcome example is buyer-called.
- A plan re-sync is no longer described as re-evaluating active campaigns. Active buys are evaluated against the updated plan on their next `check_governance` call.
- Drift metrics use the schema vocabulary throughout: `escalations[]`, `escalation_rate`, `escalation_rate_trend`, `thresholds.escalation_rate_min` and `escalation_rate_max`. The `human_review_rate*` and `human_reviews[]` names never existed in a schema.
- Geo findings in the examples use `geo_compliance`, matching `categories_evaluated` on the same page.
- The legacy `check_governance` response branch (responses without `check_type`) is described as the legacy compatibility shape accepted during 3.x migration.
