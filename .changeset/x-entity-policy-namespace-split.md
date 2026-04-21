---
"adcontextprotocol": patch
---

spec + tooling: split `governance_policy` into registry vs. inline namespaces (closes #2685)

Closes the follow-up filed during phase 3 of the #2660 rollout. A `policy_id` referring to a registry-scoped policy (e.g., `uk_hfss`) and a `policy_id` referring to a plan-scoped inline bespoke policy are different entities — the former is globally unique, the latter is plan-scoped — and the single `governance_policy` entity type was silently allowing storyboards to feed one into the other.

Registry changes:
- Remove `governance_policy`.
- Add `governance_registry_policy` — canonical registry ids (`uk_hfss`, `us_coppa`, `garm:brand_safety:violence`).
- Add `governance_inline_policy` — plan/portfolio/standards-scoped bespoke ids.

Retagged sites:
- `governance_inline_policy`: `governance/policy-entry.json::policy_id` (every `$ref` to policy-entry.json inside an AdCP task schema is an inline usage — registry policies are served by a separate out-of-band API, not embedded in task payloads).
- `governance_registry_policy`: `governance/policy-ref.json`, `governance/sync-plans-request` (`policy_ids[]`, `portfolio.shared_policy_ids[]`), `governance/sync-plans-response` (`resolved_policies[]`), `governance/policy-category-definition`, `property/validation-result`, `error-details/policy-violation`, `content-standards/validate-content-delivery-response`, `content-standards/calibrate-content-response`.

Ambiguous sites (deliberately un-annotated, documented with `$comment`):
- `governance/check-governance-response::findings[].policy_id` — can reference either namespace depending on which policy matched.
- `governance/get-plan-audit-logs-response` audit entries (same shape as findings).

Walker enhancement:
- `resolveEntityAtPath` now tries the node's own `properties`/`items` descent AND composite `oneOf`/`anyOf`/`allOf` variants, merging hits. Fixes a false-negative where schemas with validation-only `anyOf` at the root (like `content-standards/create-content-standards-request.json`'s `anyOf: [{required: ["policies"]}, {required: ["registry_policy_ids"]}]`) silently dropped property descent.

One regression test added proving the new split catches the registry-vs-inline conflation that was invisible under the old single `governance_policy` tag.
