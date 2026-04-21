---
"adcontextprotocol": patch
---

spec: extend `x-entity` annotation to account and governance domains (#2660 phase 3)

Continues the rollout from phase 2 (#2672). Annotates the "control plane" cluster: 10 account schemas + 13 governance schemas. Registry grows by one entity type.

Registry addition:
- `policy` — governance policy identifier (registry-published like `uk_hfss` or bespoke inline). Distinct from `governance_plan` (plans contain policies).

Shared types:
- `governance/policy-entry.json::policy_id` → `policy`
- `governance/policy-ref.json::policy_id` → `policy`

Domain leaves:
- **account/**: `report-usage-request` (media_buy_id, vendor_pricing_option_id, signal_activation_id, content_standards_id, rights_grant_id, creative_id, property_list_id); `sync-accounts-response` (account_id).
- **governance/**: every `plan_id` → `governance_plan` (phase-2 taxonomy decision applied); every `policy_id` → `policy`; array-items on `plan_ids[]`, `portfolio_plan_ids[]`, `member_plan_ids[]`, `policy_ids[]`, `shared_policy_ids[]`.

No new shared-type conflicts uncovered by the lint. Walker, registry disagreement guard, and existing tests unchanged.

Deferred to phase 4 / capstone: `property/`, `collection/`, `sponsored-intelligence/`, plus a coverage counter in CI output and a schema-side nudge for new `*_id` fields without `x-entity`.
