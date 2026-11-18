---
"adcontextprotocol": patch
---

Campaign governance (experimental `governance.campaign`): follow-up errata found during the coherence sweep (adcp#8733, PR 4). Each edit follows a rule that is already stated elsewhere in the specification or schemas. No schema property, enum member or `plan_hash` rule changes.

- **Human-review trigger list.** The trust page, known limitations and the FAQ name all five schema triggers: `fair_housing`, `fair_lending`, `fair_employment` and `pharmaceutical_advertising` in `policy_categories`, and `eu_ai_act_annex_iii` in `policy_ids`. The FAQ no longer describes 3.0 in the future tense, and says that an omitted flag is accepted from 3.3.
- **Who sets the flag.** The `requires_human_review` descriptions in `policy-category-definition.json` and `policy-entry.json` say the governance agent sets `plan.human_review_required`, as the specification does. The category description no longer says that a policy can override the category's setting: a policy adds the requirement and cannot remove it.
- **Reallocation fields.** `budget.reallocation_threshold` is no longer documented as always required. The schema requires exactly one of `reallocation_threshold` or `reallocation_unlimited: true`, and the `sync_plans` field table now lists both. The reallocation table and the `reallocation_threshold` description point to `reallocation_unlimited: true` for unlimited reallocation, because a threshold equal to `total` tightens when `total` changes.
- **Overview page.** Advisory mode is described as returning `approved` with findings, and the "Execute" step and the image description no longer say budget is reserved.
- **Audit logs.** The audit-trail page and the `entries[].mode` description no longer refer to a closed issue or to mode as a plan property. The `entries[].mode` description no longer mentions a `governed_actions[].mode` field that does not exist. The specification and the audit-trail page now state the same strength as the schema: a governance agent SHOULD record the mode on check entries, and outcome entries carry none.
- **Mode on the response.** The specification no longer says that governance mode is "not a protocol-level field". The `check_governance` response has carried an optional `mode` property since 3.1, and the task page documents it. The specification now says that mode is agent configuration, that no request carries it, and that the agent may report it on the response. Callers still MUST NOT branch on it.
- **Delegation expiry.** The `delegations[].expires_at` description said that the governance agent denies an expired delegate's actions. It now follows the plan-access rule: a re-check that presents a context issued for the plan, and an execution check on an action the agent proposed, are `denied`, and any other check from that agent returns `PLAN_NOT_FOUND`.

Training agent: the `mode` property on its `sync_plans` tool is described as a sandbox test control. Its behaviour is unchanged.
