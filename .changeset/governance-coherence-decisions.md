---
"adcontextprotocol": minor
---

Campaign governance (experimental `governance.campaign`): settle the rules the specification contradicted or left undefined (adcp#8733, PR 2 of 3). These are normative decisions of the Governance working group. No wire field, enum member or `plan_hash` rule changes. This is a change within the 3.3 pre-release.

- **Budget cut below committed spend.** A `sync_plans` that reduces `budget.total` (or a period `amount`) below the amount already committed is rejected with `VALIDATION_ERROR` and leaves the plan unchanged. Before, the specification said the sync was accepted and flagged on the next check, while the task page said it was rejected.
- **Unapproved seller or undelegated caller on `check_governance`.** A failed `approved_sellers` or `delegations` evaluation for an authenticated caller is returned as a `denied` verdict with a finding and a `check_id`, so the attempt can be audited. Before, the task page listed `PERMISSION_DENIED` for these cases. `check_governance` still returns `PERMISSION_DENIED` when the caller is unauthenticated or its authenticated identity does not match `caller`. Callers that branch on the error code for the authority cases must also handle the verdict.
- **Human review in every mode.** Audit and advisory mode no longer describe an agent that always returns `approved`: plans with `human_review_required: true` escalate in every mode.
- **`plan_id` namespace.** A `plan_id` names at most one plan within a governance agent. The principal that first syncs it owns the plan, and a `sync_plans` naming it from any other principal is rejected with `PERMISSION_DENIED`.
- **`execute_only`.** A pre-approved action is one whose opaque action binding already holds an approved intent check in the plan's lifecycle. An `execute_only` delegate may act only on such an action.
- **Regions-restricted plans.** An action with no geographic targeting, or with country-level targeting only, is outside a regions-restricted plan: an intent check returns `conditions` naming the region constraint, and an execution check returns `denied`.
- **Unresolvable registry policy ID.** `sync_plans` returns `REFERENCE_NOT_FOUND` when a registry policy ID in `policy_ids` cannot be resolved.
- **Three re-call rule.** "The same action" means re-checks that carry the same `consultation_context`.

Training agent: `sync_plans` now rejects a `budget.total` reduced below committed spend, and `check_governance` returns the `denied` verdict for an authenticated execution caller that is not the audience preserved from the approved intent, and for a buyer-side caller whose delegation has ended.
