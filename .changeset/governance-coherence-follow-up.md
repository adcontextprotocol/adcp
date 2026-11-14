---
"adcontextprotocol": minor
---

Campaign governance (experimental `governance.campaign`): follow-up errata found during the coherence sweep (adcp#8733, PR 4). Each edit follows a rule that is already stated elsewhere in the specification or schemas. No `plan_hash` rule changes.

- **`human_override` is declared.** `sync-plans-request.json` now defines the optional plan field `human_override` (`reason`, `approver`, optional `approved_at`). The Annex III obligations page and the `plan_hash` preimage list have named it since 3.0, and no schema defined it.
- **Human-review trigger list.** The trust page, known limitations and the FAQ name all five schema triggers: `fair_housing`, `fair_lending`, `fair_employment` and `pharmaceutical_advertising` in `policy_categories`, and `eu_ai_act_annex_iii` in `policy_ids`. The FAQ no longer describes 3.0 in the future tense.
- **Who sets the flag.** The `requires_human_review` descriptions in `policy-category-definition.json` and `policy-entry.json` say the governance agent sets `plan.human_review_required`, as the specification does.
- **Reallocation fields.** `budget.reallocation_threshold` is no longer documented as always required. The schema requires exactly one of `reallocation_threshold` or `reallocation_unlimited: true`, and the `sync_plans` field table now lists both.
- **`PLAN_NOT_FOUND` on `check_governance`.** The error row says an unknown plan and a plan the caller cannot access are indistinguishable, as the error-code definition requires.
- **Overview page.** Advisory mode is described as returning `approved` with findings, and the "Execute" step no longer says budget is reserved.
- **Audit logs.** The audit-trail page and the `entries[].mode` description no longer refer to a closed issue or to mode as a plan property.

Training agent: `check_governance` returns the `PLAN_NOT_FOUND` error for an unknown or inaccessible `plan_id`, where it returned a `denied` verdict with a `plan_lookup` finding. The `mode` property on its `sync_plans` tool is described as a sandbox test control.
