---
"adcontextprotocol": major
---

Governance, validation, and content-standards schema alignment for 3.0 GA.

Fresh-builder testing across 21 specialisms (issues #2284–#2288) surfaced protocol mismatches between schemas, storyboards, and SDKs. This change reconciles the spec before the wire freezes at GA.

**Content standards (#2284):** `content_standards.policy` (prose string with `(must)`/`(should)` markers) → `policies: PolicyEntry[]` using the same shape as registry policies. Each policy has an addressable `policy_id`, `enforcement` (must|should), and natural-language `policy` text. Deleted the intermediate `policy-rule.json`; the registry's `policy-entry.json` is now the one shape for all policies — registry-published, inline bespoke, single prose blob, or multi-entry structured. `registry_policy_ids` preserved as the reference path; `policies[]` is the inline path; at least one required.

**Governance findings (#2286):** Storyboards diverged from the canonical `check-governance-response` schema (`code`/`message`/`severity: should|must` vs. schema's `category_id`/`explanation`/`severity: info|warning|critical`). Storyboards now match the schema. `severity: should` → `warning`, `must` → `critical`.

**Check governance request:** Removed `binding`/`delivery_evidence` from governance storyboards — these re-serialized state the schema already captures via `governance_context` (continuity token) + flat fields (`tool`+`payload` for intent checks, `media_buy_id`+`delivery_metrics` for execution). Line-item per-package drift detection punted to 3.1; aggregate drift expressed via `channel_distribution`. Also renamed storyboard field `governance_phase` → `phase` to match schema.

**Validation oracle shape:** Unified `validate_content_delivery` and `validate_property_delivery` response `features[]` on a single shape. Per-feature `status: passed|failed|warning|unevaluated` reports both positive and negative outcomes (not violations-only). Dropped `value` echo (caller's own submission, redundant). Content-standards `requirement` not echoed (seller owns thresholds, leak risk); property validation `requirement` echoed when the caller authored the filter (buyer's own thresholds, not seller IP). Dropped the separate `code` field; record-level structural checks now use reserved `feature_id` namespaces (`record:list_membership`, `record:excluded`, `delivery:seller_authorization`, `delivery:click_url_presence`). Added optional `confidence` field for evaluator certainty. `rule_id` renamed to `policy_id` to align with the registry canonical naming. `message` renamed to `explanation` family-wide (aligned with governance findings + `calibrate_content`).

**Campaign governance:** `sync-plans-request.custom_policies[]` and `portfolio.shared_exclusions[]` upgraded from `string[]` (unaddressable prose) to `PolicyEntry[]`. Governance findings can now cite these by `policy_id`. Required fields on `policy-entry.json` relaxed from 6 to 3 (`policy_id`, `enforcement`, `policy`) so inline bespoke authoring doesn't require full registry metadata; `version`, `name`, `category` optional with documented defaults.

**Attribution and registry vs. inline:** Added `source: "registry" | "inline"` (default `"inline"`) to `policy-entry.json` — explicit opt-in for registry publishing vs. inline bespoke authoring. Added optional `source_plan_id` to governance findings — portfolios aggregating bespoke policies from multiple member plans can now disambiguate which plan's policy triggered. Added optional `policy_id` (reserved) to `core/feature-requirement.json` and `creative/creative-feature-result.json` — 3.1 will populate for bottom-up policy attribution (see #2303).

**File structure:** Moved `static/schemas/source/property/feature-requirement.json` → `static/schemas/source/core/feature-requirement.json`. It's a reusable predicate over any feature, not a property-specific concept. Unblocks cross-surface reuse in 3.1.

Follow-ups filed: #2303 (3.1 `policy_id` attribution semantic contract), #2319 (post-GA registry publishing linter).
