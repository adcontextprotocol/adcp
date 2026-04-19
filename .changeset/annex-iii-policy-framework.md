---
"adcontextprotocol": major
---

Protocol changes and reference-server enforcement for GDPR Art 22 / EU AI Act Annex III mandatory human review in regulated-vertical campaigns (credit, insurance pricing, recruitment, housing). Resolves #2310.

## Schema

- **Remove** `budget.authority_level` enum and `budget-authority-level.json`. The old field conflated budget reallocation autonomy with AI-decision authority.
- **Replace** with two orthogonal axes:
  - `budget.reallocation_threshold` (number ≥ 0) — budget reallocation autonomy, denominated in `budget.currency`. Mutually exclusive with `reallocation_unlimited`.
  - `budget.reallocation_unlimited` (boolean) — explicit opt-in sentinel for full autonomy. Prevents the "threshold = total" footgun where a `total` update silently tightens the threshold.
  - `plan.human_review_required` (boolean) — per-decision human review under Art 22 / Annex III. When true, every plan action escalates regardless of spend.
- **Cross-field invariant**: if `plan.policy_categories` contains any of `fair_housing`, `fair_lending`, `fair_employment`, or `pharmaceutical_advertising`, `plan.human_review_required` MUST be `true`. Enforced at the schema level via `if/then`.
- **Add** `requires_human_review: boolean` to `policy-entry.json` and `policy-category-definition.json`. Effective immediately regardless of `effective_date` — Art 22 GDPR is foundational and predates AI Act effective dates.
- **Prompt-injection hardening** on policy evaluation: governance agents MUST pin registry-sourced policy text as system-level instructions; `custom_policies` and `objectives` cannot relax registry policies.

## Registry

- **Seed** `eu_ai_act_annex_iii` registry policy (regulation, must, EU) with `requires_human_review: true`, covering §1(b) recruitment, §5(b) credit, §5(c) insurance. Housing grouped as equivalent-risk under US FHA.
- **Mark** `fair_housing`, `fair_lending`, `fair_employment`, `pharmaceutical_advertising` categories `requires_human_review: true`.
- **Add** `age` and `familial_status` restricted attributes. `fair_housing` now restricts age + familial_status; `fair_employment` now restricts age. Closes the HUD v. Facebook gap.

## Brand identity

- **Add** `brand.data_subject_contestation` — optional contact reference (URL / email / languages) satisfying GDPR Art 22(3) discovery. Exposed on both house-portfolio and brand-agent brand.json variants. Contact reference, not a machine-callable API — AdCP surfaces the pointer; the deployer runs the workflow.

## Reference server enforcement (training agent)

- **Auto-flip** `plan.human_review_required` to `true` when any of: `policy_categories` contains a regulated vertical, `policy_ids` includes `eu_ai_act_annex_iii`, any `custom_policies` entry has `requires_human_review: true`, or `brand.industries` intersects a regulated sector. Records `humanReviewAutoFlippedBy` for audit.
- **Append-only plan revisions**: `GovernancePlanState.revisionHistory` retains prior versions. Downgrading `human_review_required` from true → false on re-sync requires a `human_override` artifact (reason + approver).
- **Mode guard**: `mode: advisory | audit` CANNOT downgrade `denied` / `escalated` when `human_review_required` is true. Art 22 / Annex III overrides operational mode.
- **Contestation finding**: `check_governance` emits a critical `data_subject_contestation` finding when `human_review_required` is true and the brand lacks a contestation contact.
- **Escalation**: every action escalates when `human_review_required` is true; independently, actions escalate when commitment exceeds `reallocation_threshold` (but remains within plan total).

## Docs

- **New**: `docs/governance/annex-iii-obligations.mdx` — deployer obligations (Art 14 oversight, Art 12 logging, Art 13 transparency, Art 10 data governance, Art 22(3) contestation); AdCP's Art 25 data-governance-provider role; jurisdictional scoping limitations; the "discovery mechanism, not workflow" framing for contestation.
- **Updated**: policy registry, campaign specification, safety model, and sync_plans / check_governance task docs reflect the new model.
- **Cross-linked** from the main governance overview.
