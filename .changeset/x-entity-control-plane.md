---
"adcontextprotocol": patch
---

spec: extend `x-entity` annotation to account and governance domains (#2660 phase 3)

Continues the rollout from phase 2 (#2672). Annotates the "control plane" cluster: 10 account schemas + 13 governance schemas + 4 cross-domain `policy_id` sites. Registry grows by two entity types.

Registry additions:
- `governance_policy` — governance policy identifier (registry-published like `uk_hfss` or plan-scoped inline). Named for parallelism with `governance_plan`. Known caveat: registry vs. inline policy namespaces share this entity type today; splitting them requires schema-shape discrimination and is tracked in #2685.
- `governance_check` — governance check result identifier, round-trips between `check_governance` response and `report_plan_outcome` request.

Registry edits:
- `media_plan` definition no longer cites `governance/sync-plans-request` (stale — those are all `governance_plan`). Marked as reserved for future media-plan schemas.

Shared types:
- `governance/policy-entry.json::policy_id` → `governance_policy`
- `governance/policy-ref.json::policy_id` → `governance_policy`

Domain leaves:
- **account/**: `report-usage-request` (media_buy_id, vendor_pricing_option_id, signal_activation_id, content_standards_id, rights_grant_id, creative_id, property_list_id); `sync-accounts-response` (account_id).
- **governance/**: every `plan_id` → `governance_plan` (phase-2 taxonomy decision applied); every `policy_id` → `governance_policy`; `check_id` → `governance_check` on `check-governance-response`, `report-plan-outcome-request`, `get-plan-audit-logs-response` escalations; array-items on `plan_ids[]`, `portfolio_plan_ids[]`, `member_plan_ids[]`, `policy_ids[]`, `shared_policy_ids[]`.
- **Cross-domain `policy_id` sites**: `property/validation-result`, `error-details/policy-violation`, `content-standards/validate-content-delivery-response`, `content-standards/calibrate-content-response` → `governance_policy`.

Deliberate skips (documented): `outcome_id` (forensic), audit-log entry `id` (forensic), `governance_context` tokens (opaque signed state), `business-entity` (pure descriptor), `invoice_id` (transient billing record), `report-plan-outcome-request.seller_response.seller_reference` (polymorphic — could be media_buy_id, rights_grant_id, or deployment_id depending on purchase_type; no single entity fits).

Doc updates: plan-vs-policy-vs-check disambiguation added under the registry category table; editorial-grouping comment added to clarify the table isn't authoritative.

Deferred to phase 4 / capstone: `property/`, `collection/`, `sponsored-intelligence/`, plus a coverage counter in CI output and a schema-side nudge for new `*_id` fields without `x-entity`.
