# Changelog

## 3.0.0

### Major Changes

- 8f06eed: Remove `sampling` parameter from `get_media_buy_artifacts` request — sampling is configured at media buy creation time, not at retrieval time. Replace `sampling_info` with `collection_info` in the response. Add `failures_only` boolean filter for retrieving only locally-failed artifacts. Add `content_standards` to `get_adcp_capabilities` for pre-buy visibility into local evaluation and artifact delivery capabilities. Add podcast, CTV, and AI-generated content artifact examples to documentation.
- ec06d47: Complete the Account migration for property-list and collection-list task families. Removes the deprecated `principal: string` field everywhere it appeared and replaces it with `account: $ref /schemas/core/account-ref.json`, bringing these two families in line with every other task family in AdCP 3.0 (media-buy, creative, signals, content-standards, account).

  ## Motivation

  Per the glossary (`docs/reference/glossary.mdx:228`), `Principal` is deprecated: AdCP now splits authentication (**Agent**) from billing/platform mapping (**Account**). Every request family that needs account scoping already uses `account: $ref /schemas/core/account-ref.json` — except property-list and collection-list, which still carried the legacy `principal` field. This PR finishes the migration so there is a single, consistent identity primitive across the spec.

  A protocol-expert audit in #2333 confirmed that without this change, the training agent is forced to use `brand.domain` as a session-key proxy — a training-only workaround that diverges from how real sellers derive isolation (auth-derived Agent scoped to Account).

  ## Breaking changes

  **Schema rename (4 files):** `principal: string` removed; `account: $ref /schemas/core/account-ref.json` added.

  - `static/schemas/source/property/property-list.json`
  - `static/schemas/source/property/list-property-lists-request.json`
  - `static/schemas/source/collection/collection-list.json`
  - `static/schemas/source/collection/list-collection-lists-request.json`

  **New optional `account` field added (9 request schemas):** gives callers a way to disambiguate across accounts when the authenticated agent has access to more than one, matching the `get-media-buys-request.json` pattern.

  - `static/schemas/source/property/create-property-list-request.json`
  - `static/schemas/source/property/get-property-list-request.json`
  - `static/schemas/source/property/update-property-list-request.json`
  - `static/schemas/source/property/delete-property-list-request.json`
  - `static/schemas/source/property/validate-property-delivery-request.json`
  - `static/schemas/source/collection/create-collection-list-request.json`
  - `static/schemas/source/collection/get-collection-list-request.json`
  - `static/schemas/source/collection/update-collection-list-request.json`
  - `static/schemas/source/collection/delete-collection-list-request.json`

  `brand` stays on `create_*_list` and `update_*_list` as campaign-identity metadata (same role as in `create-media-buy`). It is no longer overloaded as an identity primitive on read/list/update/delete.

  ## Reference implementation (training agent)

  - `server/src/training-agent/account-handlers.ts` — `ACCOUNT_REF_SCHEMA` is now exported for reuse.
  - `server/src/training-agent/property-handlers.ts` and `inventory-governance-handlers.ts` — all 10 CRUD + validate tools now declare `account: ACCOUNT_REF_SCHEMA` in their inputSchema. The stray `brand`-on-list/get/delete workaround introduced in #2333 is removed.
  - `PropertyListState.principal` is renamed to `PropertyListState.account: AccountRef`. `CollectionListState` gains `account: AccountRef`. Both handlers persist and echo the account on list/get responses.

  ## Storyboards

  - `static/compliance/source/specialisms/property-lists/index.yaml` — every `brand:` block on list/get/update/delete/validate_property_delivery is now `account: { brand: { domain }, operator }`; `principal: "acmeoutdoor.example"` on the list call is gone.
  - `static/compliance/source/specialisms/collection-lists/index.yaml` — same migration.

  ## Docs

  Fixed references to `principal` that describe the protocol (not the deprecated-term glossary entry, which stays as a redirect, and not `docs/building/implementation/security.mdx` legacy vocabulary):

  - `docs/governance/property/tasks/property_lists.mdx`
  - `docs/governance/collection/tasks/collection_lists.mdx`
  - `docs/governance/collection/index.mdx`
  - `docs/governance/property/specification.mdx`

  ## Migration guide

  For agents that were declaring `principal` on list or resource payloads:

  - Replace `principal: "some-id"` with `account: { account_id: "some-id" }` if you had a seller-assigned ID.
  - Replace `principal: "example.com"` with `account: { brand: { domain: "example.com" }, operator: "example.com" }` for the direct-operated brand case.
  - For agency-operated flows, use `account: { brand: { domain: "brand.com" }, operator: "agency.com" }`.

  Creators can continue to pass `brand` on `create_*_list` / `update_*_list` — that field is unchanged and carries campaign metadata (industry, audience) per the spec's existing description.

  All request schemas for this family declare `additionalProperties: false`, so stray `principal` fields on the wire will now fail validation rather than being silently ignored. Sellers upgrading their clients should search their payloads for `"principal":` and replace per the guide above.

  **Follow-up (not in this PR):** `server/src/training-agent/state.ts:310` still falls back to `args.brand?.domain` when `account` is absent. With `additionalProperties: false` now enforced at the gateway, this fallback is unreachable on spec-compliant paths and can be removed in a separate training-agent-only cleanup.

- e6dd73a: Protocol changes and reference-server enforcement for GDPR Art 22 / EU AI Act Annex III mandatory human review in regulated-vertical campaigns (credit, insurance pricing, recruitment, housing). Resolves #2310.

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

- e81235c: Add structured tone guidelines and structured logo fields to Brand Manifest schema.

  **BREAKING: Tone field changes:**

  - Tone is now an object type only (string format removed)
  - Structured tone includes `voice`, `attributes`, `dos`, and `donts` fields
  - Existing string values should migrate to `{ "voice": "<previous-string>" }`
  - Enables creative agents to generate brand-compliant copy programmatically

  **Logo object changes:**

  - Added `orientation` enum field: `square`, `horizontal`, `vertical`, `stacked`
  - Added `background` enum field: `dark-bg`, `light-bg`, `transparent-bg`
  - Added `variant` enum field: `primary`, `secondary`, `icon`, `wordmark`, `full-lockup`
  - Added `usage` field for human-readable descriptions
  - Kept `tags` array for additional custom categorization

  These structured fields enable creative agents to reliably filter and select appropriate logo variants.

  Closes #945

- 892da1d: Delete brand-manifest.json. The brand object in brand.json is now the single
  canonical brand definition. Task schemas reference brands by domain + brand_id
  instead of passing inline manifests. Brand data is always resolved from
  brand.json or the registry.
- 5b8feea: **BREAKING**: Rename `catalog` to `catalogs` (array) on creative manifest. Formats can declare multiple catalog_requirements (e.g., product + inventory + store); the manifest now supports multiple catalogs to match. Each catalog's `type` maps to the corresponding catalog_requirements entry.
- 80ecf76: Capabilities model cleanup for 3.0. Removes redundant boolean gates, makes table-stakes fields required, flattens geo targeting.

  **Removed fields:**

  - `media_buy.reporting` — reporting is implied by media_buy. Product-level `reporting_capabilities` (now required) is the source of truth.
  - `features.content_standards`, `features.audience_targeting`, `features.conversion_tracking` — replaced by object presence: `media_buy.content_standards`, `media_buy.audience_targeting`, `media_buy.conversion_tracking`.
  - `content_standards_detail` — renamed to `content_standards`.
  - `execution.targeting.device_platform`, `device_type` — implied by media_buy support.
  - `execution.targeting.audience_include`, `audience_exclude` — implied by audience_targeting object presence.
  - `execution.trusted_match.supported` — object presence indicates support.
  - `brand.identity` — implied by brand in supported_protocols.

  **Required fields:**

  - `reporting_capabilities` now required on every product.
  - `account` and `media_buy.portfolio` now required when media_buy is in supported_protocols.

  **Geo targeting:**

  - Added `supported_geo_levels`, `supported_metro_systems`, `supported_postal_systems` flat arrays.
  - Deprecated `geo_countries`, `geo_regions`, `geo_metros`, `geo_postal_areas` (will be removed in 4.0).

- 63a33b4: Rename show/episode to collection/installment for cross-channel clarity. Add installment deadlines, deadline policies, and print-capable creative formats.

  Breaking: show→collection, episode→installment across all schemas, enums, and field names (show_id→collection_id, episode_id→installment_id, etc.). Collections gain kind field (series, publication, event_series, rotation) and deadline_policy for lead-time rules. Installments gain optional booking, cancellation, and staged material submission deadlines. Image asset requirements gain physical units (inches/cm/mm), DPI, bleed (uniform or per-side via oneOf), color space, and print file formats (TIFF, PDF, EPS). Format render dimensions support physical units and decimal aspect ratios.

- 89bc3ae: Simplify governance protocol for 3.0:

  1. Remove `binding` field from `check_governance` request — governance agents infer check type from discriminating fields: `tool`+`payload` (intent check, orchestrator) vs `media_buy_id`+`planned_delivery` (execution check, seller). Adds `AMBIGUOUS_CHECK_TYPE` error for requests containing both field sets.
  2. Remove `mode` (audit/advisory/enforce) from `sync_plans` — mode is governance agent configuration, not a protocol field.
  3. Remove `escalated` as a `check_governance` status — human review is handled via standard async task lifecycle. Three terminal statuses remain: `approved`, `denied`, `conditions`.
  4. Simplify `get_plan_audit_logs` response schema.

- 204fe59: Governance, validation, and content-standards schema alignment for 3.0 GA.

  Fresh-builder testing across 21 specialisms (issues #2284–#2288) surfaced protocol mismatches between schemas, storyboards, and SDKs. This change reconciles the spec before the wire freezes at GA.

  **Content standards (#2284):** `content_standards.policy` (prose string with `(must)`/`(should)` markers) → `policies: PolicyEntry[]` using the same shape as registry policies. Each policy has an addressable `policy_id`, `enforcement` (must|should), and natural-language `policy` text. Deleted the intermediate `policy-rule.json`; the registry's `policy-entry.json` is now the one shape for all policies — registry-published, inline bespoke, single prose blob, or multi-entry structured. `registry_policy_ids` preserved as the reference path; `policies[]` is the inline path; at least one required.

  **Governance findings (#2286):** Storyboards diverged from the canonical `check-governance-response` schema (`code`/`message`/`severity: should|must` vs. schema's `category_id`/`explanation`/`severity: info|warning|critical`). Storyboards now match the schema. `severity: should` → `warning`, `must` → `critical`.

  **Check governance request:** Removed `binding`/`delivery_evidence` from governance storyboards — these re-serialized state the schema already captures via `governance_context` (continuity token) + flat fields (`tool`+`payload` for intent checks, `media_buy_id`+`delivery_metrics` for execution). Line-item per-package drift detection punted to 3.1; aggregate drift expressed via `channel_distribution`. Also renamed storyboard field `governance_phase` → `phase` to match schema.

  **Validation oracle shape:** Unified `validate_content_delivery` and `validate_property_delivery` response `features[]` on a single shape. Per-feature `status: passed|failed|warning|unevaluated` reports both positive and negative outcomes (not violations-only). Dropped `value` echo (caller's own submission, redundant). Content-standards `requirement` not echoed (seller owns thresholds, leak risk); property validation `requirement` echoed when the caller authored the filter (buyer's own thresholds, not seller IP). Dropped the separate `code` field; record-level structural checks now use reserved `feature_id` namespaces (`record:list_membership`, `record:excluded`, `delivery:seller_authorization`, `delivery:click_url_presence`). Added optional `confidence` field for evaluator certainty. `rule_id` renamed to `policy_id` to align with the registry canonical naming. `message` renamed to `explanation` family-wide (aligned with governance findings + `calibrate_content`).

  **Campaign governance:** `sync-plans-request.custom_policies[]` and `portfolio.shared_exclusions[]` upgraded from `string[]` (unaddressable prose) to `PolicyEntry[]`. Governance findings can now cite these by `policy_id`. Required fields on `policy-entry.json` relaxed from 6 to 3 (`policy_id`, `enforcement`, `policy`) so inline bespoke authoring doesn't require full registry metadata; `version`, `name`, `category` optional with documented defaults.

  **Attribution and registry vs. inline:** Added `source: "registry" | "inline"` (default `"inline"`) to `policy-entry.json` — explicit opt-in for registry publishing vs. inline bespoke authoring. Added optional `source_plan_id` to governance findings — portfolios aggregating bespoke policies from multiple member plans can now disambiguate which plan's policy triggered. Added optional `policy_id` (reserved) to `core/feature-requirement.json` and `creative/creative-feature-result.json` — 3.1 will populate for bottom-up policy attribution (see #2303).

  **File structure:** Moved `static/schemas/source/property/feature-requirement.json` → `static/schemas/source/core/feature-requirement.json`. It's a reusable predicate over any feature, not a property-specific concept. Unblocks cross-surface reuse in 3.1.

  Follow-ups filed: #2303 (3.1 `policy_id` attribution semantic contract), #2319 (post-GA registry publishing linter).

- 43586d6: **Breaking:** `idempotency_key` is now required on every mutating request schema. **Implementation note:** for most sellers this is a single request-pipeline middleware change, not per-task work — see the [reference implementation](/docs/building/implementation/security#idempotency) for the canonical pattern. Servers that previously accepted requests without one MUST now reject them with `INVALID_REQUEST`. Covers the buyer-mutating surface (`create_media_buy`, `update_media_buy`, `sync_creatives`, `activate_signal`, `acquire_rights`, `creative_approval`, `update_rights`, `build_creative`, `calibrate_content`, `create/update_content_standards`, `create/update/delete_property_list`, `create/update/delete_collection_list`, `log_event`, `provide_performance_feedback`, `report_usage`, `report_plan_outcome`, `si_initiate_session`) and the upsert-style tasks (`sync_accounts`, `sync_governance`, `sync_plans`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `si_send_message`). `si_terminate_session` is documented as naturally idempotent via `session_id` and keeps the field optional.

  Normative semantics: first call canonical, replay with the same key + equivalent payload returns the cached response, key reuse with a different payload returns `IDEMPOTENCY_CONFLICT`, replay past the window returns `IDEMPOTENCY_EXPIRED`. "Equivalent" is pinned to **RFC 8785 JSON Canonicalization Scheme (JCS)** — sellers MUST compare canonical-form hashes, not field-by-field. Excluded from the hash: `idempotency_key`, `context`, `governance_context`, rotated auth credentials. Keys are scoped `(authenticated_principal, idempotency_key)` — and for `si_send_message`, `(principal, session_id, idempotency_key)`.

  Only task-successful responses are cached; errors re-execute on retry (a retry after a 5xx should try again, not replay a failure). Sellers MUST declare `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities` — clients MUST NOT fall back to an assumed default. Past-TTL keys are rejected with `IDEMPOTENCY_EXPIRED` rather than silently treated as new, turning the double-booking footgun into a loud failure.

  Mutating response envelopes carry a top-level `replayed` boolean. The seller's idempotency layer INJECTS `replayed` at response time — it is not part of the cached inner payload. Cache stores the inner response only; envelope fields (`timestamp`, `context_id`) change per response. `IDEMPOTENCY_CONFLICT` error bodies MUST NOT include any hint of the cached payload (no `field` json-pointer, no schema shape) — read-oracle attack surface.

  Security docs also now distinguish **resource idempotency** (natural keys like `audience_id` dedup rows) from **envelope idempotency** (what `idempotency_key` adds — at-most-once execution of the whole request, including webhooks, audit events, and downstream side effects). Closes the v3 retry-safety gap flagged in red team review: without a required key, a timeout-and-retry on `create_media_buy` silently double-books, and a retry of `sync_accounts` silently double-fires onboarding webhooks.

- 06363b9: Remove `account_resolution` capability field. `require_operator_auth` now determines both the auth model and account reference style: `true` means explicit accounts (discover via `list_accounts`, pass `account_id`), `false` means implicit accounts (declare via `sync_accounts`, pass natural key).
- 95f1174: Restructure media buy lifecycle statuses and add compliance testing capability declaration.

  **MediaBuyStatus enum changes (#2026)**

  - `pending_activation` removed — replaced by two distinct statuses with clearer semantics
  - `pending_creatives` added — media buy is approved but has no creatives assigned; buyer must call `sync_creatives` before the buy can serve
  - `pending_start` added — media buy is ready to serve and waiting for its flight date to begin
  - Lifecycle: `create_media_buy` → `pending_creatives` → `pending_start` → `active` (see [migration guide](/docs/reference/migration/prerelease-upgrades) for full state machine)
  - Rejection valid from `pending_creatives` or `pending_start` only (not `active`)
  - Legacy alias: `pending` continues to map to `pending_start`

  **Compliance testing protocol (#2030)**

  - `compliance_testing` added to `supported_protocols` enum in `get_adcp_capabilities`
  - New `compliance_testing` capability section declares which `comply_test_controller` scenarios the agent supports
  - Agents that implement `comply_test_controller` should declare `compliance_testing` in their capabilities

  **Storyboard validation fixes (#2026)**

  - `results[0].action` → `creatives[0].action` (sync_creatives response)
  - `media_buys` → `media_buy_deliveries` (get_media_buy_delivery response)
  - `renders[0].url` → `renders[0].preview_url` (preview_creative response)
  - Added missing `value:` to 7 `field_value` validation checks
  - Added `value` property to storyboard validation schema

  **Migration required for `pending_activation` consumers:**

  - Replace `pending_activation` with `pending_start` in status filters and comparisons
  - Add `pending_creatives` to status filter arrays where you filter for non-active buys
  - Update state machine logic: `pending_creatives` → `pending_start` transition happens when creatives are assigned

- f4ef555: Add Media Channel Taxonomy specification with standardized channel definitions.

  **BREAKING**: Replaces channel enum values (display, video, audio, native, retail → display, olv, social, search, ctv, etc.)

  - Introduces 19 planning-oriented media channels representing how buyers allocate budget
  - Channels: display, olv, social, search, ctv, linear_tv, radio, streaming_audio, podcast, dooh, ooh, print, cinema, email, gaming, retail_media, influencer, affiliate, product_placement
  - Adds desktop_app property type for Electron/Chromium wrapper applications
  - Clear distinction between channels (planning abstractions), property types (addressable surfaces), and formats (how ads render)
  - Includes migration guide and edge cases documentation

- a0039cc: Clarify pricing option field semantics with better separation of hard constraints vs soft hints

  **Breaking Changes:**

  - Rename `fixed_rate` → `fixed_price` in all pricing option schemas
  - Move `price_guidance.floor` → top-level `floor_price` field
  - Remove `is_fixed` discriminator (presence of `fixed_price` indicates fixed pricing)

  **Schema Consolidation:**

  - Consolidate 9 pricing schemas into 7 (one per pricing model)
  - All models now support both fixed and auction pricing modes

  **Semantic Distinction:**

  - Hard constraints (`fixed_price`, `floor_price`) - Publisher-enforced prices that cause bid rejection
  - Soft hints (`price_guidance.p25`, `.p50`, `.p75`, `.p90`) - Historical percentiles for bid calibration

- 5e40c85: Rename `refine[]` entity ids to `product_id` / `proposal_id` and make `action` optional (default `include`)

  The `refine` array on `get_products` now uses prefixed id fields inside each scope branch — `product_id` under `scope: "product"` and `proposal_id` under `scope: "proposal"` — replacing the previous generic `id` field. This matches the id naming convention AdCP uses everywhere else in the protocol (`media_buy_id`, `plan_id`, `creative_id`, `account_id`, etc.).

  `action` is now optional on product and proposal entries with a default of `"include"`. Orchestrators only need to set `action` explicitly for non-default behaviors: `"omit"` / `"more_like_this"` on products, `"omit"` / `"finalize"` on proposals.

  The response `refinement_applied[]` changed to echo the matching id fields (`product_id` or `proposal_id`) instead of a generic `id`, so request and response use the same vocabulary. Each `refinement_applied` entry is now a discriminated union on `scope` (parallel to the request shape), and `scope` + the matching id field are required when the seller returns `refinement_applied`, making cross-validation a contract rather than a convention.

  An OpenAPI-style `discriminator: { propertyName: "scope" }` annotation is now present on both request `refine[]` and response `refinement_applied[]`, so typed clients (TypeScript, Python/Pydantic) generate narrowed discriminated unions rather than anonymous flat unions.

  **Migration from earlier 3.0 pre-releases:**

  | Before                                                                          | After                                                                                   |
  | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
  | `{ "scope": "product", "id": "p1", "action": "include" }`                       | `{ "scope": "product", "product_id": "p1" }`                                            |
  | `{ "scope": "product", "id": "p1", "action": "include", "ask": "add 16:9" }`    | `{ "scope": "product", "product_id": "p1", "ask": "add 16:9" }`                         |
  | `{ "scope": "product", "id": "p1", "action": "omit" }`                          | `{ "scope": "product", "product_id": "p1", "action": "omit" }`                          |
  | `{ "scope": "proposal", "id": "pr1", "action": "finalize" }`                    | `{ "scope": "proposal", "proposal_id": "pr1", "action": "finalize" }`                   |
  | `refinement_applied: [{ "scope": "product", "id": "p1", "status": "applied" }]` | `refinement_applied: [{ "scope": "product", "product_id": "p1", "status": "applied" }]` |

  Each scope branch in both `refine[]` and `refinement_applied[]` is `additionalProperties: false`, so leftover `id` fields from the pre-rename shape are now rejected with a `"must NOT have additional properties"` validation error rather than being silently ignored. If you see that error after upgrading, search your orchestrator code for `id` inside refine entries and rename to `product_id` / `proposal_id`.

- 7cf7476: Remove `estimated_exposures` from Product, replace with optional `forecast`

  - Remove the unitless `estimated_exposures` integer field from the Product schema
  - Add optional `forecast` field using the existing `DeliveryForecast` type, giving buyers structured delivery estimates with time periods, metric ranges, and methodology context during product discovery

- ad33379: Remove FormatCategory enum and `type` field from Format objects

  The `format-category.json` enum, `type` field on Format, `format_types` filter on product-filters and creative-filters, and `type` filter on list-creative-formats-request have been removed.

  **What to use instead:**

  - To understand what a format requires: inspect the `assets` array
  - To filter formats by content type: use the `asset_types` filter on `list_creative_formats`
  - To filter products by channel: use the `channels` filter on `get_products`
  - To filter by specific formats: use `format_ids`

  **Breaking changes:**

  - `format-category.json` enum deleted
  - `type` property removed from `format.json`
  - `format_types` removed from `product-filters.json` and `creative-filters.json`
  - `type` filter removed from `list-creative-formats-request.json`

- 811bd0e: Redesign `refine` as a typed change-request array with seller acknowledgment

  The `refine` field is now an array of change requests, each with a `scope` discriminator (`request`, `product`, or `proposal`) and an `ask` field describing what the buyer wants. The seller responds via `refinement_applied` — a positionally-matched array reporting whether each ask was `applied`, `partial`, or `unable`. This replaces the previous object structure with separate `overall`, `products`, and `proposals` fields.

- 31aab3a: Rename the `inventory-lists` specialism to `property-lists` to match the tool family it actually tests (`create_property_list`, `validate_property_delivery`, etc.). The original name was flagged as onboarding friction in the fresh-builder specialism test (#2287): the specialism claimed to cover "property and collection lists" but the storyboard only exercised property-list tools, and every builder fumbled the `inventory-lists` ↔ `property_list` mapping. A dedicated `collection-lists` specialism can be added later when that storyboard is written.

  **Changes.**

  - `specialism` enum: `inventory-lists` → `property-lists` (wire ID), with updated `enumDescription` scoped to property lists only.
  - Compliance source: `static/compliance/source/specialisms/inventory-lists/` → `property-lists/`. In `index.yaml`: `id: inventory_lists` → `property_lists`, `category: inventory_lists` → `property_lists`, `title: "Inventory lists"` → `"Property lists"`, capability tag and all step `correlation_id`s updated. Summary narrowed to property-list scope (removed "and collection").
  - `storyboard-schema.yaml` governance-categories comment updated.
  - `compliance-catalog.mdx`: governance table, naming conventions example, mapping table, and tool-family prose bullet now use `property-lists` / `property_lists`.
  - `glossary.mdx`: added **Specialism**, **Storyboard**, and **Storyboard Category** entries documenting the kebab↔snake split between wire IDs, storyboard categories, and prose titles.

  **Not renamed.** The media-buy scenarios `media_buy_seller/inventory_list_targeting` and `media_buy_seller/inventory_list_no_match` keep their IDs — they genuinely exercise both `PropertyListReference` and `CollectionListReference` targeting and are correctly "inventory list" umbrella scenarios.

  **Wire enum change (RC-window), no alias.** The `specialism` enum is only shipping in 3.0-rc.3 and has no published SDK or registered agent declaring `inventory-lists` today (verified across server, skills, docs, dist schemas, AAO runner). An alias would be dead weight. Contrast with the `audience-sync-domain-and-naming-docs` rename, which did emit transitional aliases because `@adcp/client@5.x` reads the old key — no comparable consumer exists here.

  Closes #2287 (the last open sub-issue of the fresh-builder epic #2288).

- a90700f: Revert geo capability flattening from #2143. Restore `geo_countries`, `geo_regions` (booleans) and `geo_metros`, `geo_postal_areas` (typed objects with `additionalProperties: false`) as primary geo capability fields. Remove `supported_geo_levels`, `supported_metro_systems`, `supported_postal_systems` arrays. Typed objects provide better static type safety and match what beta/RC users have already implemented against.
- 544230b: Address schema gaps that block autonomous agent operation, plus consistency fixes.

  **Error handling (#1223)**

  - `Error`: add `recovery` field (`transient | correctable | terminal`) so agents can classify failures without escalating every error to humans
  - New `enums/error-code.json`: standard vocabulary (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `PRODUCT_UNAVAILABLE`, `PROPOSAL_EXPIRED`, `BUDGET_TOO_LOW`, `CREATIVE_REJECTED`, `UNSUPPORTED_FEATURE`, `AUDIENCE_TOO_SMALL`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SUSPENDED`)

  **Idempotency (#1224)**

  - `UpdateMediaBuyRequest`, `SyncCreativesRequest`: add `idempotency_key` for safe retries after timeouts
  - `CreateMediaBuyRequest.buyer_ref`: document deduplication semantics (buyer_ref is the idempotency key for create)

  **Media buy lifecycle (#1225)**

  - `MediaBuyStatus`: add `rejected` enum value for post-creation seller declines
  - `MediaBuy`: add `rejection_reason` field present when `status === rejected`

  **Protocol version (#1226)**

  - `GetAdCPCapabilitiesResponse.adcp.major_versions`: document version negotiation via capabilities handshake; HTTP header is optional

  **Async polling (#1227)**

  - `GetAdCPCapabilitiesResponse.adcp`: add `polling` object (`supported`, `recommended_interval_seconds`, `max_wait_seconds`) for agents without persistent webhook endpoints

  **Package response (#1229)**

  - `Package`: add `catalogs` (array) and `format_ids` fields echoed from the create request so agents can verify what the seller stored

  **Signal deactivation (#1231)**

  - `ActivateSignalRequest`: add `action: activate | deactivate` field with `activate` default; deactivation removes segments from downstream platforms to support GDPR/CCPA compliance

  **Signal metadata (#1232)**

  - `GetSignalsResponse` signal entries: add `categories` (for `categorical` signals) and `range` (for `numeric` signals) so buyers can construct valid targeting values

  **Property list filters (#1233)**

  - `PropertyListFilters`: make `countries_all` and `channels_any` optional; omitting means no restriction (enables global lists and all-channel lists)

  **Content standards response (#1234)**

  - `UpdateContentStandardsResponse`: replace flat object with `UpdateContentStandardsSuccess | UpdateContentStandardsError` discriminated union (`success: true/false`) consistent with all other write operations

  **Product refinement (#1235)**

  - `GetProductsRequest`: add `buying_mode: "refine"` with `refine` array of typed change requests — each entry declares a `scope` (`request`, `product`, or `proposal`) with an `ask` field. `GetProductsResponse`: add `refinement_applied` array where the seller acknowledges each ask by position (`applied`, `partial`, or `unable`)

  **Creative assignments (#1237)**

  - `SyncCreativesRequest.assignments`: replace ambiguous `{ creative_id: package_id[] }` map with typed array `{ creative_id, package_id, weight?, placement_ids? }[]`

  **Batch preview (#1238)**

  - `PreviewBatchResultSuccess`: add required `success: true`, `creative_id`, proper `response` object with `previews` and `expires_at`
  - `PreviewBatchResultError`: add required `success: false`, `creative_id`, `errors: Error[]` (referencing standard Error schema)

  **Creative delivery pagination (#1239)**

  - `GetCreativeDeliveryRequest.pagination`: replace ad-hoc `limit/offset` with standard `PaginationRequest` cursor-based pagination

  **Signals account consistency (#1242)**

  - `GetSignalsRequest`, `ActivateSignalRequest`: replace `account_id: string` with `account: $ref account-ref.json` for consistency with all other endpoints

  **Signals field naming (#1244)**

  - `ActivateSignalRequest`: rename `deployments` to `destinations` for consistency with `GetSignalsRequest`

  **Creative features billing (#1245)**

  - `GetCreativeFeaturesRequest`: add optional `account` field for governance agents that charge per evaluation

  **Consent basis enum (#1246)**

  - New `enums/consent-basis.json`: extract inline GDPR consent basis enum to shared schema

  **Date range extraction (#1247)**

  - New `core/date-range.json` and `core/datetime-range.json`: extract duplicated inline period objects from financials, usage, and feedback schemas

  **Creative features clarity (#1248)**

  - `GetCreativeFeaturesRequest`/`Response`: clarify description to make evaluation semantics explicit

  **Remove non-standard keyword (#1250)**

  - `SyncAudiencesRequest`: remove ajv-specific `errorMessage` keyword that violates JSON Schema draft-07

  **Package catalogs**

  - `Package`, `PackageRequest`: change `catalog` (single) to `catalogs` (array) to support multi-catalog packages (e.g., product + store catalogs)

  **Error code vocabulary expansion (#1269–1276)**

  - `ErrorCode`: add `BUDGET_EXHAUSTED` (account/campaign budget spent, distinct from `BUDGET_TOO_LOW`) and `CONFLICT` (concurrent modification)
  - `Error.code`: stays `type: string` (not wired to enum) so sellers can use platform-specific codes; description references error-code.json as the standard vocabulary

  **Frequency cap semantics (#1272)**

  - `FrequencyCap`: add normative AND semantics — when both `suppress` and `max_impressions` are set, an impression is delivered only if both constraints permit it

  **Catalog uniqueness (#1276)**

  - `Package`, `PackageRequest`: strengthen catalog type uniqueness from SHOULD to MUST; sellers MUST reject duplicates with `validation_error`

  **Creative weight semantics**

  - `CreativeAssignment`, `SyncCreativesRequest.assignments`: clarify weight is relative proportional (weight 2 = 2x weight 1), omitted = equal rotation, 0 = assigned but paused

  **Outcome measurement window (breaking)**

  - `OutcomeMeasurement.window`: change from `type: string` (e.g., `"30_days"`) to `$ref: duration.json` (structured `{interval, unit}`)

  **Media buy lifecycle**

  - `MediaBuyStatus`: add `canceled` (buyer-initiated termination, distinct from `completed` and `rejected`)
  - `GetMediaBuyDeliveryResponse`: add `canceled` to inline status enum

- 5ecc29d: Remove buyer_ref, buyer_campaign_ref, and campaign_ref. Seller-assigned media_buy_id and package_id are canonical. Add idempotency_key to all mutating requests. Replace structured governance-context.json with opaque governance_context string in protocol envelope and check_governance.
- 96a90ec: Standardize cursor-based pagination across all list operations.

  ### Breaking Changes

  - **`list_creatives`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`tasks_list`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`list_property_lists`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_property_list`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_media_buy_artifacts`**: Move top-level `limit`/`cursor` into nested `pagination` object

  ### Non-Breaking Changes

  - Add shared `pagination-request.json` and `pagination-response.json` schemas to `core/`
  - Add optional `pagination` support to `list_accounts`, `get_products`, `list_creative_formats`, `list_content_standards`, and `get_signals`
  - Update documentation for all affected operations

  All list operations now use a consistent pattern: `pagination.max_results` + `pagination.cursor` in requests, `pagination.has_more` + `pagination.cursor` + optional `pagination.total_count` in responses.

- 4c33b99: Add required `buying_mode` discriminator to `get_products` request for explicit wholesale vs curated buying intent.

  Buyers with their own audience stacks (DMPs, CDPs, AXE integrations) can now set `buying_mode: "wholesale"` to declare they want raw inventory without publisher curation. Buyers using curated discovery set `buying_mode: "brief"` and include `brief`. This removes ambiguity from legacy requests that omitted `buying_mode`.

  When `buying_mode` is `"wholesale"`:

  - Publisher returns products supporting buyer-directed targeting
  - No AI curation or personalization is applied
  - No proposals are returned
  - `brief` must not be provided (mutually exclusive)

### Minor Changes

- 8b8b63c: Add A2UI and MCP Apps support to Sponsored Intelligence for agent-driven UI rendering.
- d7e7550: Add optional account_id parameter to get_media_buy_delivery and get_media_buy_artifacts requests, allowing buyers to scope queries to a specific account.
- b708168: Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

  `account_id` is optional on `create_media_buy`. Single-account agents can omit it; multi-account agents must provide it.

  - `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
  - `authorized_operators` in brand.json: Brand declares which operators can represent them
  - Account capabilities in `get_adcp_capabilities`: require_operator_auth, supported_billing, required_for_products
  - Three-party billing model: brand, operator, agent
  - Account status lifecycle: active, pending_approval, payment_required, suspended, closed

- 142bcd5: Replace account_id with account reference, restructure account model.

  - Add `account-ref.json`: union type accepting `{ account_id }` or `{ brand, operator }`
  - Use `brand-ref.json` (domain + brand_id) instead of flat house + brand_id in account schemas
  - Make `operator` required everywhere (brand sets operator to its own domain when operating its own seat)
  - Add `account_resolution` capability (string: `explicit_account_id` or `implicit_from_sync`)
  - Simplify billing to `operator` or `agent` only (brand-as-operator when brand pays directly)
  - **Breaking**: `billing` is now required in `sync_accounts` request (previously optional). Existing callers that omit `billing` will receive validation errors. Billing is accept-or-reject — sellers cannot silently remap billing.
  - Make `account` required on create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
  - Make `account` required per record on report_usage
  - `sync_accounts` no longer returns `account_id` — the seller manages account identifiers internally. Buyers discover IDs via `list_accounts` (explicit model) or use natural keys (implicit model).
  - Make `account_id` required in `account.json` (remove conditional if/then — the schema is only used in seller responses where the seller always has an ID)
  - Add `account_scope` to account and sync_accounts response schemas
  - Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes
  - Add `get_account_financials` task for operator-billed account financial status

- 8e37138: Add accounts and agents specification to AdCP protocol.

  AdCP now distinguishes three entities in billable operations:

  - **Brand**: Whose products are advertised (identified by brand manifest)
  - **Account**: Who gets billed, what rates apply (identified by `account_id`)
  - **Agent**: Who is placing the buy (identified by authentication token)

  New schemas:

  - `account.json`: Billing relationship with rate cards, payment terms, credit limits
  - `list-accounts-request.json` / `list-accounts-response.json`: Discover accessible accounts

  Updated schemas:

  - `media-buy.json`: Added account attribution
  - `create-media-buy-request.json`: Added optional `account_id` field
  - `create-media-buy-response.json`: Added account in response
  - `get-products-request.json`: Added optional `account_id` for rate card context
  - `sync-creatives-request.json`: Added optional `account_id` field for creative ownership
  - `sync-creatives-response.json`: Added account attribution in response
  - `list-creatives-response.json`: Added account attribution per creative
  - `creative-filters.json`: Added `account_ids` filter for querying by account

  Deprecates the "Principal" terminology in favor of the more precise Account/Agent distinction.

- d238645: Expand `adagents.json` to support richer publisher authorization and placement governance.

  This adds scoped authorization fields for property-side `authorized_agents`, including:

  - `delegation_type`
  - `collections`
  - `placement_ids`
  - `placement_tags`
  - `countries`
  - `effective_from`
  - `effective_until`
  - `exclusive`
  - `signing_keys`

  It also adds publisher-level placement governance with:

  - top-level `placements`
  - top-level `placement_tags`
  - canonical `placement-definition.json`

  Validation and tooling are updated to enforce placement-to-property linkage, placement tag scoping, country and time-window constraints, and authoritative-location resolution. Related docs are updated to explain the stronger publisher authorization model and compare `adagents.json` with `ads.txt`.

- 0da0b36: Add channel fields to property and product schemas. Properties can now declare `supported_channels` and products can declare `channels` to indicate which advertising channels they align with. Both fields reference the Media Channel Taxonomy enum and are optional.
- ec06d47: Add `collection-lists` specialism covering program-level brand safety via collection-list CRUD. Closes #2330.

  Collection lists operate on content programs (shows, series, podcasts) identified by platform-independent IDs (IMDb, Gracenote, EIDR), parallel to the `property-lists` specialism which operates on technical surfaces (domains, apps). The new specialism bundle exercises the full CRUD lifecycle — `create_collection_list`, `list_collection_lists`, `get_collection_list` (with `resolve: true`), `update_collection_list`, `delete_collection_list` — plus capability discovery.

  **Scope (CRUD-only, by design).** Unlike `property-lists`, collection lists have no `validate_collection_delivery` counterpart yet. Enforcement is setup-time (the governance agent resolves the list, sellers cache it, delivery matches at serve time) rather than post-hoc. When `validate_collection_delivery` is added, a validation phase can be appended to this specialism.

  **Additive enum value.** `collection-lists` is new — no existing agent declares it, so no migration required. Minor rather than major bump.

  **Training agent fix.** Several property-list and collection-list tool definitions were missing `brand` (and `resolve` on `get_property_list`) from their inputSchema, even though the handlers already read those fields for session keying. MCP clients that strip undeclared fields were collapsing post-create calls to an empty session — making the CRUD lifecycle fail on the second call. Tool inputSchemas now declare these fields. This also repairs the `property-lists` storyboard smoke path, which was failing end-to-end against the deployed training agent for the same reason. An in-tree storyboard test (`server/tests/unit/collection-lists-storyboard.test.ts`) pins the invariant.

- ac4a81f: Add CPA (Cost Per Acquisition) pricing model for outcome-based campaigns.

  CPA enables advertisers to pay per conversion event (purchase, lead, signup, etc.) rather than per impression or click. The pricing option declares which `event_type` triggers billing, independent of any optimization goal.

  This single model covers use cases previously described as CPO (Cost Per Order), CPL (Cost Per Lead), and CPI (Cost Per Install) — differentiated by event type rather than separate pricing models.

  New schema:

  - `cpa-option.json`: CPA pricing option (fixed price per conversion event)

  Updated schemas:

  - `pricing-model.json`: Added `cpa` enum value
  - `pricing-option.json`: Added cpa-option to discriminated union
  - `index.json`: Added cpa-option to registry

- cd0274e: Add "creative" to supported_protocols enum in get_adcp_capabilities. Creative agents indicate protocol support via presence in supported_protocols array.
- 34ece9f: Add conversion tracking with log_event and sync_event_sources tasks
- 098fce2: Add TIME pricing model for sponsorship-based advertising where price scales with campaign duration. Supports hour, day, week, and month time units with optional min/max duration constraints.
- c5b3143: Add advertiser industry taxonomy. New `advertiser-industry` enum with two-level dot-notation categories (e.g., `media_entertainment.podcasts`, `technology.software`). The brand manifest `industries` field now references the enum, and `CreateMediaBuyRequest` gains an optional `advertiser_industry` field so agents can classify the advertiser when creating campaigns. Sellers map these to platform-native codes (Spotify ADV categories, LinkedIn industry IDs, IAB Content Taxonomy). Includes restricted categories (gambling_betting, cannabis, dating) that platforms require explicit declaration for.
- 63dba34: Add broadcast TV support: Ad-ID creative identifiers, broadcast spot reference formats, agency estimate numbers, and measurement maturation windows.

  - Add `industry_identifiers` to creative-asset and creative-manifest schemas with `creative-identifier-type` enum (ad_id, isci, clearcast_clock)
  - Add broadcast spot reference formats (15s, 30s, 60s) — video file only, no VAST/trackers/clickthrough
  - Add `agency_estimate_number` to create-media-buy-request, package-request, and confirmed package schemas
  - Add `measurement-window` schema and `measurement_windows` array on reporting-capabilities for broadcast Live/C3/C7 windows
  - Add `measurement_window` field on billing_measurement in measurement-terms for guarantee basis
  - Add broadcast TV channel documentation and broadcast seller storyboard
  - Extend `video-asset-requirements` schema with GOP, scan type, moov atom, audio codec/loudness fields
  - Align reference format and doc requirements field names to match schema (`containers`, `codecs`, `min_duration_ms`, etc.)

- fe079dc: Rename `ai_media` channel to `sponsored_intelligence` in media channel taxonomy. Sponsored Intelligence is the umbrella for all AI platform advertising — AI assistants, AI search, and generative AI experiences via the reversed data flow. SI Chat Protocol is the specific conversational format.
- ff62171: Add `app` catalog type for mobile app install and re-engagement advertising.

  Introduces `AppItem` schema with fields for `bundle_id`, `apple_id`, `platform` (ios/android), store metadata, and deep links. Maps to Google App Campaigns, Apple Search Ads, Meta App Ads, TikTok App Campaigns, and Snapchat App Install Ads.

  Also adds `app_id` to `content-id-type` for conversion event matching and `APP_ITEM_ID` to universal macros for tracking URL substitution.

- 466481f: **Breaking for payload authors:** Creative asset payloads must now include an `asset_type` field naming the asset variant (`image`, `video`, `audio`, `vast`, `daast`, `text`, `url`, `html`, `javascript`, `webhook`, `css`, `markdown`, `brief`, `catalog`). All 14 asset schemas now declare `asset_type` as a required `const`, and the composite schemas `core/creative-manifest.json`, `core/creative-asset.json`, `core/offering-asset-group.json`, and `creative/list-creatives-response.json` now use `oneOf` + `discriminator: { propertyName: "asset_type" }` in place of the prior 14-branch `anyOf`. Existing payloads that omit `asset_type` will fail validation and must add it.

  **Migration for authors:** for every asset value in `creative_manifest.assets`, `creative.assets`, `offering_asset_group.items`, and `list_creatives` responses, add `"asset_type": "<type>"` alongside the existing fields. The type must match the registry at `/schemas/creative/asset-types`.

  - `brief` assets: before this change some examples (and likely some copy-pasted integrations) used a shortcut shape `{ "content": "..." }` that was passing validation under the prior `anyOf` only because ajv matched the `text-asset` branch. The brief-asset payload must conform to `core/creative-brief.json` — at minimum `{ "asset_type": "brief", "name": "<brief name>" }`. Move free-text prompts into `messaging.key_messages[]` or another brief field rather than a bare `content` string.
  - `vast` and `daast` assets carry a nested discriminator — `asset_type` at the root plus an inner `oneOf` on `delivery_type` (`"url"` vs `"inline"`). Future asset schemas with internal variants should adopt the same nested-discriminator pattern rather than splitting variants into separate top-level `asset_type` values.

  **Validator win:** ajv 8 consumers that enable `discriminator: true` (now on by default in the storyboard lint and docs validator) report errors against only the branch selected by `asset_type` instead of every branch. A previously-noisy 60+-fingerprint ratchet entry in `sales-social/index.yaml#catalog_driven_dynamic_ads/sync_dpa_creative` collapses to 2 fingerprints — just the actual URL format issue. The overall ratchet allowlist shrinks by 85 lines. Validators that do not enable the `discriminator` keyword still accept or reject the same payloads; they just emit the old N-branch error list.

  **Governance request schemas:** `governance/report-plan-outcome-request.json`, `governance/check-governance-request.json`, and `governance/get-plan-audit-logs-request.json` now document on `plan_id` / `plan_ids` that the plan uniquely scopes account and operator and that an explicit `account` field is rejected by `additionalProperties: false`. Turns a silent rejection into a readable contract. Fixtures that previously echoed `account` alongside `plan_id` (which were already rejected) have been cleaned up in the governance storyboards.

- f4ef555: Add unified `assets` field to format schema for better asset discovery

  - Add new `assets` array to format schema with `required` boolean per asset
  - Deprecate `assets_required` (still supported for backward compatibility)
  - Enables full asset discovery for buyers and AI agents to see all supported assets
  - Optional assets like impression trackers can now be discovered and used

- a854090: Add attribution window metadata to delivery response. The response root now includes an optional `attribution_window` object describing `post_click` and `post_view` (duration objects), and attribution `model` (last_touch, first_touch, linear, time_decay, data_driven). Placed at response level since all media buys from a single seller share the same attribution methodology. Enables cross-platform comparison of conversion metrics.
- 257463e: Add structured audience data for bias/fairness governance validation.

  **Schemas**: audience-selector (signal ref or description), audience-constraints (include/exclude), policy-category-definition (regulatory regime groupings), attribute-definition (restricted data categories), match-id-type (identity resolution enum), restricted-attribute (GDPR Article 9 enum).

  **Plan fields**: policy_categories, audience constraints (include/exclude), restricted_attributes, restricted_attributes_custom, min_audience_size. Separates brand.industries (what the company is) from plan.policy_categories (what regulatory regimes apply).

  **Governance**: audience_targeting on governance-context and planned-delivery for three-way comparison. audience_distribution on delivery_metrics for demographic drift detection. restricted_attributes and policy_categories on signal-definition.json for structural governance matching.

  **Registry**: 10 policy category definitions (children_directed, political_advertising, age_restricted, gambling_advertising, fair_housing, fair_lending, fair_employment, pharmaceutical_advertising, health_wellness, firearms_weapons). 8 restricted attribute definitions (GDPR Article 9 categories). 13 seed policies covering US (FHA, ECOA, EEOC, COPPA, FDA DTC, FTC health claims, TTB alcohol, state gambling), EU (DSA political targeting, prescription DTC ban, GDPR special category targeting), and platform (special ad categories, firearms) regulations.

  **Media buy**: per-identifier-type match_breakdown and effective_match_rate on sync_audiences response (#1314).

  **Docs**: Updated governance specification, sync_plans, check_governance, policy registry, sync_audiences, brand protocol, and signal/data provider documentation.

  **Breaking changes** (pre-1.0 RC — expected):

  - `brand.industry` (string) renamed to `brand.industries` (string array). See migration guide.
  - `policy-entry.verticals` renamed to `policy-entry.policy_categories`.

  **Design notes**:

  - `policy_categories` on plans is intentionally freeform `string[]` (not an enum). Unlike GDPR Article 9 restricted attributes (a closed legal text), policy categories are open-ended — new jurisdictions and regulatory regimes add categories over time. Validation is at the registry level, not the schema level.
  - `audience-selector.json` uses flat `oneOf` with four inline variants (signal-binary, signal-categorical, signal-numeric, description) rather than `allOf` composition with `signal-targeting.json`. This avoids codegen fragility — `allOf` with `$ref` breaks quicktype, go-jsonschema, and similar tools.

- 8ec2ab3: Add `external_id` field to AudienceMember for buyer-assigned stable identifiers (CRM record ID, loyalty ID). Remove `external_id` from uid-type enum — it was not a universal ID and belongs as a dedicated field. Add `external_id` to `supported_identifier_types` in capabilities so sellers can advertise support.
- c17b119: Support availability forecasts for guaranteed and direct-sold inventory

  - Make `budget` optional on `ForecastPoint` — when omitted, the point represents total available inventory for the requested targeting and dates
  - Add `availability` value to `forecast-range-unit` enum for forecasts where metrics express what exists, not what a given spend level buys
  - Guaranteed products now include availability forecasts with `metrics.spend` expressing estimated cost
  - Update delivery forecast documentation with availability forecast examples and buyer-side underdelivery calculation guidance

- 5e9a748: Add generic `agents` array to brand.json for brand and house objects. Replaces the pattern of adding named agent fields (`brand_agent`, `rights_agent`) with a typed array that supports brand, rights, measurement, governance, creative, buying, and signals agent types. Deprecates `brand_agent` and `rights_agent` fields.
- fc14940: Add brand protocol rights lifecycle: get_rights, acquire_rights, update_rights with generation credentials, creative approval, revocation notifications, and usage reporting. Includes rights-terms shared schema, authenticated webhooks (HMAC-SHA256), actionable vs final rejection convention, DDEX PIE mapping for music licensing, and sandbox tooling for scenario testing.
- 8a8e4e7: Add Brand Protocol for brand discovery and identity resolution

  Schema:

  - Add brand.json schema with 4 mutually exclusive variants:
    - Authoritative location redirect
    - House redirect (string domain)
    - Brand agent (MCP-based)
    - House portfolio (full brand hierarchy)
  - Support House/Brand/Property hierarchy parallel to Publisher/Property/Inventory
  - Add keller_type for brand architecture (master, sub-brand, endorsed, independent)
  - Add flat names array for localized brand names and aliases
  - Add parent_brand for sub-brand relationships
  - Add properties array on brands for digital property ownership

  Builder Tools:

  - Add brand.html builder tool for creating brand.json files
  - Supports all 4 variants: portfolio, house redirect, agent, authoritative location
  - Live JSON preview with copy/download functionality
  - Domain validation against existing brand.json files

  Manifest Reference Registry:

  - Add manifest_references table for member-contributed references (not content)
  - References point to URLs or MCP agents where members host their own manifests
  - Support both brand.json and adagents.json references
  - Verification status tracking (pending, valid, invalid, unreachable)
  - Completeness scoring for ranking when multiple refs exist for same domain

  Infrastructure:

  - Add BrandManager service for validation and resolution from well-known URLs
  - Add MCP tools: resolve_brand, validate_brand_json, validate_brand_agent
  - Add manifest reference API routes: list, lookup, create, verify, delete
  - Add TypeScript types: BrandConfig, BrandDefinition, HouseDefinition, ResolvedBrand

  Admin UI:

  - Add /admin/manifest-refs page for unified manifest registry management
  - Show all member-contributed references with verification status
  - Add/verify/delete references to brand.json and adagents.json

  Documentation:

  - Add Brand Protocol section as standalone (not under Governance)
  - Complete brand.json specification with all 4 variants documented

- a326b30: Add visual_guidelines to brand.json schema: photography, graphic style, shapes, iconography, composition, motion, logo placement, colorways, type scale, asset libraries, and restrictions. These structured visual rules enable generative creative systems to produce on-brand assets consistently.
- a497d02: Add border_radius, elevation, and spacing definitions to visual_guidelines in brand.json schema. Add extended color roles (heading, body, label, border, divider, surface_1, surface_2) to the colors definition. These are the visual tokens creative agents most often guess wrong when not specified.
- 106831c: Add broadcast TV, audio, and DOOH forecast support: `measurement_source` field on DeliveryForecast to declare which third-party measurement provider produced the forecast numbers (includes global providers: nielsen, videoamp, comscore, geopath, barb, agf, oztam, kantar, barc, route, rajar, triton); `measured_impressions` metric for delivery as counted by the measurement_source provider (independent of guarantee — works with both guaranteed and modeled forecasts); `downloads` metric for podcast advertising; `plays` metric for DOOH raw play counts before impression multiplier; `package` forecast range unit for sellers who offer distinct inventory packages rather than spend curves; `label` field on ForecastPoint to identify packages by name; relax `mid` requirement on ForecastRange to accept either `mid` or both `low`+`high`.
- 44a8be9: Add optional inline preview to build_creative. Request can set `include_preview: true` to get preview renders in the response alongside the manifest. The preview structure matches preview_creative's single response, so clients parse previews identically regardless of source. For single-format requests, `preview_inputs` controls variant generation. For multi-format requests, one default preview per format is returned with explicit `format_id` on each entry. `preview_error` uses the standard error structure (`code`, `message`, `recovery`) for agent-friendly failure handling. Agents that don't support inline preview simply omit the field.
- 1051929: Add optional `campaign_ref` field to `get_products` and `create_media_buy` for grouping related operations under a buyer-defined campaign label. Echoed in media buy responses for CRM and ad server correlation.
- 15a64e6: Refactor `CatalogFieldBinding` schema to use a `kind` discriminator field (`"scalar"`, `"asset_pool"`, `"catalog_group"`) instead of `allOf + oneOf` with negative `not` constraints. Scalar and asset pool variants are extracted to `definitions` for reuse in `per_item_bindings`. Generates a clean TypeScript discriminated union instead of triplicated intersections.
- 5b8feea: Add catalog item macros for item-level attribution: SKU, GTIN, OFFERING_ID, JOB_ID, HOTEL_ID, FLIGHT_ID, VEHICLE_ID, LISTING_ID, STORE_ID, PROGRAM_ID, and DESTINATION_ID (mirroring the content_id_type enum), plus CATALOG_ID for catalog-level attribution and CREATIVE_VARIANT_ID for seller-assigned creative variant tracking. Enables closed-loop attribution from impression tracking through conversion events.
- e2e68d3: Add typed catalog assets, field bindings, and feed field mappings.

  **Typed assets on vertical catalog items**: `hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`, and `app` item schemas now support an `assets` array using `OfferingAssetGroup` structure. Enables buyers to provide typed image pools (`images_landscape`, `images_vertical`, `logo`, etc.) alongside existing scalar fields, so formats can declare which asset group to use for each platform-specific slot rather than relying on a single `image_url`.

  **Field bindings on format catalog requirements**: `catalog_requirements` entries now support `field_bindings` — explicit mappings from format template slots (`asset_id`) to catalog item fields (dot-notation path) or typed asset pools (`asset_group_id`). Supports scalar field binding, asset pool binding, and repeatable group iteration over catalog items. Optional — agents can still infer without bindings.

  **Feed field mappings on catalog**: The `Catalog` object now accepts `feed_field_mappings` for normalizing external feeds during `sync_catalogs` ingestion. Supports field renames, named transforms (`date`, `divide`, `boolean`, `split`) with per-transform parameters, static literal injection, and placement of image URLs into typed asset pools. Eliminates the need to preprocess every non-AdCP feed before syncing.

- a8d3c11: spec: promote PLAN_NOT_FOUND; collapse 11 custom \*\_NOT_FOUND codes to REFERENCE_NOT_FOUND (#2704)

  The uniform-response MUST from #2691 forbade sellers from minting custom
  `*_NOT_FOUND` codes — typed parameters without a dedicated standard code
  MUST use `REFERENCE_NOT_FOUND`. The spec itself was out of compliance:
  12 custom codes appeared in task-reference pages while the normative
  rule forbade them. This PR resolves the incoherence.

  **Promoted to standard vocabulary:**

  - `PLAN_NOT_FOUND` added to `error-code.json` with a uniform-response
    MUST clause parallel to `SIGNAL_NOT_FOUND` / `CREATIVE_NOT_FOUND`.
    Used across `report_plan_outcome`, `get_plan_audit_logs`, and
    `check_governance`; clear recovery path via `sync_plans`. Added to
    both the "Not-found precedence" enumeration and the "Uniform response
    for inaccessible references" MUST-list in `error-handling.mdx`.

  **Collapsed to `REFERENCE_NOT_FOUND`:**

  - `CHECK_NOT_FOUND`, `CAMPAIGN_NOT_FOUND` (report_plan_outcome)
  - `BRAND_NOT_FOUND` (sync_plans)
  - `STANDARDS_NOT_FOUND` (get/update_content_standards)
  - `FORMAT_NOT_FOUND` (list_creative_formats, creative/specification)
  - `AGENT_NOT_FOUND` (get_signals, signals/specification, list_creative_formats)
  - `SIGNAL_AGENT_SEGMENT_NOT_FOUND` (activate_signal, get_signals)
  - `SEGMENT_NOT_FOUND` (glossary)
  - `AUDIENCE_NOT_FOUND` (sync_audiences)
  - `CATALOG_NOT_FOUND` (sync_catalogs)
  - `EVENT_SOURCE_NOT_FOUND` (log_event)

  Each page now names the failed typed parameter in `error.field`. Zero of
  the 11 appeared in JSON schemas, so this is a prose-level cleanup.

  **Signals-spec auth-uniformity tightened:** `docs/signals/specification.mdx`
  previously said "Private Signal Agents MUST return `AGENT_NOT_FOUND`
  for unauthorized accounts." That rule now explicitly routes through
  `REFERENCE_NOT_FOUND` — same response whether the agent exists or the
  caller is unauthorized — preventing cross-tenant enumeration. No
  behavior change for implementers already following the uniform-response
  MUST.

  **Array-parameter guidance added to `error-handling.mdx`:** when the
  failing parameter is an array (e.g., `catalog_ids`, `format_ids`),
  `error.field` names the array itself. Sellers MAY enumerate
  unresolvable elements in `error.details` only when those elements were
  supplied verbatim by the caller; they MUST NOT distinguish
  "authorized-but-missing" from "exists-but-unauthorized" at the
  element level.

  **Glossary redirect:** `docs/reference/glossary.mdx` now lists all 11
  removed codes under the `REFERENCE_NOT_FOUND` entry so searches for
  the old names find migration guidance.

  Release notes bullet added under rc.5 with implementer migration
  guidance.

- 57d6e6c: Add collection lists — program-level brand safety for shows, series, and other content programs across platforms. Collection lists are a parallel construct to property lists: they use distribution identifiers (IMDb, Gracenote, EIDR) for cross-publisher matching and support content rating and genre filters. New targeting overlay fields (collection_list, collection_list_exclude) enable both inclusion and exclusion. New genre taxonomy enum normalizes genre classification across buyers and sellers.
- 8079271: Add commerce attribution metrics to delivery response schema. Adds `new_to_brand_rate` as a first-class field in DeliveryMetrics. Adds `roas` and `new_to_brand_rate` to `aggregated_totals` and `daily_breakdown` in the delivery response. Updates documentation to reflect commerce metric availability.
- 9ae4fdc: Add comply_test_controller tool to training agent for deterministic compliance testing. Fix SISessionStatus description in si-initiate-session-response schema.
- f4ef555: Add Content Standards Protocol for content safety and suitability evaluation.

  Discovery tasks:

  - `list_content_features`: Discover available content safety features
  - `list_content_standards`: List available standards configurations
  - `get_content_standards`: Retrieve content safety policies

  Management tasks:

  - `create_content_standards`: Create a new standards configuration
  - `update_content_standards`: Update an existing configuration
  - `delete_content_standards`: Delete a configuration

  Calibration & Validation tasks:

  - `calibrate_content`: Collaborative dialogue to align on policy interpretation
  - `validate_content_delivery`: Batch validate delivery records

- d6518dc: Add quality parameter to preview_creative for controlling render fidelity (draft vs production). Clarify that creative agents and sales agents are not mutually exclusive. A sales agent can implement the Creative Protocol alongside Media Buy Protocol. Updated documentation, certification curriculum, and training agent.
- cc41e01: Add compliance fields to creative-brief schema. Unify manifest to format_id + assets.

  Add optional `compliance` object to `creative-brief.json` with `required_disclosures` (structured array with text, position, jurisdictions, regulation, min_duration_ms, and language) and `prohibited_claims` (string array). Disclosures support per-jurisdiction requirements via ISO 3166-1/3166-2 codes (country or subdivision). Extract disclosure position to shared `disclosure-position.json` enum with values: prominent, footer, audio, subtitle, overlay, end_card, pre_roll, companion. Creative agents that cannot satisfy a required disclosure MUST fail the request.

  Move `creative_brief` and `catalogs` from top-level manifest fields to proper asset types (`brief` and `catalog`) within the `assets` map. Add `"brief"` and `"catalog"` to the asset-content-type enum. Create `brief-asset.json` and `catalog-asset.json` schemas. Move format-level `catalog_requirements` into the catalog asset's `requirements` field within the format's `assets` array. Add `max_items` to `catalog-requirements.json`. The manifest is now `format_id` + `assets`.

  Add `supported_disclosure_positions` to `format.json` so formats declare which disclosure positions they can render.

  Remove `creative_brief` from `build-creative-request.json` and delete `creative-brief-ref.json`. Remove `supports_brief` capability flag.

  Note: `creative_brief` on manifests, `catalog_requirements` on formats, `creative-brief-ref.json`, and `supports_brief` were added during this beta cycle and never released, so these structural changes are not breaking.

- 5622c51: Add build capability discovery to creative formats.

  `format.json` gains `input_format_ids` — the source creative formats a format accepts as input manifests (alongside the existing `output_format_ids` for what can be produced).

  `list_creative_formats` gains two new filter parameters:

  - `output_format_ids` — filter to formats that can produce any of the specified outputs
  - `input_format_ids` — filter to formats that accept any of the specified formats as input

  Together these let agents ask a creative agent "what can you build?" and query in either direction: "given outputs I need, what inputs do you accept?" or "given inputs I have, what outputs can you produce?"

- 689adb4: Add generation controls to build_creative and preview_creative: quality tier (draft/production), item_limit for catalog cost control, expires_at on build_creative response for generated asset URL expiration, and storyboard reference asset role.
- 7b1d51e: Add `get_creative_features` task for creative governance

  Introduces the creative analog of `get_property_features` — a general-purpose task for evaluating creatives and returning feature values. Supports security scanning, creative quality assessment, content categorization, and any other creative evaluation through the same feature-based pattern used by property governance.

  New schemas:

  - `get-creative-features-request.json` — accepts a creative manifest and optional feature_ids filter
  - `get-creative-features-response.json` — returns feature results with discriminated union (success/error)
  - `creative-feature-result.json` — individual feature evaluation (value, confidence, expires_at, etc.)

  Also adds `creative_features` to the governance section of `get_adcp_capabilities` response, allowing agents to advertise which creative features they can evaluate.

- f460ece: Move list_creatives and sync_creatives from media-buy to creative protocol. All creative library operations now live in one protocol — any agent hosting a creative library implements the creative protocol for both reads and writes. Extend build_creative with library retrieval mode (creative_id, macro_values, media_buy_id, package_id). Add creative agent interaction models (supports_generation, supports_transformation, has_creative_library) to get_adcp_capabilities. New creative-variable.json schema for DCO variable definitions. Redesign list_creatives as a library catalog: replace include_performance/performance_score with include_snapshot (lightweight delivery snapshot following get_media_buys pattern), rename has_performance_data filter to has_served, add errors to response. Rename sub-asset.json to item.json and sub_assets to items throughout — neutral naming that works for both native (flat components) and carousel (repeated groups) patterns.
- 37dbd0d: Add creative delivery reporting to the AdCP specification.

  - Add optional `by_creative` metrics breakdown within `by_package` in delivery responses
  - Add `get_creative_delivery` task on creative agents for variant-level delivery data with manifests
  - Add `creative-variant` core object supporting three tiers: standard (1:1), asset group optimization, and generative creative. Variants include full creative manifests showing what was rendered.
  - Extend `preview_creative` with `request_type: "variant"` for post-flight variant previews
  - Add `selection_mode` to repeatable asset groups to distinguish sequential (carousel) from optimize (asset pool) behavior
  - Add `supports_creative_breakdown` to reporting capabilities
  - Add `delivery` creative agent capability

- 28ba53a: Add weight_grams on image asset requirements for print inserts, and material_submission on products for print creative delivery instructions. Retry transient network failures in owned-link checker. Driven by DBCFM gap analysis.
- 37f46ec: Add delivery forecasting to the Media Buy protocol

  - Add `DeliveryForecast` core type with budget curve, forecast method, currency, and measurement context
  - Add `ForecastRange` core type (low/mid/high) for metric forecasts
  - Add `ForecastPoint` core type — pairs a budget level with metric ranges; single point is a standard forecast, multiple points form a budget curve
  - Add `forecast-method` enum (estimate, modeled, guaranteed)
  - Add `forecastable-metric` enum defining standard metric vocabulary (audience_size, reach, impressions, clicks, spend, etc.)
  - Add `demographic-system` enum (nielsen, barb, agf, oztam, mediametrie, custom) for GRP demographic notation
  - Add `reach-unit` enum (individuals, households, devices, accounts, cookies, custom) for cross-channel reach comparison
  - Add `demographic_system` to CPP pricing option parameters
  - Add optional `forecast` field to `ProductAllocation`
  - Add optional `forecast` field to `Proposal`
  - Add `daypart-target` core type for explicit day+hour targeting windows (follows Google Ads / DV360 pattern)
  - Add `day-of-week` enum (monday through sunday)
  - Add `forecast-range-unit` enum (spend, reach_freq, weekly, daily, clicks, conversions) for interpreting forecast curves
  - Add `daypart_targets` to `Targeting` for hard daypart constraints
  - Add `daypart_targets` to `ProductAllocation` for publisher-recommended time windows in spot plans
  - Add `forecast_range_unit` to `DeliveryForecast` for curve type identification
  - Document forecast scenarios: budget curves, CTV with GRP demographics, retail media with outcomes, allocation-level forecasts

- f37a00c: Deprecate FormatCategory enum and make `type` field optional in Format objects

  The `type` field (FormatCategory) is now optional on Format objects. The `assets` array is the authoritative source for understanding creative requirements.

  **Rationale:**

  - Categories like "video", "display", "native" are lossy abstractions that don't scale to emerging formats
  - Performance Max spans video, display, search, and native simultaneously
  - Search ads (RSA) are text-only with high intent context - neither "display" nor "native" fits
  - The `assets` array already provides precise information about what asset types are needed

  **Migration:**

  - Existing formats with `type` field continue to work
  - New formats may omit `type` entirely
  - Buyers should inspect the `assets` array to understand creative requirements

- 9652531: Add dimension breakdowns to delivery reporting and device_type targeting.

  New enums: `device-type.json` (desktop, mobile, tablet, ctv, dooh, unknown), `audience-source.json` (synced, platform, third*party, lookalike, retargeting, unknown), `sort-metric.json` (sortable numeric delivery-metrics fields). New shared schema: `geo-breakdown-support.json` for declaring geographic breakdown capabilities. Add `device_type` and `device_type_exclude` to targeting overlay. Add `reporting_dimensions` request parameter to `get_media_buy_delivery` for opting into geo, device_type, device_platform, audience, and placement breakdowns with configurable sort and limit. Add corresponding `by*\*`arrays with truncation flags to the delivery response under`by_package`. Declare breakdown support in `reporting_capabilities`(product-level). Add`device_type`to seller-level targeting capabilities in`get_adcp_capabilities`.

  Note: the speculative `by_geography` example in docs (never in the schema or spec) has been replaced with the formal `by_geo` structure.

- fee669b: Add disclosure persistence model for jurisdiction-specific render requirements.

  New `disclosure-persistence` enum with values: `continuous` (must persist throughout content duration), `initial` (must appear at start for minimum duration), `flexible` (presence sufficient, publisher discretion). When multiple sources specify persistence for the same jurisdiction, most restrictive wins: `continuous > initial > flexible`.

  Schema changes:

  - `provenance.json`: new `declared_at` (date-time) recording when the provenance claim was made, distinct from `created_time`. Jurisdiction items in `disclosure.jurisdictions[]` gain `render_guidance` with `persistence`, `min_duration_ms`, and `positions` (ordered preference list).
  - `format.json`: new `disclosure_capabilities` array — each entry pairs a disclosure position with its supported persistence modes. Supersedes `supported_disclosure_positions` for persistence-aware matching; the flat field is retained for backward compatibility. Formats should only claim persistence modes they can enforce.
  - `creative-brief.json`: new optional `persistence` on `compliance.required_disclosures[]` items.
  - `list-creative-formats-request.json` (media-buy and creative domains): new `disclosure_persistence` filter. Creative-domain request also gains `disclosure_positions` filter for parity with media-buy.
  - `error-code.json`: `COMPLIANCE_UNSATISFIED` description updated to cover persistence mode mismatches.

- 949c534: Event source health and measurement readiness for conversion tracking quality.

  - **Event source health**: Optional `health` object on each event source in `sync_event_sources` response. Includes status (insufficient/minimum/good/excellent), seller-defined detail, match rate, evaluated_at timestamp, 24h event volume, and actionable issues. Analogous to Snap EQS / Meta EMQ — sellers without native scores derive status from operational metrics.
  - **Measurement readiness**: Optional `measurement_readiness` on products in `get_products` response. Evaluates whether the buyer's event setup is sufficient for the product's optimization capabilities. Includes status, required/missing event types, and issues.
  - New schemas: `event-source-health.json`, `measurement-readiness.json`, `diagnostic-issue.json`, `assessment-status.json` enum

- fe61385: Add exclusivity enum and preferred_delivery_types to product discovery

  - New `exclusivity` enum (none, category, exclusive) on products and as a filter
  - New `preferred_delivery_types` soft preference array on get_products requests
  - Documentation for publisher product design patterns, content sponsorship, and delivery preferences

- d874136: Add experimental status mechanism and codify extensibility policy.

  - New page `docs/reference/experimental-status.mdx` defines what experimental means, graduation criteria (≥1 production implementer for ≥45 days OR ≥2 implementers, no open breaking-change issues for 30 days, deliberate graduation PR), 6-week breaking-change notice window, and client guidance.
  - `versioning.mdx` carves experimental surfaces out of the 3.x stability guarantees and adds an Extensibility section distinguishing core fields, `ext.{namespace}` additions, and `additionalProperties` containers.
  - `get_adcp_capabilities` response gains `experimental_features[]` — sellers implementing experimental surfaces MUST list them; buyers inspect before relying.
  - Schemas may annotate surfaces with `x-status: experimental`. No schemas carry the annotation in this change; PR 2 applies it to Brand Rights Lifecycle, Campaign Governance, and TMP.

- 0c98c26: Discriminate flat_rate pricing parameters by inventory type and clarify package type names.

  **Breaking for existing v3 DOOH flat_rate parameters:** `flat-rate-option.json` `parameters` now requires a `"type": "dooh"` discriminator field. Existing implementations passing `parameters` without `type` must add `"type": "dooh"`. Sponsorship/takeover flat_rate options that have no `parameters` are unaffected.

  DOOH `parameters` fields: `sov_percentage`, `loop_duration_seconds`, `min_plays_per_hour`, `venue_package`, `duration_hours`, `daypart`, `estimated_impressions`. `min_plays_per_hour` minimum is now 1 (was 0).

  `get-media-buys-response.json` inline package items are now titled `PackageStatus` to distinguish them from `PackageRequest` (create input) and `Package` (create output). The name reflects what this type adds: creative approval state and an optional delivery snapshot.

- ca18472: Flatten `deliver_to` in `get_signals` request into top-level `destinations` and `countries` fields.

  Previously, callers were required to construct a nested `deliver_to` object with `deployments` and `countries` sub-fields, even when querying a platform's own signal agent where the destination is implicit. Both fields are now optional top-level parameters:

  - `destinations`: Filter signals to those activatable on specific agents/platforms. When omitted, returns all signals available on the current agent.
  - `countries`: Geographic filter for signal availability.

- c3a0883: Add optional `start_time` and `end_time` to package schemas and product allocations for per-package flight scheduling.

  - `core/package.json`, `media-buy/package-request.json`, `media-buy/package-update.json`: buyers can set independent flight windows per package within a media buy.
  - `core/product-allocation.json`: publishers can propose per-flight scheduling in proposals.

- cf4e9ee: Extend brand.json fonts schema with structured font definitions. Each font role (primary, secondary, etc.) now accepts either a CSS font-family string or a structured object with `family`, `files` (with `weight`, `weight_range` for variable fonts, and `style`), `opentype_features` (e.g., ss01, tnum), and `fallbacks` for multi-script coverage. This enables creative agents to resolve and render fonts reliably while remaining backward compatible with simple string values.
- 37dbd0d: Add reported_metrics to creative formats and expand available-metric enum
- a859fd1: Add geographic exclusion targeting fields to targeting overlay schema.

  New fields: `geo_countries_exclude`, `geo_regions_exclude`, `geo_metros_exclude`, `geo_postal_areas_exclude`. These enable RCT holdout groups and regulatory compliance exclusions without requiring exhaustive inclusion lists.

- 1590905: Add `geo_proximity` targeting for arbitrary-location proximity targeting. Three methods: travel time isochrones (e.g., "within 2hr drive of Düsseldorf"), simple radius (e.g., "within 30km of Heathrow"), and pre-computed GeoJSON geometry (buyer provides the polygon). Structured capability declaration in `get_adcp_capabilities` allows sellers to declare supported methods and transport modes independently.
- f4ef555: Add protocol-level get_adcp_capabilities task for cross-protocol capability discovery

  Introduces `get_adcp_capabilities` as a **protocol-level task** that works across all AdCP domain protocols.

  **Tool-based discovery:**

  - AdCP discovery uses native MCP/A2A tool discovery
  - Presence of `get_adcp_capabilities` tool indicates AdCP support
  - Distinctive name ensures no collision with other protocols' capability tools
  - Deprecates `adcp-extension.json` agent card extension

  **Cross-protocol design:**

  - `adcp.major_versions` - Declare supported AdCP major versions
  - `supported_protocols` - Which domain protocols are supported (media_buy, signals)
  - `extensions_supported` - Extension namespaces this agent supports (e.g., `["scope3", "garm"]`)
  - Protocol-specific capability sections nested under protocol name

  **Media-buy capabilities (media_buy section):**

  - `features` - Optional features (inline_creative_management, property_list_filtering, content_standards)
  - `execution.axe_integrations` - Agentic ad exchange URLs
  - `execution.creative_specs` - VAST/MRAID version support
  - `execution.targeting` - Geo targeting with granular system support
  - `portfolio` - Publisher domains, channels, countries

  **Geo targeting:**

  - Countries (ISO 3166-1 alpha-2)
  - Regions (ISO 3166-2)
  - Metros with named systems (nielsen_dma, uk_itl1, uk_itl2, eurostat_nuts2)
  - Postal areas with named systems encoding country and precision (us_zip, gb_outward, ca_fsa, etc.)

  **Product filters - two models for geography:**

  _Coverage filters (for locally-bound inventory like radio, OOH, local TV):_

  - `countries` - country coverage (ISO 3166-1 alpha-2)
  - `regions` - region coverage (ISO 3166-2) for regional OOH, local TV
  - `metros` - metro coverage ({ system, code }) for radio, DOOH, DMA-based inventory

  _Capability filters (for digital inventory with broad coverage):_

  - `required_geo_targeting` - filter by seller capability with two-layer structure:
    - `level`: targeting granularity (country, region, metro, postal_area)
    - `system`: classification taxonomy (e.g., 'nielsen_dma', 'us_zip')
  - `required_axe_integrations` - filter by AXE support
  - `required_features` - filter by protocol feature support

  Use coverage filters when products ARE geographically bound (radio station = DMA).
  Use capability filters when products have broad coverage and you'll target at buy time.

  **Targeting schema:**

  - Updated `targeting.json` with structured geo systems
  - `geo_metros` and `geo_postal_areas` now require system specification
  - System names encode country and precision (us_zip, gb_outward, nielsen_dma, etc.)
  - Aligns with capability declarations in get_adcp_capabilities

  **Governance capabilities (governance section):**

  - `property_features` - Array of features this governance agent can evaluate
  - Each feature has: `feature_id`, `type` (binary/quantitative/categorical), optional `range`/`categories`
  - `methodology_url` - Optional URL to methodology documentation (helps buyers understand/compare vendor approaches)
  - Deprecates `list_property_features` task (schemas removed, doc page retained with migration guide)

  **Capability contract:** If a capability is declared, the seller MUST honor it.

- cb5af61: Add `get_media_buys` task for operational campaign monitoring. Returns current media buy status, creative approval state per package, missing format IDs, and optional near-real-time delivery snapshots with `staleness_seconds` to indicate data freshness. Complements `get_media_buy_delivery` which is for authoritative reporting over date ranges.
- df937c8: spec(governance): fragmentation-defense aggregation window

  Adds the `governance.aggregation_window_days` capability (1–365 days,
  no schema default — absence = per-commit evaluation only) and a
  normative "Aggregated-spend evaluation" section to the campaign
  governance specification. Closes the fragmentation attack surface
  where a buyer splits a single large spend into many sub-threshold
  commits across plans, task types, or delegated sub-agents to bypass
  dollar-gated escalations. Governance agents MUST evaluate thresholds
  against the trailing-window aggregate keyed on (buyer_agent,
  seller_agent, account_id) with the delegating principal as
  buyer_agent, include the incoming commit in the sum at evaluation
  time, and cover every spend-commit task. The section now includes an
  evaluation-semantics formula, a composition note for
  reallocation_threshold, and a two-row conformance vector. Buyers MUST
  check the capability before relying on a specific window for
  compliance.

- ff30c6a: Add governance_context to check-governance-request for canonical budget/geo/channel/flight extraction. Add mode to sync-plans plan items. Add committed_budget and typed package budget to report-plan-outcome. Add categories_evaluated and policies_evaluated to check-governance-response.
- f4ef555: Add privacy_policy_url field to brand manifest and adagents.json schemas

  Enables consumer consent flows by providing a link to advertiser/publisher privacy policies. AI platforms can use this to present explicit privacy choices to users before data handoff. Works alongside MyTerms/IEEE P7012 discovery for machine-readable privacy terms.

- daff9a2: Make `account` optional in `get_media_buys` request — when omitted, returns data across all accessible accounts. Add backward-compatibility clause to `get_products`: sellers receiving requests from pre-v3 clients without `buying_mode` should default to `"brief"`.
- 13919b5: Add keyword targeting for search and retail media platforms.

  New fields in `targeting_overlay`:

  - `keyword_targets` — array of `{keyword, match_type, bid_price?}` objects for search/retail media targeting. Per-keyword `bid_price` overrides the package-level bid for that keyword and inherits `max_bid` interpretation from the pricing option. Keywords identified by `(keyword, match_type)` tuple.
  - `negative_keywords` — array of `{keyword, match_type}` objects to exclude matching queries from delivery.

  New fields in `package-update` (incremental operations):

  - `keyword_targets_add` — upsert keyword targets by `(keyword, match_type)` identity; adds new keywords or updates `bid_price` on existing ones
  - `keyword_targets_remove` — remove keyword targets by `(keyword, match_type)` identity
  - `negative_keywords_add` — append negative keywords to a live package without replacing the existing list
  - `negative_keywords_remove` — remove specific negative keyword+match_type pairs from a live package

  New field in delivery reporting (`by_package`):

  - `by_keyword` — keyword-grain breakdown with one row per `(keyword, match_type)` pair and standard delivery metrics

  New capability flags in `get_adcp_capabilities`:

  - `execution.targeting.keyword_targets`
  - `execution.targeting.negative_keywords`

  New reporting capability:

  - `reporting_capabilities.supports_keyword_breakdown`

- 046b0f9: Per-storyboard compliance status materialization and `agent.compliance_changed` change feed events.
- 0fb4210: Add `sync_governance` task for syncing governance agent endpoints to accounts. Supports both explicit accounts (account_id) and implicit accounts (brand + operator) via account references. Governance agents removed from `sync_accounts` and `list_accounts`.
- ca12cde: spec(compliance): add `seed_*` values to `ListScenariosSuccess.scenarios` enum

  The `comply_test_controller` request schema enumerates five `seed_*` scenarios (`seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`), but the `ListScenariosSuccess` response enum in `comply-test-controller-response.json` did not — so sellers advertising seed-scenario support had no schema-conformant way to report it. Adds the five seed values to the response enum (additive) and updates the `compliance_testing.scenarios` capability reference in `get_adcp_capabilities` to match. Runners and sellers MUST still accept unknown scenario strings for forward-compat.

- f4ef555: Clarify creative handling in media buy operations:

  **Breaking:** Replace `creative_ids` with `creative_assignments` in `create_media_buy` and `update_media_buy`

  - `creative_assignments` supports optional `weight` and `placement_ids` for granular control
  - Simple assignment: `{ "creative_id": "my_creative" }` (weight/placement optional)
  - Advanced assignment: `{ "creative_id": "my_creative", "weight": 60, "placement_ids": ["p1"] }`

  **Clarifications:**

  - `creatives` array creates NEW creatives only (add `CREATIVE_ID_EXISTS` error)
  - `delete_missing` in sync_creatives cannot delete creatives in active delivery (`CREATIVE_IN_ACTIVE_DELIVERY` error)
  - Document that existing library creatives should be managed via `sync_creatives`

- d874136: Mark Brand Rights Lifecycle, Campaign Governance, and TMP as experimental for AdCP 3.0.

  These surfaces are part of the core protocol but are not yet frozen. Sellers implementing them MUST declare the corresponding feature id in `experimental_features`:

  - `brand.rights_lifecycle` — `get_rights`, `acquire_rights`, `update_rights` and their support schemas (`rights-pricing-option`, `rights-terms`). Added late in the 3.0 cycle; first enterprise deployments will expose edge cases in partial rights, sublicensing, and revocation.
  - `governance.campaign` — `sync_plans`, `check_governance`, `report_plan_outcome`, `get_plan_audit_logs`. Multi-party governance semantics (approval conflicts, audit provenance, tie-breaking) are not yet settled.
  - `trusted_match.core` — the full Trusted Match Protocol. Privacy architecture will evolve with regulator engagement; TMPX, country-partitioned identity, and Offer macros are expected to change.

  Schemas carry `x-status: experimental`. Task reference pages and the campaign-governance and TMP specifications carry a banner. `experimental_features` on `get_adcp_capabilities` is the machine-readable runtime declaration.

  Breaking changes to experimental surfaces require 6 weeks' notice; the full contract is in `docs/reference/experimental-status.mdx`.

- 100b740: Move storyboards from `@adcp/client` into the protocol repo as `/compliance/`
  (universal + domains + specialisms + test-kits), and publish a per-version
  protocol tarball at `/protocol/{version}.tgz` so clients can bulk-sync in one
  request.

  Compliance model for `get_adcp_capabilities`:

  - `supported_protocols` (existing field, expanded) now doubles as the
    compliance-domain claim: each protocol listed commits the agent to pass the
    baseline storyboard at `/compliance/{version}/domains/{protocol}/`
    (snake_case → kebab-case mapping). `compliance_testing` is an RPC surface
    only and has no baseline. `sponsored_intelligence` is a full protocol
    (promoted from a specialism).
  - `specialisms` (new field) — 21 specialization claims, each rolling up to one
    protocol. Includes renames (`broadcast-platform` → `sales-broadcast-tv`,
    `social-platform` → `sales-social`), a merge (`property-governance` +
    `collection-governance` → `inventory-lists`), and four 3.1 archetypes
    flagged `status: preview` (`sales-streaming-tv`, `sales-exchange`,
    `sales-retail-media`, `measurement-verification`) — runner warns rather
    than verifies until their storyboards land.

  Also publishes the `/protocol/` discovery endpoint and a new Compliance
  Catalog page enumerating every protocol + specialism an agent can claim.

- 6a9faa4: build_creative: support multi-format output via target_format_ids

  Add `target_format_ids` array as an alternative to `target_format_id` on build_creative requests. When provided, the creative agent produces one manifest per requested format and returns them in a `creative_manifests` array. This lets buyers request multiple format variants (e.g., 300x250 + 728x90 + 320x50) in a single call instead of making N sequential requests.

  Closes #1395

- c782f66: Note: These changes are breaking relative to earlier betas but no fields removed here were ever in a stable release.

  Add `sync_catalogs` task and unified `Catalog` model. Replace separate `offerings[]` and `product_selectors` fields on `PromotedOfferings` with a typed `Catalog` object that supports inline items, external URL references, and platform-synced catalogs. Expand catalog types beyond offerings and product to include inventory, store, and promotion feeds. Add `sync_catalogs` task with request/response schemas, async response patterns (working, input-required, submitted), per-catalog approval workflow, and item-level review status. Add `catalog_requirements` on `Format` so formats can declare what catalog feeds they need and what fields each must provide. Add `OfferingAssetGroup` schema for structured per-offering creative pools, `OfferingAssetConstraint` for format-level asset requirements, and `geo_targets` on `Offering` for location-specific offerings. Add `account-state` conceptual doc framing Account as the central stateful container in AdCP 3.0. Rename promoted-offerings doc to catalogs to reflect its expanded scope. Add `StoreItem` schema for physical locations within store-type catalogs, with lat/lng coordinates, structured address, operating hours, and tags. Add `Catchment` schema for defining store catchment areas via three methods: isochrone inputs (travel time + transport mode), simple radius, or pre-computed GeoJSON geometry. Add `transport-mode` and `distance-unit` enums. Add industry-vertical catalog types (`hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`) with canonical item schemas for each, drawn from Google Ads, Meta, LinkedIn, and Microsoft platform feed specs. Add shared `Price` schema. Add `linkedin_jobs` feed format. Remove `PromotedOfferings` wrapper — catalogs are now first-class. Creatives reference catalogs via `catalog` field instead of embedding in assets. Remove `promoted_offering` from media-buy and creative-manifest schemas. Add `conversion_events` and `content_id_type` to Catalog for conversion attribution. Rename catalog type `offerings` to `offering` for consistency with other singular type names. Remove `portfolio_ref` from Offering — structured `assets` (OfferingAssetGroup) replaces external portfolio references. Replace `product_selectors` (PromotedProducts) on `get_products` with `catalog` ($ref catalog.json) — one concept, one schema. Delete `promoted-products.json`. Add `catalog_types` to Product so products declare what catalog types they support. Add `matched_ids` and `matched_count` to `catalog_match`, remove `matched_skus`. Add `catalog` field to `package-request` and `package-update` for catalog-driven packages. Add `store_catchments` targeting dimension referencing synced store catalogs. Add `by_catalog_item` delivery breakdown in `get_media_buy_delivery` response for per-item reporting on catalog-driven packages. Update `creative-variant` description to clarify that catalog items rendered as ads are variants.

- f4ef555: Add OpenAI Commerce integration to brand manifest

  - Add `openai_product_feed` as a supported feed format for product catalogs
  - Add `agentic_checkout` object to enable AI agents to complete purchases via structured checkout APIs
  - Document field mapping from Google Merchant Center to OpenAI Product Feed spec

- 0e96a78: Add capability declarations for metric optimization goals, cross-channel engagement metrics, video view duration control, and value optimization.

  **New metric kinds** (`optimization_goals` with `kind: 'metric'`):

  - `engagements` — direct ad interaction beyond viewing: social reactions/comments/shares, story/unit opens, interactive overlay taps on CTV, companion banner interactions on audio
  - `follows` — new followers, page likes, artist/podcast/channel subscribes
  - `saves` — saves, bookmarks, playlist adds, pins
  - `profile_visits` — visits to the brand's page, artist page, or channel

  **Video view duration control:**

  - `view_duration_seconds` on metric goals — minimum view duration (in seconds) that qualifies as a `completed_views` event (e.g., 2s, 6s, 15s). Sellers declare supported durations in `metric_optimization.supported_view_durations`. Sellers must reject unsupported values.

  **New event goal target kind:**

  - `maximize_value` — maximize total conversion value within budget without a specific ROAS ratio target. Steers spend toward higher-value conversions. Requires `value_field` on event sources.

  **Product schema additions:**

  - `metric_optimization` — declares which metric kinds a product can optimize for (`supported_metrics`), which view durations are available (`supported_view_durations`), and which target kinds are supported (`supported_targets`). Presence indicates support for `kind: 'metric'` goals without any conversion tracking setup.
  - `max_optimization_goals` — maximum number of goals a package can carry. Most social platforms accept only 1.

  **Product schema corrections:**

  - `conversion_tracking.supported_optimization_strategies` renamed to `conversion_tracking.supported_targets` for consistency with `metric_optimization.supported_targets`. Both fields answer the same question: "what can I put in `target.kind`?"
  - Target kind enum values aligned across product capabilities and optimization goal schemas. Product `supported_targets` values (`cost_per`, `threshold_rate`, `per_ad_spend`, `maximize_value`) now exactly match `target.kind` values on optimization goals — agents can do direct string comparison.
  - `conversion_tracking` description clarified to be for `kind: 'event'` goals only.

  **Delivery metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` count fields added to delivery-metrics.json so buyers can see performance against the new metric optimization goals.
  - `completed_views` description updated to acknowledge configurable view duration threshold.

  **Forecastable metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` added to forecastable-metric.json for forecast completeness.

  **Capabilities schema addition:**

  - `media_buy.conversion_tracking.multi_source_event_dedup` — declares whether the seller can deduplicate events across multiple sources. When absent or false, buyers should use a single event source per goal.

  **Optimization goal description clarifications:**

  - `event_sources` references the `multi_source_event_dedup` capability; explains first-source-wins fallback when dedup is unsupported.
  - `value_field` and `value_factor` clarified as seller obligations (not optional hints). The seller must use these for value extraction and aggregation. They are not passed to underlying platform APIs.

- 5b25ccd: Redesign optimization goals with multiple event sources, threshold rates, and attention metrics.

  - `optimization_goal` (singular) → `optimization_goals` (array) on packages
  - `OptimizationGoal` is a discriminated union on `kind`:
    - `kind: "event"` — optimize for advertiser-tracked conversion events via `event_sources` array of source-type pairs. Seller deduplicates by `event_id` across sources. Each entry can specify `value_field` and `value_factor` for value-based targets.
    - `kind: "metric"` — optimize for a seller-native delivery metric with optional `cost_per` or `threshold_rate` target
  - Target kinds: `cost_per` (cost per unit), `threshold_rate` (minimum per-impression value), `per_ad_spend` (return ratio on event values), `maximize_value` (maximize total conversion value)
  - Metric enum: `clicks`, `views`, `completed_views`, `viewed_seconds`, `attention_seconds`, `attention_score`, `engagements`, `follows`, `saves`, `profile_visits`
  - Both kinds support optional `priority` (integer, 1 = highest) for multi-goal packages
  - `product.conversion_tracking.supported_targets`: `cost_per`, `per_ad_spend`, `maximize_value`
  - `product.metric_optimization.supported_targets`: `cost_per`, `threshold_rate`

- c4f8f58: Make `delivery_measurement` optional in the product schema. Publishers without integrated measurement tools can now omit this field rather than providing vague values.
- 5c41b60: Add order lifecycle management to the Media Buy Protocol.

  - `confirmed_at` timestamp on create_media_buy response (required) — a successful response constitutes order confirmation
  - Cancellation via update_media_buy with `canceled: true` and optional `cancellation_reason` at both media buy and package level
  - `canceled_by` field (buyer/seller) on media buys and packages to identify who initiated cancellation
  - `canceled_at` timestamp on packages (parity with media buy level)
  - Per-package `creative_deadline` for mixed-channel orders where packages have different material deadlines (e.g., print vs digital)
  - `valid_actions` on get_media_buys response — seller declares what actions are permitted in the current state so agents don't need to internalize the state machine
  - `get_media_buys` MCP tool added to Addie for reading media buy state, creative approvals, and delivery snapshots
  - `revision` number on media buys for optimistic concurrency — callers pass in update requests, sellers reject on mismatch
  - `include_history` on get_media_buys request — opt-in revision history per media buy with actor, action, summary, and package attribution
  - `status` field on update_media_buy response to confirm state transitions
  - Formal state transition diagram and normative rules in specification
  - Valid actions mapping table in specification and get_media_buys docs
  - Curriculum updates: S1 (lifecycle lab), C1 (get_media_buys + lifecycle concepts), A2 (confirmed_at + status check step)
  - `new_packages` on update_media_buy request for adding packages mid-flight. Sellers advertise `add_packages` in `valid_actions`.
  - `CREATIVE_DEADLINE_EXCEEDED` error code — separates deadline violations from content policy rejections (`CREATIVE_REJECTED`)
  - Frozen snapshots: sellers MUST retain delivery data for canceled packages and SHOULD return final snapshot at cancellation time
  - 7 error codes added to enum: INVALID_STATE, NOT_CANCELLABLE, MEDIA_BUY_NOT_FOUND, PACKAGE_NOT_FOUND, VALIDATION_ERROR, BUDGET_EXCEEDED, CREATIVE_DEADLINE_EXCEEDED

- f132f84: Add structured business entity data to accounts and media buys for B2B invoicing. New `billing_entity` field on accounts provides default invoicing details (legal name, VAT ID, tax ID, address, contacts with roles, bank). New `invoice_recipient` on media buys enables per-buy billing overrides. Add `billing: "advertiser"` option for when operator places orders but advertiser pays directly. Bank details are write-only (never echoed in responses).
- e6767f2: Add `overlays` to format asset definitions for publisher-controlled elements that render over buyer content.

  Publishers can now declare video player controls, publisher logos, and similar per-asset chrome as `overlays` on individual assets. Each overlay includes `bounds` (pixel or fractional, relative to the asset's own top-left corner) and optional `visual` URLs for light and dark theme variants. Creative agents use this to avoid placing critical buyer content behind publisher chrome when composing creatives.

- 9e713af: Add optional `targeting_overlay` to the `PackageStatus` shape returned by `get_media_buys`. Sellers SHOULD echo persisted targeting from `create_media_buy` / `update_media_buy` so buyers can verify what was stored without replaying the original request, mirroring the echo pattern already used for budget, pricing, and dates. Sellers claiming the `property-lists` or `collection-lists` specialisms MUST include, within this `targeting_overlay`, the `PropertyListReference` / `CollectionListReference` they persisted. Resolves #2488.
- e50579e: Add a `plan_hash` audit-layer claim to the `governance_context` JWS token that forever-binds each signed attestation to the plan state the governance agent evaluated. Closes #2455.

  **What `plan_hash` is**

  An audit-layer property — a cryptographic receipt that rides inside the JWS. `plan_hash = base64url_no_pad(SHA-256(JCS(plan_payload)))` over a single `plans[]` element at its current revision state, with a closed exclusion list for governance-agent bookkeeping (`version`, `status`, `syncedAt`, `revisionHistory`, `committedBudget`, `committedByType`). Canonicalization reuses RFC 8785 JCS — the same scheme as idempotency payload equivalence.

  **What `plan_hash` is NOT**

  It is not a wire-verification claim. Sellers do not verify it, are not expected to, and are not given a mechanism to. Plan payloads carry commercially sensitive buyer data (cross-seller allocations, per-seller caps, objectives, `approved_sellers` lists, custom policies, `ext`) that buyers do not share with sellers. There is no plan-retrieval mechanism in 3.x and none is planned. `plan_hash` is never listed in `crit`: `crit` gates wire verifiers, and no wire verifier processes this claim.

  The seller verification contract is unchanged: the 15-step JWS checklist (authenticity, authorization scope, freshness). Sellers verify that a legitimate governance agent authorized this buyer to purchase this plan's action from them, in-date, not replayed. The plan itself stays opaque to sellers — as it should in any buyer/seller relationship.

  **Who verifies `plan_hash`**

  Three off-wire parties:

  1. **The governance agent itself**: re-evaluates current plan state on every `check_governance` call (required on every spend-commit per #2403) and re-hashes. Tampering with its own persisted plan between calls surfaces as a mismatch against retained revision records.
  2. **Auditors**: given access to plan state via `get_plan_audit_logs` and the governance agent's retained per-revision `plan_hash`, an auditor can prove "this attestation was over plan state X at time T" years after the fact. Forever-binding regulator-facing provenance.
  3. **Buyer-side compliance**: a buyer's own tooling verifies its governance agent is producing tokens that match the plan the buyer actually pushed — catches a compromised or misbehaving governance vendor.

  **Semantics live in the governance spec**

  Canonicalization rules, excluded-fields list, retention obligations, test vectors, and the verification paths are specified in `docs/governance/campaign/specification.mdx` under "Plan binding and audit" — not in the security doc. `plan_hash` is a governance-audit property that happens to travel on a signed wire artifact; framing it as a security-profile concern conflates the two and mis-signals to implementers that it is part of seller verification.

  The security doc's JWS profile still names `plan_hash` in the claim table (because it IS a claim the JWS carries) but reduces the entry to one sentence plus a pointer to the governance spec.

  **Reference test vectors**

  Ten vectors under `static/compliance/source/test-vectors/plan-hash/` pin the canonicalization bit-exactly: minimal, full, bookkeeping-stripped (identity-hash invariant), paired vectors proving omitted-vs-explicit-null, array-order, and ext-rotation all produce distinct hashes, and a Unicode case confirming JCS does not normalize per RFC 8785 §3.2.5.

  **Migration**

  - Governance agents: add SHA-256 + JCS + base64url computation on each sign. Retain per-revision `plan_hash` alongside existing revision records.
  - Sellers: no change. Continue to persist and forward `governance_context` verbatim. The 15-step JWS verification checklist is unchanged.
  - Auditors: recompute and verify using the existing `get_plan_audit_logs` access path plus the governance agent's retained records.

- 9c2a978: Campaign Governance and Policy Registry. Adds governance modes (audit/advisory/enforce), delegations for multi-agency authorization, portfolio governance for holding companies, finding confidence scores, drift detection metrics with thresholds, escalation approval tiers, seller-side governance checks, and a safety model page. Includes unified check_governance with binding discriminator, 14 seeded policies, multi-agent governance composition, and enforced_policies on planned delivery.
- 87d452f: Security hardening for 3.0 — two normative SHOULD → MUST tightenings landing in the pre-GA window:

  - **Idempotency cache insert-rate limits are MUST (closes #2559).** Sellers MUST apply per-`(authenticated_agent, account)` insert-rate limits on the idempotency cache (separate from request rate limits) and MUST return `RATE_LIMITED` with `retry_after` when the configured ceiling is crossed. Recommended first-deployment ceiling: 60 inserts/sec sustained per agent (3,600/min), with burst to 300/sec over rolling 10-second windows. Sizing aligns with existing replay-cache caps (100k per-keyid webhook, 1M per-keyid request). Closes a nonce-flood DoS amplification vector. Sellers MUST expose the ceiling as a tunable configuration parameter.

  - **Webhook-registration 9421-signing is MUST for signing-capable sellers (closes #2557).** Sellers that support request signing MUST reject webhook-registration requests carrying `push_notification_config.authentication` over bearer-only transport, with `request_signature_required`. Structural defense against on-path mutators injecting or stripping the `authentication` block during onboarding. Affects conditionally-signing sellers that accept bearer for registration today; fully unsigned-only and fully signing-required sellers are unaffected.

  - **Conformance**: new negative test vector `027-webhook-registration-authentication-unsigned.json`. Runtime idempotency rate-limit grading requires a burst-runner test-kit contract that does not exist yet; pre-GA coverage is spec-MUST + implementer attestation via narrative in `universal/idempotency.yaml`.

- b2a60d9: TMP signing and key lifecycle hardening, plus Prebid proposal updates. Addresses feedback on RFC #2203.

  **Protocol changes:**

  - Add `provider_endpoint_url` to Context Match and Identity Match signed fields. Signatures now bind to a specific provider; a captured signature cannot be replayed against other providers in the registry within the epoch. Signature caches key on `(placement_id, provider_endpoint_url)`, not `placement_id` alone.
  - Add optional `revoked_at` field to `agent-signing-key.json`. Verifiers MUST reject signatures produced with a revoked key whose signing epoch is at or after the revocation timestamp. Keys stay in the trust anchor during a grace period so stale caches still find the revocation marker.

  **Proposal doc updates (`specs/prebid-tmp-proposal.md`):**

  - Temporal decorrelation reframed as a publisher-chosen profile combining volume, batching, cross-page caching, and explicit delay — not a fixed 100-2000ms delay mandate. Delay applies to Identity Match only (Context Match is on the auction critical path).
  - Request signing section updated to reflect per-provider signatures and explicit revocation.
  - Operator guidance covers signing-key storage (HSM/KMS), end-to-end verification before go-live, 401 handling, and `processed-auction-request` hook placement for PBS embeds.

- 8836151: Make top-level format_id optional in preview_creative request. The field was redundant with creative_manifest.format_id (which is always required). Callers who omit it fall back to creative_manifest.format_id. Existing callers who send both still work.
- dfcb522: Add structured pricing options to signals and content standards protocols.

  `get_signals` now returns `pricing_options` (array of typed pricing option objects) instead of the legacy `pricing: {cpm, currency}` field. This enables signals agents to offer time-based subscriptions, flat-rate, CPCV, and other pricing models alongside CPM.

  `list_content_standards` / `get_content_standards` now include `pricing_options` on content standards objects as an optional field, using the same structure. Full billing integration for governance agents will be defined when the account setup flow for that protocol is designed.

  `report_usage` has been simplified: `kind` and `operator_id` are removed. The receiving vendor agent already knows what type of service it provides, and the billing operator is captured by the account reference (`brand + operator` form or implied by account setup when using `account_id`).

  `report_usage` now accepts an `idempotency_key` field. Supply a client-generated UUID per request to prevent duplicate billing on retries.

  `activate_signal` now accepts `pricing_option_id`. Pass the pricing option selected from `get_signals` to record the buyer's pricing commitment at activation time.

- 96d6fa0: Add product_selectors to get_products for commerce product discovery. Add manifest_gtins to promoted-products schema for cross-retailer GTIN matching.
- 2957069: Add promoted-offerings-requirement enum and `requires` property to promoted offerings asset requirements (#1040)
- f4ef555: Add Property Governance Protocol support to get_products

  - Add optional `property_list` parameter to get_products request for filtering products by property list
  - Add `property_list_applied` response field to indicate whether filtering was applied
  - Enables buyers to pass property lists from governance agents to sales agents for compliant inventory discovery

- 895bd23: Add property targeting for products and packages

  **Product schema**: Add `property_targeting_allowed` flag to declare whether buyers can filter a product to a subset of its `publisher_properties`:

  - `property_targeting_allowed: false` (default): Product is "all or nothing" - excluded from `get_products` results unless buyer's list contains all properties
  - `property_targeting_allowed: true`: Product included if any properties intersect with buyer's list

  **Targeting overlay schema**: Add `property_list` field to specify which properties to target when purchasing products with `property_targeting_allowed: true`. The package runs on the intersection of the product's properties and the buyer's list.

  This enables publishers to offer run-of-network products that can't be cherry-picked alongside flexible inventory where buyers can target specific properties.

- 37d97f4: Add proposal lifecycle with draft/committed status, finalization via refine action, insertion order signing, and expiry enforcement on create_media_buy. Proposals containing guaranteed products now start as draft (indicative pricing) and must be finalized before purchase. Committed proposals include hold windows and optional insertion orders for formal agreements.
- add28ec: Add AI provenance and disclosure schema for creatives and artifacts.

  New schemas:

  - `digital-source-type` enum — IPTC-aligned classification of AI involvement (with `enumDescriptions`)
  - `provenance` core object — declares how content was produced, C2PA references, disclosure requirements, and verification results

  Key design decisions:

  - `verification` is an array (multiple services can independently evaluate content)
  - `declared_by` identifies who attached the provenance claim, enabling trust assessment
  - Provenance is a claim — the enforcing party should verify independently
  - Inheritance uses full-object replacement (no field-level merging)
  - IPTC vocabulary uses current values (`digital_creation`, `human_edits`)

  Optional `provenance` field added to:

  - `creative-manifest` (default for all assets in the manifest)
  - `creative-asset` (default for the creative in the library)
  - `artifact` (top-level and per inline asset type)
  - All 11 typed asset schemas (image, video, audio, text, html, css, javascript, vast, daast, url, webhook)

  Optional `provenance_required` field added to `creative-policy`.

- 73e3639: Add reach as a metric optimization goal and expand frequency cap capabilities.

  **New metric optimization kind:**

  - `reach` added to the `metric` enum on `kind: 'metric'` optimization goals
  - `reach_unit` field — specifies the measurement entity (individuals, households, devices, etc.). Must match a value in `metric_optimization.supported_reach_units`.
  - `target_frequency` field — optional `{ min, max, window }` band that frames frequency as an optimization signal, not a hard cap. `window` is required (e.g., `'7d'`, `'campaign'`) — frequency bands are meaningless without a time dimension. The seller de-prioritizes impressions toward entities already within the band and shifts budget toward unreached entities. Can be combined with `targeting_overlay.frequency_cap` for a hard ceiling.

  **Product capability additions:**

  - `metric_optimization.supported_reach_units` — declares which reach units the product supports for reach optimization goals. Required when `supported_metrics` includes `'reach'`.
  - `reach` added to the `supported_metrics` enum in `metric_optimization`.

  **Frequency cap expansion:**

  - `max_impressions` — maximum impressions per entity per window (integer, minimum 1).
  - `per` — entity to count against, using the same values as `reach-unit` enum (individuals, households, devices, accounts, cookies, custom). Aligns with `reach_unit` on reach optimization goals so hard caps and optimization signals stay in sync.
  - `window` — time window for the cap (e.g., `'1d'`, `'7d'`, `'30d'`, `'campaign'`). Required when `max_impressions` is set.
  - `suppress` (formerly `suppress_minutes`) — cooldown between consecutive exposures, now a duration object (e.g. `{"interval": 60, "unit": "minutes"}`). Optional — the two controls (cooldown vs. impression cap) serve different purposes and can be used independently or together.

- eb077d8: Add `REFERENCE_NOT_FOUND` to the standard error-code vocabulary (closes #2686).

  - New canonical code in `static/schemas/source/enums/error-code.json` for "the referenced identifier, grant, session, or other resource does not exist or is not accessible by the caller" — the generic fallback for resource types without a dedicated not-found code (property lists, content standards, rights grants, SI offerings, proposals, catalogs, event sources).
  - Adds **Not-found precedence**, **Polymorphic parameters**, and **Uniform response for inaccessible references** guidance to `docs/building/implementation/error-handling.mdx`:
    - Sellers SHOULD use the resource-specific code when the resolved type is known from the request (`PRODUCT_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `MEDIA_BUY_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `SESSION_NOT_FOUND`, `ACCOUNT_NOT_FOUND`) and fall back to `REFERENCE_NOT_FOUND` only when no dedicated code fits.
    - Sellers MUST use `REFERENCE_NOT_FOUND` when the unresolved identifier came in via a polymorphic or untyped parameter — using the resource-specific code there leaks the resolved type to an unauthorized caller.
    - The cross-tenant-enumeration MUST is now stated on the docs page (not only the schema): all not-found codes return uniformly for "exists but unauthorized" and "does not exist"; for `REFERENCE_NOT_FOUND`, sellers MUST NOT leak the resolved type via `error.field`, `error.details`, or a resource-qualified `error.message`.
  - Updates the `CODE_RECOVERY` fallback map in `docs/building/implementation/transport-errors.mdx` so Level-1 clients get correct recovery classification for the new code (and picks up previously-missing codes: `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `CREATIVE_NOT_FOUND`, `SIGNAL_NOT_FOUND`, `SESSION_NOT_FOUND`, `SESSION_TERMINATED`, `VALIDATION_ERROR`).
  - **Migration note for sellers moving from custom `*_not_found` codes to `REFERENCE_NOT_FOUND`:** do NOT preserve the resolved resource type in any part of the error — neither in `error.details` (e.g., `details.legacy_code: "property_list_not_found"`) nor in `error.message` (e.g., `"Property list not found: ..."`). `error.message` MUST be generic. Preserving the old code or a resource-qualified message reintroduces exactly the cross-tenant enumeration channel this code exists to close. Clients that need to branch on type should do so from request context, not from a legacy-code side channel.
  - **Replaces `LIST_NOT_FOUND` and `LIST_ACCESS_DENIED`** in the property-list docs (`docs/governance/property/tasks/property_lists.mdx`, `docs/governance/property/specification.mdx`) with `REFERENCE_NOT_FOUND` — the prior code pair was a direct violation of the uniform-response MUST (distinct codes for not-found vs access-denied is the enumeration oracle the MUST forbids). Other custom `*_NOT_FOUND` codes in the spec (`STANDARDS_NOT_FOUND`, `POLICY_NOT_FOUND`, `CHECK_NOT_FOUND`, `CAMPAIGN_NOT_FOUND`, `PLAN_NOT_FOUND`, `BRAND_NOT_FOUND`, `PROPERTY_NOT_FOUND`) are tracked as follow-up cleanup.
  - Promotes the de facto convention already expected by `adcp fuzz` conformance tooling (`bin/adcp-fuzz.js`, `docs/guides/CONFORMANCE.md`) and emitted by `@adcp/client` stock adapters (`PropertyListAdapter`, `ContentStandardsAdapter`, `SISessionManager`, `ProposalManager`) from "spec-permitted custom code" to "standard" — gives conformance tooling a stable name to key on.

- 30f8344: Add `REQUOTE_REQUIRED` error code to the standard vocabulary. Sellers return this on `update_media_buy` when a requested change (budget, flight dates, volume, targeting) falls outside the parameter envelope the original quote was priced against. The `pricing_option_id` remains immutable on update; this code covers the case where the seller will not honor the existing price for the requested new shape of the buy.

  Recovery is deterministic: the buyer calls `get_products` with `buying_mode: "refine"` against the existing `proposal_id` to obtain a fresh quote reflecting the new parameters, then resubmits the update against the new `proposal_id`. Sellers SHOULD populate `error.details.envelope_field` with the field path(s) that breached the envelope so the buyer's agent can autonomously re-discover.

  Distinct from `TERMS_REJECTED` (measurement terms) and `POLICY_VIOLATION` (content). Recovery classification: correctable.

  Closes #2456 (3.1 scope). The 4.0 `report_usage` counter-attestation portion (post-hoc delivery reconciliation) remains a separate RFC and should not overload this code.

- 9e1b0eb: Define the AdCP RFC 9421 request-signing profile — transport-layer request authentication for mutating operations. 3.0 ships the substrate **optional and capability-advertised** via `request_signing` on `get_adcp_capabilities`, so early adopters can surface canonicalization and proxy interop bugs before enforcement. The 4.0 breaking-changes accumulation window will make signing required for spend-committing operations; this profile is the floor of that bar, not the sole headline. Other accepted v4.0 RFCs will land alongside it as they progress through the roadmap.

  **Scope boundary.** A valid signature proves only that the request came from the agent whose key signed it. Whether that agent is _authorized_ to act for the brand named in the request body is a separate concern, governed by the target house's `authorized_operator[]` in brand.json. This profile defines authentication only — authorization lookup is an existing protocol concern and happens whether requests are signed or not.

  **Design properties now specified:**

  - **Canonical profile shape**: covered components pinned to `@method`, `@target-uri`, `@authority`, `content-type` (plus `content-digest` when the verifier opts in), sig-params pinned to `created`/`expires`/`nonce`/`keyid`/`alg`/`tag`, tag namespace `adcp/request-signing/v1`, alg allowlist `ed25519` / `ecdsa-p256-sha256`. Cross-implementation interop is the goal — every implementer signs and verifies the same bytes.
  - **Agent-granular signing**: every agent that signs — of any `type` — publishes keys at its own `jwks_uri` in its `agents[]` entry. Same pattern as #2316 governance agents. Per-agent keys scope compromise and match the existing brand.json agent-declaration model.
  - **Shared JWKS discovery with #2316**: one publication pattern for governance JWS, request-signing 9421, and (by convention) TMP Ed25519. Cross-purpose key reuse forbidden via `key_ops` and `kid` separation; verifiers enforce.
  - **Content-digest opt-in**: `covers_content_digest: false` default in 3.0 preserves CDN/proxy compatibility. Verifiers that require body-binding opt in per-call; buyers test end-to-end before enabling.
  - **12-step verifier checklist**: parallels the governance profile's 15-step checklist, short-circuits on first failure, establishes agent identity only.
  - **Bounded transport replay dedup**: per-`(keyid, nonce)` with TTL = signature validity (≤ 300 s). In-memory LRU for moderate scale; Redis `SETNX` above ~10K req/s.
  - **Transport revocation**: operators serve a single combined revocation list covering governance and request-signing keys, distinguished by `key_ops`. Same `next_update` polling rules as governance (floor 1 min, ceiling 15 min), same fetch-failure safe-default.
  - **Stable error taxonomy**: `request_signature_*` codes parallel to the governance `governance_*` codes, surfaced in `WWW-Authenticate: Signature error="<code>"` and SDK typed errors.
  - **TMP out of scope** for per-request 9421 verification (budget is too tight); TMP keys publish on the same `jwks_uri` path with distinct `kid` and `key_ops: ["verify"]`.
  - **Reference verifier**: ~40-line TypeScript implementation in `security.mdx` using `jose` for JWKS handling and a pluggable 9421 library.

  **Conformance**: `static/compliance/source/test-vectors/request-signing/` (published per AdCP version at `/compliance/{version}/test-vectors/request-signing/`) ships 21 negative + 8 positive vectors spanning every checklist step, every canonicalization-edge rule in the profile, replay/revocation state, the multiple-signature-label relay boundary, and a per-keyid rate-abuse case. The README documents the fixture format and the generation process for positive-vector signatures.

  **Schema changes**:

  - `brand.json` `brand_agent_entry.jwks_uri` description generalized — the field now supports any agent type that signs (request-signing and governance), not only governance agents. No structural change.
  - `get-adcp-capabilities-response.json` adds top-level `request_signing` object with `supported`, `covers_content_digest`, `required_for`, `supported_for`.

  **Migration**:

  - **3.0 GA**: verifiers ship with `required_for: []`. Signers MAY sign; verifiers MAY validate. No counterparty is required to implement.
  - **3.x**: reference SDKs (to land in `@adcp/client`) ship signing and verification. Early adopters opt in via per-counterparty `required_for` pilots, surfacing canonicalization and proxy interop issues.
  - **4.0**: `required_for` MUST include all spend-committing operations the verifier supports. Signers MUST sign. The 3.x substrate makes the flip feasible without ecosystem-wide breakage.

  Reference v4.0 tracking issue: #2307. Paired SDK implementation tracked in the `@adcp/client` repository.

- 5a54824: Move sandbox capability from `media_buy.features.sandbox` to `account.sandbox` in `get_adcp_capabilities`. Sandbox is account-level, not a media-buy protocol feature — sellers declare it alongside other account capabilities like `supported_billing` and `account_financials`.
- 80afa97: Add sandbox mode as a protocol parameter on all task requests. Sellers declare support via `features.sandbox` in capabilities. Buyers pass `sandbox: true` on any request to run without real platform calls or spend. Replaces the previously documented HTTP header approach (X-Dry-Run, X-Test-Session-ID, X-Mock-Time).
- 421cb69: Add sandbox to account-ref natural key. Implicit-account operators can reference sandbox accounts via `{ brand, operator, sandbox: true }` without provisioning or discovering an account_id. Explicit-account operators discover pre-existing sandbox test accounts via `list_accounts`. The sandbox field participates in the natural key but its usage follows the same implicit/explicit account model rules as non-sandbox accounts.
- 5b45d83: Refactor schemas to use $ref for shared type definitions

  **New shared type:**

  - `core/media-buy-features.json` - Shared definition for media-buy protocol features (inline_creative_management, property_list_filtering, content_standards)

  **Breaking change:**

  - `required_features` in product-filters.json changed from string array to object with boolean properties
    - Before: `["content_standards", "inline_creative_management"]`
    - After: `{ "content_standards": true, "inline_creative_management": true }`
  - This aligns the filter format with the capabilities declaration format in `get_adcp_capabilities`

  **Schema deduplication:**

  - `get-adcp-capabilities-response.json`: `media_buy.features` now uses $ref to `core/media-buy-features.json`
  - `product-filters.json`: `required_features` now uses $ref to `core/media-buy-features.json`
  - `artifact.json`: `property_id` now uses $ref to `core/identifier.json`
  - `artifact.json`: `format_id` now uses $ref to `core/format-id.json`

  **Benefits:**

  - Single source of truth for shared types
  - Consistent validation across all usages
  - Reduced schema maintenance burden

- 2b8d6b6: Schema refinements for frequency caps, signal pricing, audience identifiers, keyword capabilities, and duration representation.

  - **Duration type**: Added reusable `core/duration.json` schema (`{interval, unit}` where unit is `"minutes"`, `"hours"`, `"days"`, or `"campaign"`). Used consistently for all time durations. When unit is `"campaign"`, interval must be 1 — the window spans the full campaign flight. (#1215)
  - **FrequencyCap.window**: Changed from pattern-validated string (`"7d"`) to a duration object (e.g. `{"interval": 7, "unit": "days"}` or `{"interval": 1, "unit": "campaign"}`). Also applied to `optimization_goal.target_frequency.window`. (#1215)
  - **Attribution windows**: Replaced string fields with duration objects throughout. `attribution_window.click_through`/`view_through` (strings) became `post_click`/`post_view` (duration objects) on optimization goals, capability declarations, and delivery response. (#1215)
  - **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
  - **FrequencyCap.suppress**: Added `suppress` (duration object, e.g. `{"interval": 60, "unit": "minutes"}`) as the preferred cooldown field. `suppress_minutes` (scalar) is deprecated but still accepted for backwards compatibility. (#1215)
  - **supported_identifier_types**: Removed `platform_customer_id` from the identifier type enum. Added `supports_platform_customer_id` boolean to audience targeting capabilities — a binary capability flag is clearer than an enum value for this closed-ecosystem matching key. (#1217)
  - **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)

- 5a1710b: Remove `oneOf` from `get-products-request.json` and `build-creative-request.json` to fix code generation issues across TypeScript, Python, and Go. Conditional field validity is documented in field descriptions and validated in application logic.

  Fix webhook HMAC verification contradictions between `security.mdx` and `webhooks.mdx`. `security.mdx` now references `webhooks.mdx` as the normative source and adds guidance on verification order, secret rotation, and SSRF prevention. Three adversarial test vectors added.

  Localize `tagline` in `brand.json` and `get-brand-identity-response.json` — accepts a plain string (backwards compatible) or a localized array keyed by BCP 47 locale codes. Update `localized_name` definition to reference BCP 47 codes. Examples updated to use region-specific locale codes.

- 642664f: Add `universal/security.yaml` — a conformance storyboard that every AdCP agent
  must pass regardless of specialism. Authentication is required for compliance
  from the moment this storyboard ships; there is no soft-fail window. Agents
  that cannot pass were always non-conformant — the test just makes it visible.

  The storyboard verifies:

  1. **Unauth rejection on protected operations.** Calling a test-kit-declared
     protected task (`auth.probe_task`, default `list_creatives`) without
     credentials MUST return 401 (preferred) or 403, and on 401 MUST include a
     `WWW-Authenticate` header per RFC 6750 §3. Public discovery tasks
     (`get_adcp_capabilities`, `list_creative_formats`) are out of scope — they
     are unauthenticated by design.

  2. **API key enforcement** (when a test-kit key is provided). A valid key
     returns 200; a deliberately invalid key MUST return 401/403. The pair
     catches agents that "pass" with a valid key but actually ignore credentials.

  3. **OAuth discovery and audience binding.** When served, the
     `/.well-known/oauth-protected-resource/<path>` document (RFC 9728) MUST
     declare `resource` equal to the full agent URL. Catches the real-world
     audience-mismatch bug seen on a live agent (see adcp-client#563) where
     `resource` pointed at the auth server's origin and every issued token
     had the wrong audience.

  4. **Authorization server metadata resolves.** The first
     `authorization_servers[]` entry MUST expose
     `/.well-known/oauth-authorization-server` per RFC 8414 (not OIDC Discovery)
     with `issuer` and `token_endpoint`.

  5. **At least one mechanism verified.** API key OR OAuth discovery must
     contribute `auth_mechanism_verified` — rejecting unauth but advertising
     no working auth is not compliant.

  Also introduces additive storyboard runner directives documented in
  `storyboard-schema.yaml`:

  - `auth: none` on a step — force the runner to strip transport credentials.
  - `auth: { type: api_key, value: "..." }` — literal Bearer value for
    invalid-key probes.
  - `task: "$test_kit.auth.probe_task"` with `task_default` — test-kit-driven
    task selection so the probe works across agent specialisms.
  - `contributes_to: <flag>` + `contributes_if: <expression>` + `check: any_of`
    — accumulator so downstream phases can require at least one of several
    optional phases succeeded.
  - Validation checks: `http_status`, `http_status_in`, `on_401_require_header`,
    `resource_equals_agent_url`, `any_of`.

  SDK-side runner, middleware helpers, test-kit schema additions, HTTPS
  enforcement, SSRF guardrails, and cert/docs updates ship in `@adcp/client`
  and are tracked in adcp-client#565.

- f28c77b: Add `special` and `limited_series` fields to shows and episodes. Specials anchor content to real-world events (championships, awards, elections) with name, category, and date window. Limited series declare bounded content runs with total episode count and end date. Both are composable — a show can be both. Also adds `commentator` and `analyst` to the talent role enum, and fixes pre-existing training agent bugs (content_rating mapped as array, duration as ISO string instead of integer, invalid enum values).
- fe61385: Add shows and episodes as a content dimension for products. Shows represent persistent content programs (podcasts, TV series, YouTube channels) that produce episodes over time. Products reference shows via `show_ids` array, and `get_products` responses include a top-level `shows` array. Includes distribution identifiers for cross-seller matching, episode lifecycle states (scheduled, tentative, live, postponed, cancelled, aired, published), break-based ad inventory configuration, talent linking to brand.json, show declarations in adagents.json, show relationships (spinoff, companion, sequel, prequel, crossover), derivative content (clips, highlights, recaps), production quality tiers, season tracking, and international content rating systems (BBFC, FSK).
- 1bc03ff: **Breaking (SI, experimental):** On `si_get_offering` and `si_initiate_session` requests, the natural-language user-intent field is renamed from `context` to `intent`. `context` on these requests now refers to the universal opaque-echo object (`/schemas/core/context.json`), matching every other AdCP subprotocol. `si_terminate_session` already conformed and is unchanged. Treated as `minor` under the experimental-surface carve-out (`x-status: experimental` + 6-week notice policy from `docs/reference/experimental-status`). SI consumers must rename the field and stop relying on `context` being typed as a string. Closes #2774.
- c8cdbca: Add Signal Catalog feature for data providers

  Data providers (Polk, Experian, Acxiom, etc.) can now publish signal catalogs via `adagents.json`, enabling AI agents to discover, verify authorization, and activate their signals—without custom integrations.

  **Why this matters:**

  - **Discovery**: AI agents can find signals via natural language or structured lookup
  - **Authorization verification**: Buyers can verify a signals agent is authorized by checking the data provider's domain directly
  - **Typed targeting**: Signal definitions include value types (binary, categorical, numeric) so agents construct correct targeting expressions
  - **Scalable partnerships**: Authorize agents once; as you add signals, authorized agents automatically have access

  **New schemas:**

  - `signal-id.json` - Universal signal identifier with `source` discriminator: `catalog` (data_provider_domain + id, verifiable) or `agent` (agent_url + id, trust-based)
  - `signal-definition.json` - Signal spec in data provider's catalog
  - `signal-targeting.json` - Discriminated union for targeting by value_type
  - `signal-category.json` / `signal-value-type.json` / `signal-source.json` - Enums

  **Modified schemas:**

  - `adagents.json` - Added `signals` array, `signal_tags`, and signal authorization types
  - `get-signals-request.json` / `get-signals-response.json` - Added `signal_ids` lookup and structured responses
  - `product.json` - Added `signal_targeting_allowed` flag

  **Server updates:**

  - `AdAgentsManager` - Full signals validation, creation, and authorization verification
  - AAO Registry - Data providers as first-class member type with federated discovery

  See [Data Provider Guide](/docs/signals/data-providers) for implementation details.

- d874136: Add `custom` pricing model to the vendor pricing schema as an escape hatch for constructs that do not fit cpm, percent_of_media, flat_fee, or per_unit.

  `model: "custom"` requires a human-readable `description` and a structured `metadata` object. Buyers SHOULD route custom pricing through operator review before commitment — automatic selection is not recommended.

  Shipping this now is cheap and avoids painful retrofit when data providers introduce performance kickers, tiered volume, hybrid (flat + CPM) pricing, or outcome-shared constructs that the enumerated models cannot express. Structured metadata keeps the field machine-inspectable without forcing a schema change for every new pattern.

  Applies to all `signal-pricing.json` consumers (signals, creative, governance vendor pricing via `vendor-pricing-option.json`). `get_signals` task documentation is updated to reflect the new model.

- 1c5bbb0: Add percent_of_media pricing model and transaction context to signals protocol:

  - **`signal-pricing.json`**: New schema for signal-specific pricing — discriminated union of `cpm` (fixed CPM) and `percent_of_media` (percentage of spend, with optional `max_cpm` cap for TTD-style hybrid pricing)
  - **`signal-pricing-option.json`**: New schema wrapping `pricing_option_id` + `signal-pricing`. The `get_signals` response now uses this instead of the generic media-buy `pricing-option.json`
  - **`signal-filters.json`**: New `max_percent` filter for percent-of-media signals
  - **`get_signals` request**: Optional `account_id` (per-account rate cards) and `buyer_campaign_ref` (correlate discovery with settlement)
  - **`activate_signal` request**: Optional `account_id` and `buyer_campaign_ref` for transaction context

- 2e3ec71: Define a signed format for `governance_context`. In 3.0 governance agents MUST emit a compact JWS per the AdCP JWS profile; sellers MAY verify and MUST persist and forward the token unchanged even when not yet verifying. 3.1 will require all sellers to verify. The field shape (single string, ≤4096 chars) is unchanged — sellers that treat the value as an opaque correlation key keep working, and sellers that want cryptographic accountability opt in by implementing the 15-step verification checklist.

  Key design properties now specified:

  - **Anti-spoofing via brand.json cross-check**, with explicit buyer-identity resolution rules (mTLS, pre-provisioned identity, or #2307 signed requests). Sellers MUST NOT derive buyer identity from unauthenticated request fields.
  - **SSRF hardening** for `jwks_uri` and revocation-list fetches, reusing existing Webhook URL validation rules.
  - **Signed revocation list** at `/.well-known/governance-revocations.json` with `next_update` cadence capped to 15 minutes for execution-phase tokens and explicit fail-closed behavior on fetch failure + grace.
  - **RFC 7515 `crit` header** required for any semantic claim, preventing silent downgrade attacks when future profile versions add claims.
  - **Per-tenant JWKS isolation** for SaaS governance agents — `iss` byte-match including path; shared-origin key pooling forbidden for `spend_authority` scope.
  - **Key-purpose separation**: governance signing keys share JWKS discovery with #2307 transport signing but MUST use distinct `kid` with `key_ops: ["verify"]` and `use: "sig"`. Verifiers enforce separation.
  - **Bounded replay-dedup**: execution-token `exp` capped to 30 days; bloom filter + authoritative lookup recommended.
  - **`policy_decisions` privacy**: optional, with `policy_decision_hash` as the privacy-preserving default; full evidence behind `audit_log_pointer`.
  - **Error taxonomy**: stable codes for verification failure (`governance_jwks_unavailable`, `_issuer_not_authorized`, `_token_revoked`, etc.) so client libraries can expose typed errors.
  - **Reference implementation**: decoded JWT example and ~30-line `jose`-based TypeScript verifier in security.mdx.
  - **Forward compatibility**: optional `nbf` (registered claim) and optional `status` claim for future IETF JWT Status List migration.
  - **Edge-runtime guidance**: ES256 recommended where Ed25519 requires runtime configuration (Cloudflare Workers, Vercel Edge).

  brand.json governance agents gain optional `jwks_uri` and `scope` fields so sellers and auditors can discover signing keys and disambiguate multi-agent houses.

  The safety-model doc gains a "Verifiable approvals" section positioned immediately after the three-party trust model, emphasizing that regulators and auditors can verify tokens independently without vendor cooperation — the core accountability property the profile exists to deliver.

  Scope for 3.0 is buy-side governance only. Seller-side governance authorities (CTV political-ad rules, publisher content policies) remain expressed via `conditions` responses; a future RFC may extend this profile to cover seller-side signed decisions. Governance attestation terminates at the AdCP media buy boundary and does not propagate into OpenRTB bid streams.

  Resolves #2306. Incorporates feedback from security, ad-tech-protocol, product, and TypeScript implementation reviews.

- 7eacbc3: Require brand-scoped state to survive across agent process instances. Add normative "State persistence and horizontal scaling" section to protocol architecture: state keyed by `(brand, account)` MUST survive across agent replicas, and implementations MUST support read-your-writes for that state.

  Compliance docs add a "Production readiness" section telling sellers to run storyboards against ≥2 agent instances before claiming compliance — single-instance success is not sufficient. Multi-instance compliance mode rotates requests across replicas for any storyboard that contains a step marked `stateful: true`, which already identifies the write→read sequences that fail on in-process-only implementations.

- ac0c3e3: Storyboard-first testing flow: fix creative agent rejecting adcp_major_version, deprecate platform_type gate, add Addie storyboard tools (recommend, detail, run, step), add applicable-storyboards API endpoint
- fe0f8a0: Add native streaming/audio metrics to delivery schema.

  - Broadens `views` description to cover audio/podcast stream starts
  - Renames `video_completions` to `completed_views` in aggregated_totals
  - Adds `views`, `completion_rate`, `reach`, `reach_unit`, `frequency` to aggregated_totals
  - Adds `reach_unit` field to `delivery-metrics.json` referencing existing `reach-unit.json` enum with `dependencies` co-occurrence constraint (reach requires reach_unit)
  - Aggregated reach/frequency omitted when media buys have heterogeneous reach units
  - Updates `frequency` description from "per individual" to "per reach unit"
  - Training agent: channel-specific completion rates (podcast 87%, streaming audio 72%, CTV 82%), `views` at package level, audio/video metrics rolled up into totals, `reach_unit` emission (accounts for streaming, devices for CTV/OLV)

- 8f26baf: Add Swiss (`ch_plz`) and Austrian (`at_plz`) postal code systems to geo targeting.
- d6866dc: Add payment_terms to sync_accounts request and formalize enum across schemas
- b61f271: Add `sync_audiences` task for CRM-based audience management.

  Buyers wrapping closed platforms (LinkedIn, Meta, TikTok, Google Ads) need to upload hashed CRM data before creating campaigns that target or suppress matched audiences. This adds a dedicated task for that workflow, parallel to `sync_event_sources`.

  Schema:

  - New task: `sync_audiences` with request and response schemas
  - New core schema: `audience-member.json` — hashed identifiers for CRM list members (email, phone, MAIDs)
  - `targeting.json`: add `audience_include` and `audience_exclude` arrays for referencing audiences in `create_media_buy` targeting overlays

  Documentation:

  - New task reference: `docs/media-buy/task-reference/sync_audiences.mdx`
  - Updated `docs/media-buy/advanced-topics/targeting.mdx` with `audience_include`/`audience_exclude` overlay documentation

- 8bf720d: Three pre-4.0 DX fixes surfaced during Python SDK v4.0.0-rc validation:

  - **sync_creatives response**: add optional `status: CreativeStatus` to per-item results so buyers learn approval/review state without a follow-up `list_creatives`; add a third top-level `SyncCreativesSubmitted` shape (`status: "submitted"` + `task_id`) mirroring the `create_media_buy` three-shape pattern for when the whole sync is queued asynchronously; enforce "no `status` when `action` is `failed`/`deleted`" via conditional validation (issue #2428). The item-level constraint uses draft-07 `if/then`, which many code generators (openapi-typescript, pre-0.25 datamodel-code-generator, quicktype, Zod via `zod-to-json-schema`) ignore — generated types will emit `status` as always-optional and miss the invariant. Consumers should add a runtime check: "status MUST be omitted when action=failed/deleted" on sync items.
  - **get_adcp_capabilities idempotency**: add `adcp.idempotency.supported: boolean` and model the block as a two-branch discriminated `oneOf` on that field — `IdempotencySupported` (discriminator `supported: true`, `replay_ttl_seconds` required) and `IdempotencyUnsupported` (discriminator `supported: false`, `replay_ttl_seconds` forbidden via `not`). Sellers without replay dedup can now declare it explicitly instead of emitting an ambiguous empty block. The discriminator lets code generators emit two named types with the invariant enforced at the type level, avoiding the draft-07 `if/then` ergonomics trap where most generators silently drop the constraint (issue #2429, closes #2436).

    Before (3.0.0-rc.3):

    ```json
    { "idempotency": {} }
    ```

    After (this RC) — supported seller:

    ```json
    { "idempotency": { "supported": true, "replay_ttl_seconds": 86400 } }
    ```

    After (this RC) — unsupported seller:

    ```json
    { "idempotency": { "supported": false } }
    ```

  - **Error codes**: add `CREATIVE_NOT_FOUND` and `SIGNAL_NOT_FOUND` to the `error-code` enum to match the existing `PRODUCT_NOT_FOUND` / `MEDIA_BUY_NOT_FOUND` / `PACKAGE_NOT_FOUND` pattern (issue #2430).

  **RC-breaking note**: `adcp.idempotency` is now a discriminated `oneOf` with `supported` required as the discriminator. Sellers that shipped against `3.0.0-rc.3` (which emitted an empty `idempotency: {}` block) and against the interim source which required `replay_ttl_seconds` without `supported` will need to regenerate their capabilities response and pick a branch: `{ supported: true, replay_ttl_seconds: N }` or `{ supported: false }`. The empty-block form is no longer valid. SDKs consumed via `adcp-client-python` v4.0.0-rc and `@adcp/client` should regenerate schemas against the new RC. Buyers validating captured `3.0.0-rc.3` responses against the new schemas will see validation failures on the missing `supported` field — pin validator to the matching RC version. If you hand-wrote your validator, the only change is checking `supported` first; if you used `openapi-typescript`, `datamodel-code-generator`, or similar, regenerate and you'll get two named types (`IdempotencySupported`, `IdempotencyUnsupported`) you can discriminate on. **Strict validation is now the safe default** for sync_creatives responses (the new item-level conditional on `status` and the three-shape `oneOf` catch seller misbehavior that lagging validators would silently accept); buyers on stale validators SHOULD upgrade before relying on per-item `status`.

- e84aafd: Add functional restriction overlays: age_restriction (with verification methods for compliance), device_platform (technical compatibility using Sec-CH-UA-Platform values), and language (localization). These are compliance/technical restrictions, not audience targeting - demographic preferences should be expressed in briefs.
- 142bcd5: Add `rejected` account status for accounts that were never approved. Previously, `closed` covered both "was active, now terminated" and "seller declined the request", which was counterintuitive. Now `pending_approval` → `rejected` (declined) is distinct from `active` → `closed` (terminated).
- 30c3ad8: Add `time_budget` to `get_products` request and `incomplete` to response.

  - `time_budget` (Duration): buyers declare how long they will commit to a request. Sellers return best-effort results within the budget and do not start processes (human approvals, expensive external queries) that cannot complete in time.
  - `incomplete` (array): sellers declare what they could not finish — each entry has a `scope` (`products`, `pricing`, `forecast`, `proposals`), a human-readable `description`, and an optional `estimated_wait` duration so the buyer can decide whether to retry.
  - Adds `seconds` to the Duration `unit` enum.

- 5dec4a4: feat: TMP Identity Match supports multiple identity tokens per request

  Replaces the single `user_token` + `uid_type` fields on `identity-match-request` with an `identities` array of `{user_token, uid_type}` pairs (`minItems: 1`, `maxItems: 3`). The cap matches the TMPX plaintext budget — three 32-byte tokens fit within the ~120-byte post-HPKE budget without forcing buyer-side truncation. Publishers SHOULD send every identity token they have available (up to the cap) — the buyer resolves on whichever graph matches, maximizing match rate across heterogeneous buyer identity graphs. Entry order is not semantically significant; buyers use their own preference order. Duplicate `(uid_type, user_token)` pairs MUST NOT appear.

  Router filtering selects providers whose `uid_types` overlaps with any `uid_type` in the request's `identities` array. The router filters `identities` per provider before forwarding (minimum-necessary-data) and MUST NOT add, substitute, or transform identity tokens — the forwarded set MUST be a subset of the publisher-origin array. If the intersection is empty, the router MUST skip the provider rather than forwarding with side-channel telemetry. The router re-signs per outbound forward; providers verify against the router's public key.

  Signature and cache key share one canonicalization discipline. Signed input is the hex-encoded SHA-256 of the RFC 8785 JCS serialization of `{type, request_id, identities_hash, consent, package_ids, daily_epoch}`. `identities_hash` is SHA-256 over JCS of the deduplicated, sorted `identities` array (computed over the per-provider filtered subset). The cache key `{identities_hash, provider_id, package_ids_hash, consent_hash}` uses SHA-256 over JCS of the sorted `package_ids` and the `consent` object (or JCS `null` when absent, distinguishing "consent unknown" from explicit-empty). JCS framing eliminates delimiter-injection risk — raw consent strings or package IDs containing `|`, `,`, or `\n` cannot collide two distinct inputs.

  Buyers SHOULD prefer opaque provider IDs over `hashed_email` and other strongly re-identifying tokens when multiple identities are present, neutralizing scenarios where a misconfigured or compromised router strips everything except the highest-risk token.

  Adds `rampid_derived` to the `uid-type` enum (aligns with the TMPX binary Type ID registry — maintained RampID is 32 bytes, derived RampID is 48 bytes).

  Documents that multi-token IMRs disclose cross-identity equivalence to the buyer (e.g., "this UID2 and this ID5 resolve to the same user from this publisher's view"). Publishers who want to avoid this can send a single identity per IMR at the cost of match rate. `hashed_email` carries higher re-identification risk than opaque provider IDs; publishers SHOULD treat inclusion as a deployment decision. TEE-attested deployments close the offline-retention vector.

  Privacy documentation now explicitly states the router's trust boundary for identity filtering, the non-transformation invariant, and the code-audit / TEE-attestation trust model.

  TMPX truncation policy when resolved identities exceed the ~120-byte plaintext budget is buyer deployment configuration, not protocol-level. Buyers MUST configure an explicit priority list; the default implementation MUST NOT truncate arbitrarily.

  Breaking change relative to prior TMP drafts. TMP is an [experimental surface](/docs/reference/experimental-status) in AdCP 3.0 (feature id `trusted_match.core`) — it may change between 3.x releases with at least 6 weeks' notice; see the 3.1.0 roadmap for planned changes on the path to stable.

- bf1773b: feat: deprecate AXE fields, add TMP provider discovery, property_rid, typed artifacts, lightweight context match

  Marks `axe_include_segment`, `axe_exclude_segment`, and `required_axe_integrations` as deprecated in favor of TMP. Adds `trusted_match` filter to product-filters for filtering by TMP provider + match type. Adds `providers` array to the product `trusted_match` object so publishers can declare which TMP providers are integrated per product. Adds `trusted_match` to the `fields` enum on get-products-request. Removes `available_packages` from context match requests — providers use synced package metadata instead of receiving it per-request. Optional `package_ids` narrows the set when needed. Adds `property_rid` (UUID v7 from property catalog) as the primary identifier on context match requests, with `property_id` optional for logging. Replaces plain-string artifacts with typed objects (`url`, `url_hash`, `eidr`, `gracenote`, `rss_guid`, `isbn`, `custom`) so buyers can resolve content via public registries. Removes top-level `url_hash` field (now an artifact type).

- 89cb946: feat: add TMP provider registration schema, health endpoint, provider lifecycle, and timeout clarification

  Adds `provider-registration.json` schema formalizing provider endpoint, capabilities, countries/uid_types (conditionally required for identity_match), timeout, priority, and lifecycle status (active/inactive/draining). Updates specification.mdx, router-architecture.mdx, and buyer-guide.mdx with health endpoint (GET /health), dual discovery models (static config and dynamic API with SSRF guidance), and clarified per-provider vs overall latency budget semantics.

- dcbb3c8: feat: Trusted Match Protocol (TMP) — real-time execution layer for AdCP

  Adds 9 TMP schemas, 12 documentation pages, and updates across the protocol to support real-time package activation with structural privacy separation. Deprecates AXE.

- f543f44: Add typed asset requirements schemas for creative formats

  Introduces explicit requirement schemas for every asset type with proper discriminated unions. In `format.json`, assets use `oneOf` with `asset_type` as the discriminator - each variant pairs a specific `asset_type` const with its typed requirements schema. This produces clean discriminated union types for code generation.

  - **image-asset-requirements**: `min_width`, `max_width`, `min_height`, `max_height`, `formats`, `max_file_size_kb`, `animation_allowed`, etc.
  - **video-asset-requirements**: dimensions, duration, `containers`, `codecs`, `max_bitrate_kbps`, etc.
  - **audio-asset-requirements**: `min_duration_ms`, `max_duration_ms`, `formats`, `sample_rates`, `channels`, bitrate constraints
  - **text-asset-requirements**: `min_length`, `max_length`, `min_lines`, `max_lines`, `character_pattern`, `prohibited_terms`
  - **markdown-asset-requirements**: `max_length`
  - **html-asset-requirements**: `sandbox` (none/iframe/safeframe/fencedframe), `external_resources_allowed`, `allowed_external_domains`, `max_file_size_kb`
  - **css-asset-requirements**: `max_file_size_kb`
  - **javascript-asset-requirements**: `module_type`, `external_resources_allowed`, `max_file_size_kb`
  - **vast-asset-requirements**: `vast_version`
  - **daast-asset-requirements**: `daast_version`
  - **promoted-offerings-asset-requirements**: (extensible)
  - **url-asset-requirements**: `protocols`, `allowed_domains`, `macro_support`, `role`
  - **webhook-asset-requirements**: `methods`

  This allows sales agents to declare execution environment constraints for HTML creatives (e.g., "must work in SafeFrame with no external JS") as part of the format definition.

- efa8e6a: Add universal macro enum schema and improve macro documentation

  Schema:

  - Add universal-macro.json enum defining all 54 standard macros with descriptions
  - Update format.json supported_macros to reference enum (backward compatible via oneOf)
  - Update webhook-asset.json supported_macros and required_macros to reference enum
  - Register universal-macro enum in schema index

  New Macros:

  - GPP_SID: Global Privacy Platform Section ID(s) for privacy framework identification
  - IP_ADDRESS: User IP address with privacy warnings (often masked/restricted)
  - STATION_ID: Radio station or podcast identifier
  - SHOW_NAME: Program or show name
  - EPISODE_ID: Podcast episode identifier
  - AUDIO_DURATION: Audio content duration in seconds

  Documentation:

  - Add GPP_SID to Privacy & Compliance Macros section
  - Add IP_ADDRESS with privacy warning callout
  - Add Audio Content Macros section for audio-specific macros
  - Add TIMESTAMP to availability table
  - Add GPP_STRING and GPP_SID to availability table
  - Add IP_ADDRESS to availability table with privacy restriction notation (✅‡)
  - Add Audio Content macros to availability table
  - Update legend with ✅‡ notation for privacy-restricted macros

- f5e6a21: Agent ergonomics improvements from #1240 tracking issue.

  **Media Buy**

  - `get_products`: Add `fields` parameter for response field projection, reducing context window cost for discovery calls
  - `get_media_buy_delivery`: Add `include_package_daily_breakdown` opt-in for per-package daily pacing data
  - `get_media_buy_delivery`: Add `attribution_window` on request for buyer-controlled attribution windows (model optional)
  - `get_media_buys`: Add buy-level `start_time`/`end_time` (min/max of package flight dates)

  **Capabilities**

  - `get_adcp_capabilities`: Add `supported_pricing_models` and `reporting` block (date range, daily breakdown, webhooks, available dimensions) at seller level

  **Audiences**

  - `sync_audiences` request: Add `description`, `audience_type` (crm/suppression/lookalike_seed), and `tags` metadata
  - `sync_audiences` response: Add `total_uploaded_count` for match rate calculation

  **Forecasting**

  - `ForecastPoint.metrics`: Add explicit typed properties for all 13 forecastable-metric enum values

- 2173eb1: `validate_property_delivery`: add optional root-level `compliant: boolean` field to the response schema — an overall compliance flag derived from `summary.non_compliant_records === 0`, surfaced at the root as a convenience signal for buyers. Consumers SHOULD fall back to summary counts when the field is absent. Resolves a contradiction between the JSON schema (which previously forbade `compliant` via root `additionalProperties: false`), `@adcp/client`'s hand-written zod response schema (which required `compliant`), and the `property_lists` storyboard (which asserted on `field_value compliant`).

  Also fixes the `property_lists` storyboard's delivery records to use the schema-correct `identifier:` key instead of the non-schema `property:` key, and aligns the `validate_property_delivery` expected narrative with the `features[]` per-record contract.

- 7736865: Add per-request version declaration and VERSION_UNSUPPORTED error code

  **Version negotiation:**

  - `adcp_major_version` optional integer field on all AdCP request schemas lets buyers declare which major version their payloads conform to
  - Sellers validate against their `major_versions` and return `VERSION_UNSUPPORTED` if out of range
  - When omitted, sellers assume their highest supported version

  **Error codes:**

  - `VERSION_UNSUPPORTED` — declared major version not supported by seller. Recovery: correctable.

  **Documentation:**

  - Version negotiation section in versioning reference
  - Version negotiation flow and seller behavior in get_adcp_capabilities docs

- 2a82501: Add video and audio technical constraint fields for CTV and streaming platforms

  - Add frame rate constraints: acceptable_frame_rates, frame_rate_type, scan_type
  - Add color/HDR fields: color_space, hdr_format, chroma_subsampling, video_bit_depth
  - Add GOP/streaming fields: gop_interval_seconds_min/max, gop_type, moov_atom_position
  - Add audio constraints: audio_required, audio_codec, audio_sampling_rate_hz, audio_channels, audio_bit_depth, audio_bitrate_kbps_min/max
  - Add audio loudness fields: audio_loudness_lufs, audio_loudness_tolerance_db, audio_true_peak_dbfs
  - Extend video-asset.json and audio-asset.json with matching properties
  - Add CTV format examples to video documentation

- c798cf5: Add `webhook-emission` universal for outbound-webhook conformance (signing + idempotency).

  Webhook emission is a cross-cutting capability, not a specialism — any agent that accepts `push_notification_config` on any operation must emit conformant webhooks. Graded as a universal (like `idempotency`), not claimed as a specialism. Applies to sellers, rights agents, governance agents, content-standards agents, and any future agent that emits webhooks.

  Storyboards are unidirectional today (runner → agent). Verifying outbound webhook conformance — `idempotency_key` presence and stability across retries (#2417), and RFC 9421 webhook signature validity (#2423) — requires the runner to host a webhook receiver during storyboard execution and observe live deliveries. This PR adds the spec-side surface.

  - `universal/webhook-emission.yaml` — new universal with four phases: capability discovery, `idempotency_key` presence, `idempotency_key` stability across retries, and 9421 signature validity (gated on 9421 being in effect — agents whose buyers registered the legacy HMAC fallback skip the signature phase).
  - `test-kits/webhook-receiver-runner.yaml` — harness contract. Two endpoint modes: `loopback_mock` default for lint/fast runs (intercepts at the `@adcp/client` AsyncHandler layer, zero network deps) and `proxy_url` for AdCP Verified conformance runs (operator-supplied HTTPS URL). Per-step receiver URLs with `operation_id` echo. 5xx-then-2xx retry-replay shape with configurable count and status. Applies to both `universal/webhook-emission.yaml` and `universal/idempotency.yaml`.
  - `universal/idempotency.yaml` — the replay-side-effect invariant ("no duplicate webhooks on replay") was previously graded by a manual-audit step. Replaced with a programmatic `expect_webhook` step using `expect_max_deliveries_per_logical_event: 1` gated on the `webhook_receiver_runner` contract. Runners without a webhook receiver skip as `not_applicable`; runners with one catch duplicate-side-effect bugs directly.
  - `universal/storyboard-schema.yaml` — new step types (`expect_webhook`, `expect_webhook_retry_keys_stable`, `expect_webhook_signature_valid`), substitution variables (`{{runner.webhook_base}}`, `{{runner.webhook_url:<step_id>}}`), and cross-cutting helpers (`expect_max_deliveries_per_logical_event`, `requires_contract`).
  - `push-notification-config.json` — description drift fix: now says "seller signs outbound with a key published at the jwks_uri on its own brand.json `agents[]` entry" (was "its adagents.json-published key," which is not where the key actually lives per the `#webhook-callbacks` section of security.mdx).

  Clean seam: the runner delegates to `@adcp/client` primitives (`AsyncHandlerConfig.webhookDedup`, `WebhookMetadata.idempotency_key`, `Activity.type == "webhook_duplicate"`) rather than reimplementing signature verification or idempotency dedup. The same code that production receivers rely on is what the conformance runner exercises. Cross-references adcontextprotocol/adcp-client#629 by URL.

  Implementation-feedback follow-ups (from adcp-client runner work):

  - Renamed `schema_ref` on webhook-assertion steps to `webhook_payload_schema_ref` to avoid overloading the request-schema field name on caller→agent steps.
  - Clarified that the "caller" minting `operation_id` in the URL template is the runner, not the agent under test — agents MUST echo the runner-supplied operation_id back in the webhook payload and MUST NOT mint their own.
  - Required signature verification on every delivery in `expect_webhook_retry_keys_stable` (not just the first) when 9421 is in effect, with a run-scoped `(keyid, nonce)` replay store, to catch publishers that stably reuse both `idempotency_key` (correct) and 9421 `nonce` (incorrect — nonce MUST be fresh per delivery).
  - Mandated a single cross-step `(keyid, nonce)` replay store shared across all `expect_webhook_signature_valid` invocations in a run, so cross-step nonce replay is detected.
  - Capped `retry_trigger.count` at 10 and allowlisted `retry_trigger.http_status` to `{429, 500, 502, 503, 504}` to prevent typo'd storyboards from turning runners into DoS amplifiers in `proxy_url` mode.
  - Required HTTPS scheme on `proxy_url` endpoint mode (loopback_mock is in-process and has no TLS surface).
  - Deferred `shared_receiver: true` semantics (fan-in dedup across multiple emitting steps); storyboard authors MUST use per-step receivers in v1.
  - Specified that unresolved substitutions like `{{runner.webhook_base}}` MUST grade the storyboard `not_applicable` (preflight) or the step `failed` (step-time) — runners MUST NOT ship literal `{{...}}` tokens on the wire.

  Preview status pending runner implementation in adcp-client (tracked at adcontextprotocol/adcp#2426).

- 14a3864: Require `idempotency_key` on every webhook payload (#2416).

  Webhooks use at-least-once delivery, so receivers must dedupe. Prior to this change, only `mcp-webhook-payload` carried fields usable for dedup — and only as the fragile `(task_id, status, timestamp)` tuple, which collides when a single transition is retried with unchanged timestamp or when two transitions share a timestamp. The governance, artifact, and revocation webhook payloads had no standardized dedup field at all; `revocation-notification` used its own `notification_id` with a different name and format.

  Every webhook payload now carries a required, sender-generated `idempotency_key` stable across retries of the same event. The field uses the same name and format as the request-side `idempotency_key` (16–255 chars, `^[A-Za-z0-9_.:-]{16,255}$`). UUID v4 is required to be cryptographically random — predictable keys allow pre-seeding a receiver's dedup cache to suppress legitimate events.

  **Schemas changed (required `idempotency_key` added):**

  - `core/mcp-webhook-payload.json`
  - `collection/collection-list-changed-webhook.json`
  - `property/property-list-changed-webhook.json`
  - `content-standards/artifact-webhook-payload.json`
  - `brand/revocation-notification.json` — also renames the prior `notification_id` field to `idempotency_key` (safe in 3.0-rc, unifies the protocol-wide dedup vocabulary)

  **Docs updated:**

  - `docs/building/implementation/webhooks.mdx` §Reliability — makes `idempotency_key` the canonical dedup field with normative sender/receiver requirements: cryptographic-random keys, sender-scoped dedup (never trust a payload field for sender identity), 24h minimum TTL, cache-growth bounds, and an explicit note that webhooks do not verify payload equivalence (unlike request-side `IDEMPOTENCY_CONFLICT`).
  - `docs/governance/collection/tasks/collection_lists.mdx`, `docs/governance/property/tasks/property_lists.mdx` — example payloads include `idempotency_key`; property example also adds the `signature` field that was missing.
  - `docs/governance/content-standards/implementation-guide.mdx` — artifact webhook example updated.
  - `docs/brand-protocol/tasks/acquire_rights.mdx`, `docs/brand-protocol/walkthrough-rights-licensing.mdx` — revocation notification references use `idempotency_key`.

  Note: `core/reporting-webhook.json` is the reporting webhook _configuration_ (passed in `create_media_buy`), not a payload. No reporting-webhook payload schema exists today, so it is out of scope. If one is added later, it will need the same field.

- 35d8ba6: Ship RFC 9421 webhook-signing conformance test vectors.

  Static canonical signed webhook payloads at `static/compliance/source/test-vectors/webhook-signing/`, parallel to the request-signing vectors shipped in #2323. Covers the receiver side: deterministic positive and negative vectors a webhook-verifier library can validate against, independent of any live publisher.

  - `keys.json` — four test keypairs. Two working verifier keys (Ed25519 + ES256) with `adcp_use: "webhook-signing"`. One request-signing key (`adcp_use: "request-signing"`) to exercise cross-purpose rejection at verifier checklist step 8. One dedicated revoked key for vector 017. Private components publish in `_private_d_for_test_only` so SDKs can exercise both signer and verifier roles.
  - `positive/` — 6 vectors covering Ed25519 and ES256 happy paths, multiple `Signature-Input` labels (verifier processes `sig1` only), default-port stripping, percent-encoded path normalization, query-byte preservation. All pass against a conformant verifier.
  - `negative/` — 18 vectors, one per `webhook_signature_*` error code in the webhook-callbacks verifier checklist: `tag_invalid`, `window_invalid` (3 variants: expired, window-too-long, expires≤created), `alg_not_allowed`, `components_incomplete` (2 variants: missing `@authority`, missing `content-digest` — REQUIRED on webhooks), `key_unknown`, `key_purpose_invalid` (adcp_use mismatch), `digest_mismatch`, `header_malformed` (2 variants: malformed Signature-Input, Signature without Signature-Input), `params_incomplete` (2 variants: missing expires, missing nonce), `invalid` (corrupted signature bytes), `replayed`, `key_revoked`, and `rate_abuse`. The last three carry `requires_contract: "webhook_receiver_runner"` + `test_harness_state` for runner-coordinated preconditions.
  - `README.md` — scope, file layout, vector shape, usage patterns, cross-reference to the webhook-callbacks spec section and the `webhook-emission` universal.

  **Relationship to other surfaces:**

  - `@target-uri` canonicalization is identical to request signing. Vectors reference `test-vectors/request-signing/canonicalization.json` by pointer rather than duplicating.
  - Vectors complement the `webhook-emission` universal (#2431). The universal grades live sender behavior; these vectors grade receiver libraries. Together they cover both halves of the webhook-signing conformance surface.

  Vectors test verifiers deterministically — receiver libraries (e.g., `@adcp/client`'s forthcoming 9421 webhook verifier) can validate every `webhook_signature_*` rejection path in CI without needing a live publisher to produce malformed signatures on demand.

- da1bc66: Unify webhook signing on the AdCP RFC 9421 profile.

  Webhooks are now signed under a symmetric variant of the existing request-signing profile: the seller signs outbound with an `adcp_use: "webhook-signing"` key published at the `jwks_uri` on its own brand.json `agents[]` entry (the same publication pattern as any other AdCP agent key), and the buyer verifies against that JWKS. No shared secret crosses the wire; `push_notification_config.authentication` is no longer required.

  - `push-notification-config.json` schema: `authentication` moved from required to optional. Description rewritten to point at the 9421 profile as the default and flag `authentication` as the legacy fallback removed in 4.0.
  - `security.mdx`: added a "Webhook callbacks" subsection under the 9421 profile with a fully-enumerated 14-step verifier checklist (webhook*signature*\* error codes), trust-anchor/blast-radius paragraph, downgrade-and-injection-resistance rules for the unsigned-request case, webhook-specific replay dedup sizing (per-keyid cap 100K, aggregate cap 10M), and HMAC→9421 migration rotation rules. Removed the "webhooks are out of scope for this profile" carve-outs. Added `"webhook-signing"` to the `adcp_use` discriminator table. Rewrote the "Webhook Security" section so 9421 is the baseline and HMAC-SHA256 is the deprecated fallback.
  - `webhooks.mdx`: made 9421 the primary "Signature verification" section; demoted HMAC-SHA256 and Bearer to "Legacy fallback (deprecated)" subsections with a removal-in-4.0 warning. Dropped `authentication` from default MCP and A2A examples. Updated dedup scope language to cover both 9421 keyid-based identity and legacy HMAC/Bearer identity, with a note on cross-scheme dedup during migration.
  - `acquire_rights.mdx` and `collection_lists.mdx`: updated webhook-signing references from "HMAC-SHA256 only" to point at the unified profile with 9421 as default.
  - `webhook-hmac-sha256.json` test vectors: marked as legacy with a `status: "legacy"` field and deprecation note. 9421 webhook conformance vectors will ship alongside the existing request-signing vectors in a follow-up.

  Baseline-required in 3.0 (no capability advertisement — sellers that emit webhooks MUST sign); HMAC fallback available through 3.x when buyers opt in via `authentication.credentials`; `authentication` removed from the schema in 4.0.

- 0cede41: Add CreativeBrief type to BuildCreativeRequest for structured campaign context
- 82410d5: Wire the fourth default cross-step assertion `status.monotonic` onto the compliance specialisms that exercise lifecycle-bearing resources, and pick up the SDK implementation in [`@adcp/client@5.10.0`](https://github.com/adcontextprotocol/adcp-client/pull/760).

  `status.monotonic` (adcp#2664) rejects resource status transitions observed across storyboard steps that aren't on the spec-published lifecycle graph for their resource type — catches regressions like `active → pending_creatives` on a media_buy or `approved → processing` on a creative asset that per-step `response_schema` validations can't detect. Silent on runs that don't observe any status (no steps that read lifecycle-bearing resources produce observations → no transitions → silent pass).

  **Specialisms wired (20 files):**

  - Sales (9): `sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`, `sales-streaming-tv`, `sales-social`, `sales-exchange`, `sales-catalog-driven`, `sales-retail-media`, `sales-proposal-mode` — media_buy lifecycle primarily; `sales-catalog-driven` also touches catalog_item.
  - Creative (4 YAMLs across 3 specialisms): `creative-ad-server`, `creative-template`, `creative-generative/index.yaml` + `creative-generative/generative-seller.yaml` — creative asset lifecycle.
  - Governance (4): `governance-spend-authority/index.yaml` + `denied.yaml`, `governance-delivery-monitor`, `governance-aware-seller` — media_buy lifecycle under the governance handshake. Appended to the existing `governance.denial_blocks_mutation` invariant; both run on every storyboard run in these specialisms.
  - Lists (3): `property-lists`, `collection-lists`, `content-standards` — no tracked lifecycle resource in their current phases, so silent today; wired so future phases that touch `media_buy` or `account` status (e.g. validation runs against delivery) are automatically gated.

  **Not wired:**

  - `brand-rights`, `signal-marketplace`, `signal-owned` — no formal lifecycle enum in the spec today. No observations, no value in wiring.
  - `audience-sync` — separate resource lifecycle not yet in the bundled transition tables.
  - `measurement-verification`, `signed-requests` — cross-cutting / preview; revisit once phases populate.
  - Sponsored intelligence (`si_session` is a tracked lifecycle) — specialism's `phases: []`, nothing to observe.

  **Dep bump:** `@adcp/client` `^5.9.1 → ^5.10.0`. 5.10.0 bundles `status.monotonic` as the fourth auto-registered default assertion; the side-effect import from `@adcp/client/testing` registers it so these YAML `invariants:` ids resolve without any additional loading.

- e7d742f: Split `pending_activation` media buy status into `pending_creatives` and `pending_start` for finer-grained lifecycle tracking. Replace InMemoryTaskStore with PostgresTaskStore for distributed MCP task handling. Refactor comply test controller to use SDK TestControllerStore pattern.

### Patch Changes

- 8ed0d4c: Extract the inline audience-status enum on `sync_audiences_response.audiences[].status` into a named schema `/schemas/enums/audience-status.json`, matching the pattern used by `media-buy-status.json`, `creative-status.json`, `catalog-item-status.json`, `proposal-status.json`, etc.

  Values are unchanged (`processing`, `ready`, `too_small`). The new enum file formalizes the existing descriptions and, in the process, documents the lifecycle transitions in prose on each `enumDescription`: `processing → ready | too_small` on matching completion; `ready ↔ processing` and `too_small → processing` on re-sync; `ready ↔ too_small` as member counts cross the platform minimum; delete/fail actions omit `status` entirely.

  Motivation: enables the `audience-sync` specialism to be wired into the bundled `status.monotonic` cross-step assertion in a follow-up — today it's the highest-volume mutating track outside sales without a formal lifecycle enum (surfaced during expert review on [adcp#2829](https://github.com/adcontextprotocol/adcp/pull/2829)). Adding the audience transition graph to `@adcp/client`'s `default-invariants` is a separate adcp-client PR once this lands and publishes; wiring `audience-sync/index.yaml` with `invariants: [status.monotonic]` is a follow-up adcp PR after that SDK release.

  No behavior change on the wire — `sync_audiences` responses that were valid before are valid after.

- 4d7eb0a: Update documentation for audience targeting
- 45650e1: Fix brand-protocol registration in the schema registry index so SDKs auto-generate the tools. The domain now exposes `get_brand_identity`, `get_rights`, `acquire_rights`, and `update_rights` under `tasks.*` (matching every other AdCP domain), with `rights-pricing-option`, `rights-terms`, `creative-approval-request/response`, and `revocation-notification` moved to `supporting-schemas`. Fixes #2245.
- b7e14ae: Add capability-discovery blocks so receivers can reason about operator posture at onboarding:

  - `webhook_signing` (top-level): declares RFC 9421 outbound webhook-signing support, closed-enum profile id (`adcp-webhook-9421-v1`), permitted algorithms (`ed25519`, `ecdsa-p256-sha256`), and whether the agent falls back to HMAC-SHA256 on the deprecated `push_notification_config.authentication` path.
  - `identity` (top-level): declares `per_principal_key_isolation`, `key_origins` (governance/request/webhook/TMP JWKS origin separation), and `compromise_notification` emit/accept posture. An empty `identity: {}` is schema-valid but advisory-neutral — receivers treat it as equivalent to omitting the block.
  - `adcp.idempotency.account_id_is_opaque`: flag signaling that `account_id` is an HKDF-derived blind handle rather than the buyer's natural account key. Wire shape is unchanged, but buyer replay/retry/logging behavior MUST change when the flag is true. Migration: sellers already deriving opaque `account_id` without declaring this flag will be misclassified by new buyers as natural-key sellers until the flag is set.

  Also fills the error-code enum for three governance/policy codes: `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `PERMISSION_DENIED`.

- 3d47896: spec(creative): require URL percent-encoding and prohibit nested expansion for catalog-item macro substitution (closes #2558)

  `docs/creative/universal-macros.mdx` defined the `{MACRO_NAME}` syntax and the catalog-item family (`{GTIN}`, `{JOB_ID}`, `{SKU}`, etc.) but specified no escaping contract or nested-expansion rule. Catalog-item macros are the one macro class where buyer-controlled data (the catalog feed) expands at impression time into publisher-controlled contexts (tracker URLs, landing URLs, VAST tags) — an attacker-adjacent flow.

  This change adds a "Substitution safety" subsection under Catalog Item Macros with three normative rules:

  - **Percent-encode every octet not in the RFC 3986 `unreserved` set.** Sales agents MUST percent-encode such that only `ALPHA / DIGIT / "-" / "." / "_" / "~"` remain unescaped before substitution into URL contexts. Non-ASCII octets MUST be percent-encoded after UTF-8 encoding per RFC 3986 §2.5. This is the `encodeURIComponent`-equivalent contract — broader than "reserved characters only," so CR/LF (header-smuggling vector), space, control characters, and Unicode bidi overrides (audit-log spoofing vector) are all escaped. Encoding is applied exactly once at substitution time; downstream VAST players and ad servers fire URLs verbatim without re-decoding.
  - **Nested macro expansion is prohibited.** Catalog-item values are not re-scanned after substitution for AdCP's `{...}` syntax. A `{JOB_ID}` value containing `{DEVICE_ID}` produces the literal `%7BDEVICE_ID%7D` in the emitted URL. The rule binds AdCP syntax only; downstream ad-server syntaxes (`%%GAM%%`, `${XANDR}`, `[VAST]`, `{{KEVEL}}`) remain the sales agent's responsibility to neutralize — percent-encoding per the rule above typically suffices, since `%`, `$`, `[`, and `{` all land outside `unreserved`.
  - **Scope is URL contexts only** — impression trackers, click trackers, VAST tracking events, AND landing/clickthrough URLs (the full Overview substitution target set). HTML-attribute contexts are out of scope; when a catalog-item value is rendered into an HTML attribute server-side, the renderer MUST additionally apply HTML-attribute escaping — the two encodings are layered, not alternatives, because the value must survive both the URL parser and the HTML attribute parser.

  Adds a 6-vector conformance fixture at `static/test-vectors/catalog-macro-substitution.json` pinning reserved-char breakout, nested-expansion literal preservation, CRLF injection, non-ASCII UTF-8, mixed path/query contexts, and bidi-override neutralization. All expected outputs match `encodeURIComponent` byte-for-byte.

  Scope deliberately narrow: buyer-controlled catalog-item macros only. Non-catalog macros (`{MEDIA_BUY_ID}`, `{DEVICE_ID}`, `{GEO}`, etc.) are populated from publisher/seller/ad-server-mediated state; their encoding is governed by the ad-server integration (OpenRTB, VAST) which percent-encodes by convention. Universal canonicalization across all macros would be scope creep pre-GA.

  No schema change. Sales agents that already use `encodeURIComponent`-equivalent encoding on catalog values stay conformant; agents using a "reserved characters only" or raw-passthrough encoding need to change before 3.0 GA.

- 2d072c1: Clarify push notification config flow in docs and schema.

  - Fix `push_notification_config` placement and naming in webhook docs (task body, not protocol metadata)
  - Add `push_notification_config` explicitly to `create_media_buy` request schema
  - Fix `operation_id` description: client-generated, echoed by publisher
  - Fix HMAC signature format to match wire implementation

- 985a77b: Delegate comply() to @adcp/client — server compliance module reduced from ~500 lines to re-exports + DB adapter
- f4ef555: Fix Mintlify callout syntax and add case-insensitivity notes for country/language codes

  - Convert `:::note` Docusaurus syntax to Mintlify `<Note>` components
  - Add case-insensitivity documentation for country codes (ISO 3166-1 alpha-2) and language codes (ISO 639-1/BCP 47)
  - Remove orphaned webhook-config.json and webhook-authentication.json schemas

- 56c68f8: spec(media-buy + creative): pin creative lifecycle on buy rejection/cancellation — assignments released, creatives remain in library (closes #2254, closes #2262)

  External contributor filed #2254 flagging that the spec did not define what happens to synced creatives when a media buy is subsequently rejected or canceled. Two defensible interpretations existed:

  - **Atomic** — buy rejection unwinds the creative create; the creative never existed in the library.
  - **Decoupled** — the creative enters the library regardless; buy rejection only releases the assignment.

  Partial text was added to `creative-libraries.mdx:252` adopting the decoupled interpretation, but the rule wasn't discoverable from the media-buy side (a seller implementer reading the Media Buy State Transitions section wouldn't learn it) and #2262's open questions (review flow fate, capability-flag scope, inline vs sync equivalence) were left implicit. This PR closes the loop.

  **Changes:**

  - `docs/media-buy/specification.mdx` (Media Buy State Transitions): adds a normative bullet stating that creative assignments are released on buy rejection or cancellation; creatives remain in the library and MAY be referenced by `creative_id` in a subsequent `create_media_buy` or `sync_creatives` call — including inline creatives submitted on the rejected/canceled create. Creative review proceeds independently; sales agents MUST NOT implicitly reject a creative because its containing buy was rejected. After a transition to `rejected` or `canceled`, released assignments no longer appear in `get_media_buys` responses for that buy.
  - `docs/media-buy/specification.mdx` (Package-level lifecycle): clarifies that package cancellation releases assignments on the canceled package only; creatives on other active packages on the same buy are unaffected.
  - `docs/creative/creative-libraries.mdx` (Path 2 inline): adds the reverse cross-reference to the media-buy rule, a MUST on deliberate-review-decision rejections (no implicit cascade from buy status), and a capability-flag scope note clarifying that `inline_creative_management: true` advertises inline acceptance, not a lifecycle tie to the buy.

  **Retention.** Adds a SHOULD-90-days retention placeholder referencing the normative retention contract tracked under #2260. Without a floor, "reusable by creative_id" would be a semantic promise with no operational teeth; 90 days matches the variant-retention guidance already present in `sales-agent-creative-capabilities.mdx`. The full retention contract stays on 3.1 (#2260).

  **Scope deliberately excludes:**

  - **Final retention floor** (#2260) — the normative number and the per-status differentiation (approved vs pending_review vs rejected). Needs implementer agreement; 3.1.
  - **Purge notification webhook** — part of the broader creative-lifecycle webhook work; 3.1.

  **Rejection-reason cascade on policy-based buy rejection** is resolved: no implicit cascade. If a creative triggered a policy-based buy rejection, the sales agent MAY reject the creative via the normal review path (with its own `rejection_reason`), but the buy's `rejected` status is not itself sufficient.

  No schema change. Sales agents that already keep inline creatives in the library after a buy rejection stay conformant; sales agents that unwind the library entry on buy rejection need to change before 3.0 GA.

- 93e19a1: Remove generated_creative_ref from build_creative and preview_creative schemas. Creative refinement uses manifest passback and creative brief updates instead. Document iterative refinement patterns for build_creative and get_signals.
- 3c7cc57: Deprecate X-Dry-Run HTTP header in favor of sandbox mode. Add explicit deprecation notices to sandbox docs and protocol compliance section. Upgrade seller sandbox requirements to RFC 2119 MUST/MUST NOT language. Update agent building and validation pages to document sandbox as the default testing mechanism. Update SKILL.md testing section to remove X-Dry-Run reference.
- 11b599e: Clarify the two-layer error model and add error-code taxonomy lint:

  - Documents the envelope-vs-payload distinction: `adcp_error` (MCP structuredContent / A2A DataPart / JSON-RPC error.data) signals transport-level failure; `errors[]` in the task payload carries task-level error arrays. Fatal failures SHOULD populate both layers (closes #2587).
  - Fixes four storyboard validators that pinned assertions to the payload shape (`check: field_present, path: "errors"`), which failed against conformant agents that surface errors only via the transport envelope. Replaces with `check: error_code`, which the runner resolves from either layer (closes #2587).
  - Adds `scripts/lint-error-codes.cjs` and the `test:error-codes` npm script. Every storyboard `error_code` assertion is validated against the canonical enum at `static/schemas/source/enums/error-code.json`. Wired into the main `npm test` pipeline — undefined codes fail the build (closes #2588).
  - Sets up the alias-file convention at `static/schemas/source/enums/error-code-aliases.json` (file created lazily on first rename) so code renames can land with a deprecation window rather than synchronized big-bang changes.

- a13f651: Follow-up to #2595 (error model) addressing protocol-review feedback:

  - `transport-errors.mdx` gains an **"Envelope vs. payload errors"** section cross-linking to the normative two-layer model in `error-handling.mdx`. Previously the normative text was orphaned — readers landing on transport-errors had no pointer to the payload layer.
  - `transport-errors.mdx` adds a sixth client-detection step for `payload.errors[0]` as a payload-layer fallback, plus a new **"Storyboard `check: error_code` contract"** section that promotes the shape-agnostic extraction contract from a YAML comment to spec-grade text.
  - `state-machine.yaml` narrative prose updated from `INVALID_STATE_TRANSITION` → `INVALID_STATE` to match the validator assertions. The controller's own enum keeps `INVALID_TRANSITION` (transition-vs-state distinction is meaningful at the state-machine primitive layer).
  - `comply-test-controller.mdx` gains an explanatory note distinguishing the controller-specific error enum (`INVALID_TRANSITION`, `INVALID_STATE`, `NOT_FOUND`, etc. per `comply-test-controller-response.json`) from the canonical seller-response `error-code.json` enum. Storyboard assertions on controller responses use `path: "error"`, not `check: error_code`.
  - New `static/schemas/source/enums/error-code-aliases.json` template file with an empty `aliases` map and a self-describing JSON Schema. Documents the alias shape so future renames have a home without ad-hoc invention. Lint continues to warn-only on aliased codes.
  - `tests/schema-validation.test.cjs` — the enum-values test now skips files with `$id` ending in `-aliases.json` (alias/metadata files are data, not enum schemas).

- f172af6: Add sync_governance to schema index for client discoverability.
- b046963: Fix 7 issues: get_signals docs, members CSS, training agent types, outreach SQL, brand localization, webhook HMAC spec, schema oneOf removal
- bd7ee99: Relax `core/assets/url-asset.json` `url.format` from `uri` to `uri-template` (RFC 6570).

  The prose spec (`docs/creative/universal-macros.mdx`) explicitly requires buyers to submit tracker URLs with raw AdCP macros like `{SKU}` / `{DEVICE_ID}` / `{MEDIA_BUY_ID}` at sync time — the ad server URL-encodes substituted values at impression time. Strict `format: uri` rejected those templates, which contradicted the spec and broke the `sales-social/catalog_driven_dynamic_ads/sync_dpa_creative` compliance fixture that was built against the prose convention (60 lint errors against every anyOf branch of creative-manifest.assets).

  `uri-template` accepts both plain URIs and RFC 6570 Level 1 templates (`{var}`), which is exactly the shape AdCP universal macros produce. The description now spells out the sync-time-raw / impression-time-encoded split so future fixture authors don't pre-encode. Also adds a Template Syntax section to `universal-macros.mdx` explicitly scoping AdCP to Level 1 — Level 2–4 operators (`{+var}`, `{#var}`, `{.var}`, `{/var}`, `{;var}`, `{?var}`, `{&var}`) are not used.

  **SDK migration note.** Any buyer-side SDK that defensively percent-encodes `{` / `}` in outbound `sync_creatives` payloads should stop — raw braces are now the canonical wire form at sync time. Pre-encoded macros never worked correctly in the first place (the ad server cannot find `%7BSKU%7D` to substitute) but some SDKs defensively encoded to satisfy strict uri validators; the schema relax removes the need.

  Scope note. Only `url-asset.json` is touched. Other asset schemas (image, video, audio, vast, daast, webhook) keep `format: uri` because their url fields point to dereferenceable CDN assets or live endpoints that the ad server fetches directly — never impression-time substituted.

  Surfaced by PR #2801 review (ad-tech-protocol-expert) after an initial misread of the step's impression-time-output narrative led to the wrong fix direction.

- 7567e27: Fix `webhook-emission.yaml` capability-discovery sanity check to validate a field that actually exists.

  The `get_capabilities` step asserted `field_present: "operations"` on the `get_adcp_capabilities` response, but the response schema has no `operations` field — webhook-emitting operations are advertised at the transport handshake (MCP `tools/list`, A2A skills), not in the capabilities body. The runner already keys off `options.agentTools` for that, making the validation both incorrect and redundant.

  Swapped to `field_present: "supported_protocols"`, which is a required top-level field in `get-adcp-capabilities-response.json`. Preserves the capabilities-body sanity check without asserting a field that was never meant to live there. Also tightened the step's `expected:` prose to reflect where the webhook-emitter gate actually lives (`$test_kit.operations.primary_webhook_emitter` resolution).

- fa3835c: Fix webhook-signing positive vectors 004 + 005 to apply full `@target-uri`
  canonicalization per the shared rules in `request-signing/canonicalization.json`.
  Previously both vectors signed the as-received URL instead of the canonical one,
  contradicting step 4 (strip default ports) and step 6 (uppercase `%xx` hex /
  decode percent-encoded unreserved).

  - 004-default-port-stripped: signature base now uses
    `https://buyer.example.com/...` (`:443` stripped) instead of
    `https://buyer.example.com:443/...`. Signature regenerated.
  - 005-percent-encoded-path: input URL changed from `op%2dabc` (where `%2d` is
    unreserved `-` and by step 6 MUST decode rather than just uppercase — the
    previous encoding overloaded the test) to `op_%e2%98%83` (reserved UTF-8
    bytes), matching the pattern in request-signing vector 008. Signature base
    uppercases hex to `%E2%98%83`. Signature regenerated.

  Both new Ed25519 signatures are deterministic and verify against the published
  `test-ed25519-webhook-2026` keypair.

  **Implementor note.** Any verifier that previously passed the old 004/005
  signatures has a latent canonicalization bug: it accepted signatures produced
  over the as-received URL rather than the canonical `@target-uri`. That verifier
  will silently disagree with a correctly-canonicalizing producer on any URL
  containing `:443`, `:80`, or lowercase `%xx` in the path, causing
  `webhook_signature_invalid` at step 10. Re-run the positive suite after
  pulling — vectors are frozen on commit and the fixed pair will not round-trip
  against a broken verifier.

- 12c09e0: Generalize `measurement_window` beyond broadcast TV. The concept — a maturation stage with its own expected data availability — applies equally to DOOH (`tentative` → `final` after IVT/fraud-check), digital with IVT filtering (`post_givt` → `post_sivt`), podcast (`downloads_7d` → `downloads_30d`), and any other channel where billing-grade data arrives in phases. The schema mechanism is unchanged; descriptions and examples on `measurement-window.json`, `reporting-capabilities.measurement_windows`, and `measurement-terms.billing_measurement.measurement_window` have been broadened so sellers in those channels know this is where they declare their maturation/processing cycle. Accountability, optimization-reporting, and get_media_buy_delivery docs updated to match. No field additions or removals.
- 5a977c3: Add media_buy_generative_seller storyboard for sellers that generate creatives from briefs at buy time
- c360ed5: Stop describing unsalted `hashed_email` and `hashed_phone` as privacy-preserving (closes #2454).

  Unsalted SHA-256 of the email or E.164 namespace is recoverable via precomputed dictionaries — it is pseudonymous PII, not anonymous. Schema descriptions, the glossary entry, and `sync_audiences` privacy language now say so explicitly, and `privacy-considerations.mdx` adds a normative section: unsalted hashed identifiers MUST NOT be described as privacy-preserving, MUST be treated as PII for retention/consent/DSAR/erasure, and a privacy-preserving match requires a recognized primitive (salt, HMAC, PSI, or TEE). No wire-format change — identifiers, patterns, and required fields are unchanged.

- 12a30f5: Add HMAC-SHA256 test vectors for cross-language webhook signature verification
- dfc8203: Update sync_audiences spec with clarifications
- afe43ee: Fix migration guide missing comply-blocking requirements

  - Add `buying_mode` as a required field on all `get_products` requests to the breaking changes table
  - Add warning callout for `buying_mode` comply-blocking requirement
  - Fix Accounts protocol row: protocol is required for all buyers, `require_operator_auth` determines which task (`sync_accounts` vs `list_accounts`) to call

- 65c2314: spec(governance): plan_hash polish bundle — additive items from #2480

  Lands the zero-breaking items from the plan_hash polish bundle. Pre-GA additions to the "Plan binding and audit" section that reduce divergence risk among early implementers without changing any existing behavior:

  **Spec polish (`docs/governance/campaign/specification.mdx` — Plan binding and audit):**

  - **Fail-safe on unknown bookkeeping fields.** Appended to the closed-list paragraph: implementations that discover additional GA-internal fields on their persisted plan state MUST treat them as IN the preimage until the profile version bumps. Closes the "anything that looks like bookkeeping → strip" shortcut that silently diverges implementations.
  - **Unicode homograph hardening.** Added to the caller-guidance bullets: `policy_ids` and `policy_categories` SHOULD be validated against a canonical allowlist server-side. JCS detects byte-level divergence correctly (visually-indistinguishable variants produce distinct hashes); this rule closes the plan-semantics gap where a homograph substitution authorizes a different enforcement outcome.
  - **Constant-time comparison hint broadened.** The existing auditor-only hint was generalized to all three verifier types (governance-agent self-integrity, auditor, buyer-side compliance) as a new "Constant-time comparison" paragraph at the end of the verification recipes. Cites `crypto.timingSafeEqual`, `hmac.compare_digest`, `crypto/subtle.ConstantTimeCompare`.
  - **Privacy considerations subsection.** New paragraph documenting the plan-mutation-cadence inference vector: parties retaining `governance_context` tokens can infer plan-mutation cadence from the sequence of distinct `plan_hash` values. Sensitive deployments should factor this into retention policy.

  **Test vectors (`static/compliance/source/test-vectors/plan-hash/`):**

  - **008-numeric-canonicalization.json** — new vector with fractional percentages (33.33, 33.334, 66.666) exercising RFC 8785 §3.2.2.3 number serialization. Pins library choice: hand-rolled `JSON.stringify + key sort` is likely to diverge on numeric edge cases that a JCS-compliant library handles correctly. All 11 vectors verified against `canonicalize@3.0.0`.
  - Vector-count references updated from "ten" to "eleven" in the spec and in the `check_governance` / `sync_plans` task pages.

  **Tooling:**

  - **`canonicalize` pinned to exact version** (`3.0.0`, no caret) in `package.json`. Drift risk: a patch release that changes `-0` / `NaN` / `Object.create(null)` handling would silently invalidate every vector. Pin now so vector regeneration is reproducible and changes in library behavior surface as explicit dep-update PRs.
  - **`.gitattributes`** added at repo root with `text eol=lf` for `static/compliance/source/test-vectors/plan-hash/**` and `static/test-vectors/**`. Prevents Windows CRLF conversion from silently changing bytes and invalidating the recorded SHA-256 digests (especially vector 007 with combining marks and Hebrew text).

  **Deferred to 3.1 (not in this PR):**

  - `revisionHistory` parenthetical rephrase (spec restructure, not a one-line polish).
  - Cross-reference anchor verification (done opportunistically — `#signed-governance-context` and `#plan-binding-and-audit` both resolve today).

  Vector generator note: no generator script exists yet under `.context/generate-plan-hash-vectors.mjs` as the original issue assumed. Vector 008 was computed inline using `canonicalize@3.0.0` + Node.js `crypto`. A generator can be factored out in a follow-up; the pinned dependency is the prerequisite regardless.

- 446a625: Add request and response schema links to preview_creative task reference, matching the pattern used by other creative task references.
- 00cd9b8: Extract shared PriceGuidance schema to fix duplicate type generation

  **Schema Changes:**

  - Create new `/schemas/pricing-options/price-guidance.json` shared schema
  - Update all 7 pricing option schemas to use `$ref` instead of inline definitions

  **Issue Fixed:**

  - Fixes #884 (Issue 1): Duplicate `PriceGuidance` classes causing mypy arg-type errors
  - When Python types are generated, there will now be a single `PriceGuidance` class instead of 7 identical copies

  **Note:** Issue 2 (RootModel wrappers) requires Python library changes to export type aliases for union types.

- 33a7f09: spec(media-buy): re-cancel error code — carve `NOT_CANCELLABLE` out of the `INVALID_STATE` terminal-state rule (#2617)

  Before this change, §128 allowed `NOT_CANCELLABLE` as a MAY for cancellation refusals, while §129 required `INVALID_STATE` as a MUST for any update to a terminal-state buy. Re-cancel — a `canceled: true` update against a buy already in `canceled` — fell under both rules at once, leaving the canonical error code ambiguous. The storyboard vector (`media_buy_seller/invalid_transitions > second_cancel`) pinned `NOT_CANCELLABLE`, so state-machine-first implementations returning `INVALID_STATE` were strictly spec-conformant against §129 but failed the vector.

  This clarification carves the cancellation case out of §129 and pins `NOT_CANCELLABLE` as the required code for re-cancel. The cancellation-specific error wins over the generic terminal-state error. No vector change — the storyboard is now aligned with the spec. Agents currently returning `NOT_CANCELLABLE` stay conformant; agents returning `INVALID_STATE` on re-cancel need to switch before 3.0 GA.

- d66bf3d: Remove deprecated v3 features: list_property_features task, list_authorized_properties task, adcp-extension.json schema, assets_required format field, and preview_image format field. All removed items have replacements via get_adcp_capabilities and the new assets discovery model.
- 33a7f09: spec(security): promote duplicate-object-keys body-well-formedness to normative step 14 of the request-signing verifier checklist (closes #2523)

  Before this change, the request-signing verifier checklist ended at step 13 (replay-cache insert) and treated duplicate-object-keys body rejection as a "known gap pending audit" with text pinning placement, error code, and ordering but no normative requirement. The webhook profile already had step 14 as MUST; the request surface did not.

  Parser-differential body attacks (CVE-2017-12635 class) have a larger blast radius on the request surface than on webhooks because request bodies carry spend-committing payloads (`create_media_buy`, `update_media_buy_delivery`). Leaving the MAY/hedged posture on the surface that matters more was the wrong default going into 3.0 GA.

  Changes:

  - Add step 14 (body well-formedness) to `#verifier-checklist-requests` as a MUST, mirroring the webhook profile. Error code: `request_body_malformed` (distinct from `request_signature_digest_mismatch` — the signature IS valid; the body parses to ambiguous state).
  - Add sub-steps 14a (strict-parse requirement) and 14b (logging discipline) that reference the webhook profile's 14a/14b for the per-language escape-hatch enumeration and key-name sanitization rules — profiles share the check, only error-code prefixes differ.
  - Update step 13 text to note the insert-before-step-14 ordering rationale (nonce burned on first sighting of cryptographically-valid frame regardless of body shape).
  - Resolve the previously-deferred `idempotency_key` duplicate-collision audit: step 14 runs before schema validation and idempotency-cache lookup, so duplicated `idempotency_key` is rejected at step 14 and never reaches the cache. No separate audit layer needed.
  - Remove the "known gap" / "tracked in #2523" hedges from the webhook checklist preamble — the two profiles now share step 14 identically (with profile-specific error codes).
  - Add `request_body_malformed` to the Transport error taxonomy table.

  No change to the legacy HMAC webhook scheme (already MUST-rejects duplicate keys) or to the 9421 webhook profile (already MUST at step 14). The mandatory-signing rollout for requests (#2307) remains on the 4.0 timeline; this change applies the body-well-formedness rule to any 9421-signed request in 3.0.

- 40aacfc: Tighten the AdCP RFC 9421 request-signing profile on interop and security-critical points surfaced by the TypeScript reference SDK implementation (adcp-client#575) and expert review. All changes are clarifications within the 3.0 substrate, not new behavior for signers that already match the reference vectors.

  **Binary value encoding pinned (#2341).** `Signature` and `Content-Digest` sf-binary tokens are normatively **base64url without padding** (RFC 4648 §5), overriding RFC 8941 §3.3.5's standard-base64 default. Matches the existing `nonce` rule; avoids two proxy hazards — `/` that some intermediaries rewrite and `=` that some structured-field parsers treat as a parameter delimiter. Verifiers MUST accept base64url-no-padding. A time-bounded SHOULD lets verifiers lenient-decode pure standard-base64 through AdCP 3.2 for counterparties predating this clarification, with a hard MUST-reject on **mixed-alphabet tokens** (any char in `[+/=]` plus any char in `[-_]` in the same value) to close the ambiguity where a mixed token could decode to different bytes across verifiers and let an attacker stage a `Content-Digest` mismatch. Shipped positive vectors already encode base64url-no-padding; no regeneration.

  **URL canonicalization algorithm expanded (#2343).** The `@target-uri` algorithm in `security.mdx` now:

  - **Pins UTS-46 Nontransitional** (CheckHyphens=true, CheckBidi=true, UseSTD3ASCIIRules=true, Transitional_Processing=false) for IDN → Punycode. Closes the single largest silent divergence between the three reference SDKs — TypeScript, Go, and Python all default differently.
  - **Rejects IPv6 zone identifiers** (RFC 6874) in signed URLs. Zone-ids are node-local per RFC 6874 §1 and have no meaning outside the signing host; an attacker signing `https://[fe80::1%25eth0]/op` on their LAN gains no verifiable identity at a remote verifier. Signers MUST NOT sign; verifiers MUST reject.
  - **Preserves consecutive slashes byte-for-byte** (was: collapsed). Preserving closes a path-confusion attack surface — a signer that canonicalizes `/admin//foo` → `/admin/foo` while the server routes `/admin//foo` to a different handler lets an attacker sign one URL and execute another. Deployments MUST disable slash-folding on signed routes (`nginx merge_slashes off`, Express no pre-normalization, Go 1.22+ `http.ServeMux` with explicit handler).
  - **Expands malformed-authority rejection** to cover bracket-mismatch IPv6 (`https://[::1/p`), bare IPv6 (`https://fe80::1/p`), empty authority (`https:///p`), userinfo-only (`https://user@/p`), port-only (`https://:443/p`), and raw non-ASCII host bytes.
  - **`@authority` is derived from the wire `Host`** header (or HTTP/2+ `:authority` pseudo-header), not from reverse-proxy state; MUST byte-for-byte equal the canonical authority from `@target-uri`. Closes a cross-vhost replay vector on shared verifier pools.
  - **Percent-encoding normalization** is spelled out for both directions: reserved characters stay encoded (`%3A` → `%3A`), unreserved are decoded per the full RFC 3986 §2.3 set (`%41` → `A`, not just `%7E` → `~`).
  - **Combined dot-segment + consecutive-slash cases** (`/a/.//b` → `/a//b`, `/a//../b` → `/a/b`) are pinned explicitly; parsers that treat `//` as a single boundary produce wrong output.

  **New conformance file: `canonicalization.json`.** Ships 31 fixed-input/expected-output cases (25 positive, 6 malformed-reject) exercising every step of the canonicalization algorithm, version-pinned to the 3.0 profile. Independent of crypto — SDKs can run the set without keys or a full verifier harness, making it the fastest way to surface cross-implementation divergence. Published at `/compliance/{version}/test-vectors/request-signing/canonicalization.json`.

  **New error code: `request_target_uri_malformed`** in the transport error taxonomy. The previous profile used `request_signature_header_malformed` for both actual header malformation and URL-parse rejections — semantically confusing since URL rejections happen before any signature header is inspected. The new code covers empty authority, bare IPv6, IPv6 zone identifiers, bracket-mismatch, raw non-ASCII host, and `@authority` / `Host` mismatch. `request_signature_header_malformed` continues to cover actual `Signature` / `Signature-Input` header problems and `Signature` / `Content-Digest` mixed-alphabet rejection.

  Closes #2341, #2343. Original profile: #2323 (3.0 GA).

- 8be601f: Clarify request-signing verifier checklist step ordering: the per-keyid replay-cache cap check is now formalized as **step 9a**, run after revocation (step 9) and **before** cryptographic verify (step 10). This makes conformance test vector `negative/020-rate-abuse.json` reproducible — previously the vector's expected outcome (`request_signature_rate_abuse`) was only producible when the cap check ran before crypto verify, but the checklist numbered the replay-related checks as step 12, _after_ crypto verify at step 10. The cap-check ordering parallels revocation: both are cheap O(1) rejections that MUST run before crypto verify so an abusive or revoked signer cannot force amplified Ed25519/ECDSA work on the verifier. Step 12 (nonce dedup) still runs after crypto verify so the replay cache is not consumed by invalid signatures.

  Updated files:

  - `docs/building/implementation/security.mdx`: added step 9a to the verifier checklist, motivated its placement between step 7 (JWKS resolve) and step 10 (crypto verify) — after 7 so the cap-state oracle only responds for keys already published in JWKS, before 10 to prevent amplified crypto work. Split the rationale section into three paragraphs: the cheap-rejections argument, the load-bearing cap-write invariant (external traffic can't grow the cap because inserts happen at step 13 after crypto verify), and the step-12-runs-post-crypto note. Added a "Single-process vs. distributed enforcement" paragraph to the Transport replay dedup section noting that step 9a is a cheap amplification guard while step 13's insert should be atomic with a cap check to avoid drift on Redis-backed verifiers. Added `isKeyidAtCapacity` to the reference TypeScript verifier. Aligned the shadow-mode conformance bullet at line 701 with the error-code-only grading contract.
  - `static/compliance/source/test-vectors/request-signing/negative/020-rate-abuse.json`: `failed_step` changed from `12` to `"9a"`, `spec_reference` now points at checklist step 9a, `$comment` explains the placeholder `Signature` bytes and why verifiers that defer the cap check until after crypto verify will fail this vector.
  - `static/compliance/source/test-vectors/request-signing/README.md`: updated 020 description, extended the `failed_step` field definition to allow string sub-step labels, documented the `replay_cache_per_keyid_cap_hit` test-harness state key alongside `replay_cache_entries` and `revocation_list`, and added a "Stateful pre-crypto negatives" group to the recommended run order so `017` (revocation) and `020` (cap) are validated together, before crypto-dependent negatives.
  - `static/compliance/source/specialisms/signed-requests/index.yaml`: replaced "13-step verifier checklist" with a reference to the 13 numbered steps plus sub-step 9a.

  No wire-format change. This is a verifier-side implementation-order clarification. Signers are unaffected.

  Reported as adcontextprotocol/adcp#2339. Surfaced by the Python SDK implementation at adcontextprotocol/adcp-client-python#183, where moving the cap check ahead of crypto verify produced the expected vector outcome without any vector edits.

- c070f80: Add 3 positive + 6 negative RFC 9421 request-signing conformance vectors covering: unreserved percent-decoding (%7E/%2D/%5F/%2E), reserved %2F preservation, IPv6 authority bracket handling, duplicate Signature-Input labels, multi-valued Content-Type/Content-Digest, unquoted sig-param strings, JWK alg/crv mismatch, and raw IDN U-label hosts.
- 2ee6ac7: Response schemas across property-list, collection-list, and governance families now accept the envelope-level `replayed` field that the seller's idempotency layer injects at response time.

  Fifteen `*-response.json` schemas previously declared `additionalProperties: false` at the root, so AJV validators compiled from them rejected `replayed: true` / `replayed: false` — even though `docs/building/implementation/security.mdx` (the idempotency storyboard) requires sellers to emit it on mutating responses. This produced a two-faced contract where `create_media_buy` accepted the same envelope field (via branch-level `additionalProperties: true` on its `oneOf`) while `create_property_list`, `sync_plans`, and others did not. Media-buy, signals, creative, content-standards, and sponsored-intelligence responses already accept envelope-level fields through their `oneOf` branches and did not need changing — only schemas with a root-level seal were affected.

  Affected schemas: property-list family (`create`, `update`, `delete`, `get`, `list`, `validate_property_delivery`), collection-list family (`create`, `update`, `delete`, `get`, `list`), and governance (`check_governance`, `get_plan_audit_logs`, `report_plan_outcome`, `sync_plans`).

  Fix: root-level `additionalProperties` flipped to `true` on all 15 so envelope-level fields pass through. The eight mutating responses (`create_*`, `update_*`, `delete_*` × 2 families, `report_plan_outcome`, `sync_plans`) also declare `replayed: { type: boolean }` explicitly — consistent with how `context` and `ext` are declared today — so AJV still type-checks it. Nested body `additionalProperties: false` is left intact; envelope extensibility is a root-level concession, not a license for drift inside list bodies.

  Regression coverage added in `tests/composed-schema-validation.test.cjs`: per-schema acceptance tests, a negative test (`replayed: "true"` as string must fail), a structural lint that walks every task-family `*-response.json` (including `oneOf`/`anyOf`/`allOf` branches) and fails on any sealed envelope without `replayed` declared, and a drift guard that asserts every inlined `replayed` description matches the canonical definition in `core/protocol-envelope.json`.

  Resolves #2839.

- ea313bb: Restore `sales` agent type to the enum. Migration 387 incorrectly renamed sales→buying, but they are distinct types: sales agents sell inventory (SSPs, publishers), buying agents buy inventory (DSPs, buyer platforms).
- 018ab61: Clarify sandbox account protocol by account model. Explicit accounts (`require_operator_auth: true`) discover pre-existing sandbox test accounts via `list_accounts`. Implicit accounts declare sandbox via `sync_accounts` with `sandbox: true` and reference by natural key.
- 6f3da9c: spec(schemas): canonicalize governance conditions shape and catalog item_count presence (#2603, #2604)

  `check-governance-response.json` now enforces the spec-described presence rules for `conditions`, `findings`, and `expires_at` via `if`/`then`:

  - `status: conditions` → `conditions` required with `minItems: 1` (a conditions decision with no conditions is non-actionable for the buyer)
  - `status: denied` → `findings` required with `minItems: 1` (a denial with no finding gives the buyer nothing to act on)
  - `status: approved` or `status: conditions` → `expires_at` required (descriptions already said so; the schema now enforces it)

  `sync-catalogs-response.json` now requires `item_count` when `action` is `created`, `updated`, or `unchanged`. The field was already defined on the schema; the tightening aligns it with storyboard assertions (e.g., `sales_catalog_driven` expects `catalogs[0].item_count`). `action: failed` and `action: deleted` still omit `item_count` as they do today.

  Audit against #2604's other instances:

  - `create-media-buy-response.json` `property_list` / `collection_list` echo: already in the schema via `packages[].targeting_overlay` (→ `property-list-ref` / `collection-list-ref`, both of which require `list_id`). Storyboard `inventory_list_targeting.yaml` reads via `media_buys[0].packages[0].targeting_overlay.property_list.list_id`. No change.
  - `list-creatives-response.json` `pricing_options`: already required as an array with `minItems: 1` referencing `vendor-pricing-option.json` (which requires `pricing_option_id`). No change.
  - `report-usage-request.json` `vendor_cost`: already in the items' required list. No change.

  Conformant agents that follow the prose descriptions already emit these fields; the tightenings move enforcement from "storyboards catch it" to "schemas catch it" so bad responses fail at `response_schema` validation instead of slipping through and failing a downstream `field_present` check with a less obvious diagnostic.

- faec09c: Clarify 3.0 security requirements before partners run these flows in production.

  - **SSRF (canonical rules in `security.mdx`).** Consolidated list of reserved IPv4 and IPv6 ranges (RFC 1918, RFC 6598 CGNAT, loopback, `169.254.0.0/16` with cloud metadata called out, `::ffff:0:0/96` IPv4-mapped IPv6, multicast). DNS-based filtering alone is insufficient — fetchers MUST pin the TCP connection to the validated IP or re-validate the post-handshake peer address. No redirect following on counterparty-controlled URLs.
  - **Webhook signatures.** The signed `{unix_timestamp}` MUST be the exact ASCII integer in `X-ADCP-Timestamp`; signers and verifiers MUST NOT derive it from any body field. Header format and body-field precedence spelled out explicitly.
  - **Offline reporting buckets (`#2223`).** IAM-layer prefix scoping (not obscurity), scoped `ListBucket` (not just `GetObject`) to prevent cross-tenant prefix enumeration, revocation tied to `account.status` transitions, `setup_instructions` marked as operator-facing with MUST NOT auto-fetch and indirect-prompt-injection guidance.
  - **Collection lists (`#2225`).** `auth_token` scope, per-seller issuance (MUST), log hygiene, webhook URL SSRF via canonical rules, normative HMAC-SHA256 signatures, distribution-ID format validation and rate limits. Compromise-driven revocation requires cache invalidation, not just TTL expiry.
  - **Managed network `authoritative_location` (`#2224`).** Validator fetch semantics (HTTPS only, no redirects, size and timeout caps), 24-hour cached fallback on 5xx with a 7-day absolute cap measured from the most recent successful fetch, non-monotonic `last_updated` treated as an invalid response to block rollback attacks, concrete change-detection thresholds, relationship-termination handling.
  - **TMP provider registration (`#2226`).** SSRF via canonical rules with connection pinning, dynamic-registration caller authentication, router-to-provider auth minimum bar, and `/health` info-leakage rules (no subsystem-specific status codes or response bodies).

- 8e67dd2: Mark Sponsored Intelligence as experimental in AdCP 3.0 using the canonical [experimental-status](/docs/reference/experimental-status) convention, replacing the prior "pre-release" and "Draft Specification" markers.

  Adds `x-status: experimental` to every SI schema (`si-capabilities`, `si-identity`, `si-ui-element`, the four session-lifecycle request/response pairs) and to the `sponsored_intelligence` field on `get_adcp_capabilities`.

  Introduces the `sponsored_intelligence.core` feature id in the canonical experimental-surfaces table. Sellers implementing any SI task MUST declare `sponsored_intelligence.core` in `experimental_features` on `get_adcp_capabilities`.

  Consolidates status signals across the FAQ, overview, specification, SI Chat Protocol page, task reference pages, What's New, and certification content so SI carries one contract, not three.

- 679ff68: spec(compliance): populate signals protocol baseline + fix signal storyboard gaps (#2356)

  The `protocols/signals/index.yaml` baseline was a 3.1 placeholder with
  `phases: []`, which meant every agent declaring
  `supported_protocols: ["signals"]` saw "Signals track — SKIP (not applicable)"
  regardless of how compliant its get_signals and activate_signal implementations
  were. Compliance coverage for signals agents could only come from claiming a
  specialism, which is not how protocol-level baselines are supposed to work.

  **Signals baseline**

  - Populates the baseline with three phases — capability_discovery, discovery
    (get_signals), and activation (activate_signal) — covering the subset of
    behavior that BOTH signal-owned and signal-marketplace specialisms depend
    on. The activation phase has two steps (agent destination + platform
    destination) because the signals spec requires every signals agent to
    accept both destination types; testing only one lets a non-conformant
    agent pass.
  - Adds `required_tools: [get_signals, activate_signal]` so an agent declaring
    signals without exposing those tools produces a `missing_tool` skip reason
    (per the runner-output contract in #2352) rather than the misleading
    `not_applicable`.
  - Carries `context_outputs` from the discovery step through to activation
    so both activation steps reuse the captured `signal_agent_segment_id`
    and `pricing_option_id` instead of hard-coded fixtures.

  **Signal specialism storyboard fix (bundled)**

  - Every `activate_signal` sample_request in `specialisms/signal-owned` and
    `specialisms/signal-marketplace` was missing `idempotency_key`, which the
    request schema marks as required. The `@adcp/client` runner (post
    adcp-client#602) forwards `idempotency_key` from sample_request through
    the request builder instead of silently auto-injecting, so a missing key
    in the storyboard now produces a schema-invalid request. Added
    `idempotency_key: "$generate:uuid_v4#<alias>"` to all four activation
    steps so the runner resolves a deterministic UUID per step.

  Baseline version bumped to 1.1.0 to mark the transition from placeholder
  to runnable storyboard.

- f2918f4: spec(compliance): define signed-requests-runner test-kit harness contract for stateful vectors (#2350)

  The signed-requests specialism grades agents against 28 conformance vectors; three
  negatives (016 replayed nonce, 017 key revoked, 020 per-keyid cap) assert verifier
  state a black-box runner cannot inject. This change adds the coordination contract
  a storyboard runner and an agent under test both read:

  - New `static/compliance/source/test-kits/signed-requests-runner.yaml` (id
    `signed_requests_runner`) declaring the runner's signing keyids, a dedicated
    pre-revoked keyid for vector 017, the grading-time per-keyid cap the runner
    will target for vector 020 (distinct from the production minimum, also
    declared on the same block so implementers don't copy-paste the test cap),
    the minimum replay-cache TTL that keeps vector 016's repeat-request probe
    reliable, and the sandbox-endpoint scope (the replay contract's first
    request is a live, validly-signed mutating operation and MUST NOT be graded
    against production).
  - New `test-revoked-2026` Ed25519 keypair in `keys.json` (adcp_use: request-signing)
    so vector 017 has a dedicated revoked key and does not conflict with either
    the purpose-mismatch vector (009, which uses `test-gov-2026`) or the runner's
    own signing key (`test-ed25519-2026`).
  - Vector 017 updated to sign with `test-revoked-2026` and carry the
    revocation-list pre-state targeting that keyid; `$comment` expanded to call
    out that a crypto-first verifier will fail the vector by returning
    `request_signature_invalid` instead of `request_signature_key_revoked`.
  - `requires_contract` field on vectors 016/017/020 (values `replay_window`,
    `revocation`, `rate_abuse`, matching the keys under
    `stateful_vector_contract` in the test-kit) so a runner can filter stateful
    vectors without hard-coding IDs.
  - Specialism narrative updated to point at the test-kit, spell out the
    precondition expectation, and state that vectors with an unsatisfied
    `requires_contract` grade as FAIL, not SKIP.
  - `TestKit` TS interface in `server/src/services/storyboards.ts` widened so
    harness-contract kits can load without lying about the shape (brand-identity
    kits remain structurally typed; only `id` is required at load time).

  Pre-signed `Signature` bytes are unchanged in all vectors; black-box runners
  re-sign dynamically, and the pre-signed bytes remain valid for white-box
  cross-SDK byte-equivalence checks. Unblocks the smoke-test slice of
  adcp-client#585.

- a4726d8: Wire first cross-step assertions to `universal/idempotency` (adcp#2639).

  The storyboard now declares `invariants: [idempotency.conflict_no_payload_leak, context.no_secret_echo]`, converting two reviewer-only checks — from the `key_reuse_conflict` phase's `reviewer_checks` block and the wider security guidance — into programmatic gates that fail the storyboard at runtime rather than waiting for human review.

  - `idempotency.conflict_no_payload_leak` — an `IDEMPOTENCY_CONFLICT` error body must contain only allowlisted fields (`code`, `message`, `status`, `retry_after`, `correlation_id`, `request_id`, `operation_id`). Any `budget`, `start_time`, `product_id`, nested `cached_payload`, etc. is flagged — leaking cached state turns key-reuse into a read oracle for an attacker who stole a key.
  - `context.no_secret_echo` — no response (success or error) may echo `Authorization: Bearer <token>` literals, verbatim copies of the test-kit's declared `api_key`, or suspect property names (`Authorization`, `api_key`, `bearer`, `x-api-key`) at any depth.

  Assertion TS modules ship in `server/src/compliance/assertions/` and register against `@adcp/client/testing`'s assertion registry at import time. Runners (CLI `--invariants` or direct `runStoryboard` callers) must load the modules before running the storyboard; the runner throws at start on unresolved ids rather than silently skipping.

  Bumps the `@adcp/client` dependency to `^5.8.1` to pick up the assertion-registry re-exports from `@adcp/client/testing`.

- 82134f1: Formalize storyboard runner semantics:

  - `comply_test_controller` gains five `seed_*` scenarios (`seed_product`, `seed_pricing_option`, `seed_creative`, `seed_plan`, `seed_media_buy`) so storyboards can declare prerequisite fixtures by stable ID without implementers having to guess which IDs the conformance suite expects (closes #2584).
  - Adds a declarative `fixtures:` block and `prerequisites.controller_seeding` flag to the storyboard schema. The runner auto-injects a fixtures phase that seeds via the new `seed_*` scenarios (closes #2585, Pattern A).
  - Specs the existing `context_outputs:` capture + `$context.<name>` substitution mechanism that the runner already implements but was previously undocumented (closes #2585 Pattern B and #2589).
  - Tightens the context-echo contract: MUST echo on both success and error, MUST NOT synthesize when the caller sent none, MUST NOT mutate. Storyboards MUST declare `context:` explicitly on any sample_request whose validator asserts on echoed context — runners MUST NOT auto-inject (closes #2589).

  No wire-breaking changes. The `comply_test_controller` scenario enum is extensible and adds new values only; existing agents are unaffected until they adopt `seed_*`.

- fd1efc4: Storyboard UX: short-circuit comply() when products fail, inline agent connect form, filter picker by capabilities, OAuth auth fallback, generative creative storyboard
- 2ed7c34: spec + compliance: three substitution-safety follow-ups pulled forward to 3.0 GA (closes #2650, #2654, #2655)

  Three follow-ups from the #2647 review cycle, originally milestoned 3.1, evaluated by expert reviewers as pre-GA-appropriate and landed here:

  ## #2650 — Unicode NFC normalization pinned (spec)

  The #2620 substitution rule did not pin a Unicode normalization form. Two implementations satisfying the unreserved-whitelist rule produced different bytes for the same visual string (`café` NFC = `%C3%A9` vs NFD = `e%CC%81`). Shipping 3.0 without this rule would lock in an interop gap.

  Fix: one normative paragraph in `docs/creative/universal-macros.mdx#substitution-safety-catalog-item-macros`:

  > Prior to percent-encoding, catalog-item values that are not already in Unicode Normalization Form C (NFC) MUST be normalized to NFC per Unicode Standard Annex #15. Sellers and buyers MAY send catalog values in any normalization form at `sync_catalogs` ingest (the catalog is stored as-supplied); the normalization to NFC is a step in the substitution pipeline immediately before percent-encoding, not a catalog-ingest requirement. NFKC / NFKD are **not** acceptable substitutes — their compatibility folding silently mutates fullwidth/halfwidth variants and other visually-distinct glyphs that legitimately appear in Japanese/Korean retailer catalogs.

  Plus added `nfc-normalization-before-encoding` vector to `static/test-vectors/catalog-macro-substitution.json` — value `cafe\u0301-amsterdam` (NFD, 15 bytes) → expected `caf%C3%A9-amsterdam` (NFC-normalized then encoded). Fixture header updated to note the NFC rule. All 8 vectors verified: NFC normalization + strict-RFC-3986 encoding reproduces each expected byte-exactly.

  ## #2654 — PHASE_TEMPLATE block (compliance, docs-only)

  Two consumers of `substitution_observer_runner` now exist (sales-catalog-driven, creative-generative) with ~150 LOC near-identical three-step phases. Before the third consumer copies-and-drifts, added an advisory `phase_template:` block to `static/compliance/source/test-kits/substitution-observer-runner.yaml` with `<<PLACEHOLDER>>` markers for the five fields that vary across specialisms (specialism slug, domain, catalog_id prefix, correlation_id prefix, template URL). Block is YAML comment, not runtime-enforced — deviation is legitimate; the value is that starting from the template avoids silent drift on the load-bearing fields (`require_every_binding_observed: true`, fixture-lookup binding shape, `requires_contract`).

  ## #2655 — vector_name authoring-time lint (compliance, new script)

  New lint at `scripts/lint-substitution-vector-names.cjs` (120 LOC, mirrors `lint-error-codes.cjs`). Walks every storyboard for `task: expect_substitution_safe` steps, extracts `catalog_bindings[].vector_name`, and asserts each is canonical in `static/test-vectors/catalog-macro-substitution.json`. Also cross-checks the runner contract's `canonical_vector_names` list against the fixture — drift between contract and fixture fails the lint.

  Wired in as `test:substitution-vector-names` in the aggregate `test` pipeline. Runs in CI; catches typos (`reserved-character-break0ut`) at build time rather than runtime. Non-canonical bindings with `raw_value`/`expected_encoded` overrides grade as warnings, not errors — custom vectors remain opt-in per the contract.

  ## Out of scope (still 3.1)

  - **#2651 (sales-social observation hook)** — stays 3.1. PM review recommended a narrower pre-GA win (attestation phase + one-line spec note) as separate work; not bundled here to keep this PR focused on pull-forwards that are already-reviewed and ready.
  - **#2654 options 2 and 3** (schema `include:` directive, first-class phase_type macro) — stay 3.1 per DX review.

- 3c23472: Per-item errors in sync_catalogs, sync_creatives, and sync_event_sources responses now reference error.json instead of bare strings, matching the operation-level errors pattern.
- a4aff56: fix: include editorial working group perspectives in public API
- dc93ef7: Pin the canonical on-wire JSON form for AdCP webhook signatures and close the signer-side serialization-mismatch trap.

  The legacy HMAC-SHA256 webhook signature covers `{unix_timestamp}.{raw_http_body_bytes}`. The spec previously said "never re-serialize the JSON" but did not pin the JSON serialization form the signer produces. The result: a silent cross-SDK bug where Python signers called `json.dumps(payload)` (spaced separators) while httpx wrote compact bytes on the wire, causing 401s at every compliant verifier (adcontextprotocol/adcp-client-python#205). Closes adcontextprotocol/adcp#2464.

  **Legacy HMAC (`docs/building/implementation/security.mdx`, `docs/building/implementation/webhooks.mdx`):**

  - New **Canonical on-wire form** rule — raw body bytes MUST be byte-identical to the wire; JSON serialization MUST use compact separators (`","` / `":"`). Matches JavaScript `JSON.stringify`, httpx defaults, and most HTTP-client JSON output.
  - New **Non-canonicalized aspects** rule — key ordering, unicode-escape policy, and number representation are NOT canonicalized (signers and verifiers compare bytes). Signers SHOULD NOT emit duplicate keys; verifiers MAY reject them (RFC 8259 §4 leaves duplicate-key parsing undefined).
  - New **Verifier input** rule — verifiers MUST use raw bytes captured pre-parse and SHOULD NOT re-serialize a parsed payload to reconstruct the signed bytes (re-serialization silently fails on key-order, unicode-escape, or number-format drift and masks signer bugs the verifier should surface). Verifiers that cannot capture raw bytes MUST fail closed.

  **RFC 9421 parallel fix (`docs/building/implementation/security.mdx`):**

  - Added a signer-side bullet to the "Known body-modifying transport patterns" warning: serialize the body once and use those exact bytes for both the `content-digest` input and the HTTP body. Same trap class as the HMAC bug, fails loud under 9421 (`webhook_signature_digest_mismatch`) but still worth calling out symmetrically.

  **Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**

  - Positive: whitespace-sensitive keys + nested objects/arrays in canonical compact form.
  - Positive: ASCII-escaped unicode (`\u00e9`) — paired with the existing raw-UTF-8 vector to make the "unicode-escape policy is not canonicalized" rule concrete.
  - Rejection: the Python-default spaced-form bug (signature over spaced bytes, raw body on the wire is compact — MUST NOT verify).

  **CI (`tests/webhook-hmac-vectors.test.cjs`):**

  - Added iteration over `rejection_vectors` so stale/typo'd rejection vectors fail CI. Previously only `vectors` were exercised.
  - Tightened the compact-vs-spaced sanity check to `startsWith('compact JSON')` / `startsWith('spaced JSON')` so new vectors containing those words in descriptions can't silently redirect the check.

- 9c1fc25: Update HMAC-SHA256 webhook spec to match the @adcp/client reference implementation: add X-ADCP-Timestamp header, sha256= signature prefix, timestamp-based replay protection, raw body verification guidance, and publisher signing example.
- f2157ea: Wire the `audience-sync` specialism storyboard (`static/compliance/source/specialisms/audience-sync/index.yaml`) with `invariants: [status.monotonic]`, closing the last gap from [adcp#2829](https://github.com/adcontextprotocol/adcp/pull/2829). `sync_audiences` responses now get the same cross-step lifecycle gating as media-buy, creative, account, si_session, catalog_item, proposal, and creative_approval.

  `status.monotonic` was extended to track the audience lifecycle in [adcp-client#782](https://github.com/adcontextprotocol/adcp-client/pull/782), shipped in `@adcp/client@5.11.0`. Bump the repo's `@adcp/client` dep `^5.10.0 → ^5.11.0` to pick up the graph. Transition table is fully bidirectional across `processing / ready / too_small`, matching the "MAY transition" hedging on `audience-status.json`'s prose (landed in [adcp#2836](https://github.com/adcontextprotocol/adcp/pull/2836)).

  No wire change. Any seller that was passing the `audience-sync` storyboard on the old `@adcp/client` will continue to pass unless they were emitting an off-graph status transition — which is exactly what the assertion should catch.

- ff9094c: spec + tooling: introduce `x-entity` schema annotation and cross-storyboard context-entity lint (#2660, rule 3 of the #2634 contradiction trio)

  Adds a non-validating `x-entity` annotation that tags schema fields carrying entity identity (e.g., `advertiser_brand`, `rights_holder_brand`, `rights_grant`). Ships the annotation on `brand/` schemas — the canonical `brand_id` advertiser-vs-rights-holder conflation from #2627 — and leaves other domains silent until follow-up PRs annotate them.

  - New: `core/x-entity-types.json` registry enumerating 24 entity types
  - New: `scripts/lint-storyboard-context-entity.cjs` walks storyboard `context_outputs` and `$context.*` refs (both bracket `rights[0].rights_id` and dotted `rights.0.rights_id` forms), resolves `x-entity` at both ends, flags mismatches; also catches capture-name collisions and unregistered `x-entity` values with a did-you-mean suggestion
  - New: `docs/contributing/x-entity-annotation.md` authoring guide (cross-linked from `storyboard-authoring.md` and `.agents/playbook.md`)
  - Wired into `npm test` and `npm run build:compliance` alongside the existing storyboard lints

  The lint is silent on fields without annotations, so partial rollout across the remaining domains (media-buy, signals, creative, account, governance, property, sponsored-intelligence) is safe.

- 915f4d2: spec + tooling: complete the `x-entity` annotation rollout (#2660 phase 4, capstone)

  Annotates the final three domains (property/, collection/, sponsored-intelligence/), ships the mechanical annotation script as a committed artifact, and wires a coverage counter into build output. Closes #2660.

  Registry addition:

  - `offering` — brand-published offering (campaign, promotion, product set, service). `offering_id` in core/offering.json, sponsored-intelligence/si-get-offering-\*, sponsored-intelligence/si-initiate-session-request, and as a catalog item-type id when `core/catalog.json::type` is `offering`.

  Shared-type annotations (propagate via `$ref`):

  - `core/offering.json::offering_id` → `offering`
  - `core/property-id.json` (root) → `property`
  - `core/property-list-ref.json::list_id` → `property_list`
  - `core/collection-list-ref.json::list_id` → `collection_list`

  Domain leaves:

  - **sponsored-intelligence/**: 10 annotations (session_id, offering_id, media_buy_id on initiate-session)
  - **property/**: 8 annotations on list_id across CRUD + validation + webhook schemas
  - **collection/**: 6 annotations on list_id across CRUD schemas

  Tooling shipped (DX expert recommendations):

  - `scripts/add-x-entity-annotations.mjs` — committed, config-driven patch script (reads `scripts/x-entity-field-map.json`). Overlay maps handle domain-specific ambiguities (list_id, plan_id, pricing_option_id).
  - `scripts/x-entity-field-map.json` — canonical field→entity map, extensible for future PRs.
  - Coverage counter in `npm run build:compliance` and `npm run test:storyboard-context-entity` output — honest signal counting annotations across domains and registry usage, without inflating the denominator with catalog-item-internal ids or dedup keys.
  - `npm run check:x-entity-gaps` — advisory-only lister of un-annotated id-shaped fields per domain, for authors adding new schemas.

  Closes [issue #2660](https://github.com/adcontextprotocol/adcp/issues/2660). Follow-up #2685 remains open for the inline-vs-registry `governance_policy` schema-shape split.

- bdfe6f7: spec: extend `x-entity` annotation to account and governance domains (#2660 phase 3)

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

- 68db189: spec + tooling: split `governance_policy` into registry vs. inline namespaces (closes #2685)

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

- 569a598: spec: extend `x-entity` annotation to media-buy, creative, and signals domains (#2660 phase 2)

  Follows phase 1 (#2668) which added the `x-entity` annotation registry and the cross-storyboard context-entity lint with `brand/` annotated as the canonical case. Phase 2 sweeps the three sales-flow domains — where most real `$context` capture/consume flows happen — and annotates the core/ shared types they share.

  Annotations added (no new entity types needed from the registry):

  - **Core shared types** (single edit propagates to every `$ref` site): `core/account.json`, `core/account-ref.json`, `core/media-buy.json`, `core/package.json`, `core/product.json`, `core/catalog.json`, `core/creative-asset.json`, `core/creative-assignment.json`, `core/format-id.json`, `core/signal-id.json`, and the core task shapes (`protocol-envelope`, `tasks-get-request`, `tasks-get-response`, `tasks-list-response`, `mcp-webhook-payload`)
  - **media-buy/**: `media_buy_id`, `media_buy_ids[]`, `package_id`, `product_id`, `pricing_option_id`, `audience_id`, `event_source_id`, `catalog_ids[]`, `task_id` across request/response pairs; `plan_id` on `create-media-buy-request` annotated as `governance_plan`
  - **creative/**: `creative_id`, `creative_ids[]`, `media_buy_ids[]`, `package_id`, `task_id` across request/response pairs
  - **signals/**: `signal_agent_segment_id` (→ `signal_activation_id`), `pricing_option_id`, and `signal` via the shared `core/signal-id.json` annotation

  Registry change: `pricing_option` split into `product_pricing_option` (seller product rate card) and `vendor_pricing_option` (agent-issued service pricing — rights, signals, creative, governance). The two live in different namespaces and a storyboard capturing one and consuming the other would be the same bug shape as the #2627 brand_id conflation.

  Lint enhancements:

  - Walker now reads root-level `x-entity` on composite types (oneOf/anyOf/allOf) before descending into variants. This lets shared types like `core/signal-id.json` carry one root annotation that applies to whole-object captures such as `signals[0].signal_id`, without duplicating on each variant.
  - New `composite_entity_disagreement` schema rule flags when a root `x-entity` and a variant's `x-entity` disagree at the empty path — the root wins silently, so forcing them to agree (or removing one) prevents a future hidden-drop hazard.

  Three regression-guard tests added covering the walker enhancement, array-items path resolution, and root+variant disagreement detection.

  Remaining domains for follow-ups: `account/`, `governance/`, `property/`, `collection/`, `sponsored-intelligence/`.

## 3.0.0

See [release notes](docs/reference/release-notes.mdx) for migration guidance, or [prerelease upgrade notes](docs/reference/migration/prerelease-upgrades.mdx) for rc.3 adopters.

### Breaking Changes — trust surface

- 43586d6, c1d2ff1: Require `idempotency_key` on all mutating requests; formalize seller declaration as discriminated oneOf (#2315, #2436, #2447). Every mutating task now requires an `idempotency_key` in the request envelope, matching `^[A-Za-z0-9_.:-]{16,255}$`; AdCP Verified additionally requires a cryptographically-random UUID v4. Fresh key per logical operation; reuse only to retry a failed request with the identical payload.

  Sellers declare dedup semantics on `get_adcp_capabilities` as `adcp.idempotency = { supported: true, replay_ttl_seconds: <1h–7d, 24h recommended> }` OR `{ supported: false }`. When `supported: true`, sellers respond `replayed: true` on exact replay, `IDEMPOTENCY_CONFLICT` when the same key accompanies a different payload, and `IDEMPOTENCY_EXPIRED` after the declared TTL. **When `supported: false`, sending an `idempotency_key` is a no-op — the seller will NOT return conflict/expired errors, and a naive retry WILL double-process.** Buyers must use natural-key checks (e.g., `get_media_buys` by `buyer_ref`) before retrying spend-committing operations against non-supporting sellers. Clients MUST NOT assume a default — a seller without this block is non-compliant.

  Since `supported: true` is a trust-bearing claim, buyers and conformance runners SHOULD probe by replaying with a deliberately-mutated payload — a conformant seller MUST return `IDEMPOTENCY_CONFLICT`. Sellers declaring `supported: true` MUST pass this probe in the baseline compliance storyboard before the declaration is considered verified.

- aaace06: Model IO approval at the task layer, not as a media-buy status (#2270, #2351). `MediaBuy.pending_approval` is removed. Approvals are now modeled as explicit approval tasks with their own lifecycle, state, and audit trail — decoupled from the media-buy state machine. Enables `sales-guaranteed` sellers to implement human-in-the-loop approval without overloading media-buy status semantics.

- e6dd73a: GDPR Art 22 / EU AI Act Annex III enforced as JSON Schema invariants (#2310, #2338). `budget.authority_level` enum is removed and replaced by two orthogonal fields: `budget.reallocation_threshold` (number ≥ 0, or `reallocation_unlimited: true`) for budget autonomy, and `plan.human_review_required` (boolean) for per-decision review under Art 22. Cross-field `if/then` rejects `human_review_required: false` when `policy_categories` contains `fair_housing`, `fair_lending`, `fair_employment`, or `pharmaceutical_advertising`, or when any resolved policy carries `requires_human_review: true`. `revisionHistory` is append-only; downgrading `human_review_required` requires a `human_override` artifact (≥20-char reason, email approver, 24h-fresh `approved_at`). `eu_ai_act_annex_iii` seeded as a registry regulation. `data_subject_contestation` on `brand.json` (and inline on `brand-ref.json`) satisfies Art 22(3) discovery.

- ec06d47, 31aab3a: Specialism taxonomy finalized (#2332, #2336). `inventory-lists` specialism renamed to `property-lists`. New `collection-lists` specialism split out as a sibling under `governance`. Account migration on specialism declarations complete — agents declare specialism ownership via the account surface. `audience-sync` already reclassified from `governance` to `media-buy` in #2300.

- 84b322c: Rename compliance taxonomy `domains` → `protocols` (#2300). `/compliance/{version}/domains/` becomes `/compliance/{version}/protocols/`. `supported_protocols` value maps to compliance path via snake_case → kebab-case (e.g. `media_buy` → `protocols/media-buy/`). `audience-sync` reclassified from `governance` to `media-buy` to match its tool family. Compliance runner path resolution, index.json structure, and catalog documentation all reflect the rename.

### Breaking Changes

- 80ecf76: Simplify capabilities model for 3.0 (#2143). Remove redundant boolean gates — object presence is the signal. Make table-stakes fields required.

  **Removed fields:**

  - `media_buy.reporting` (product-level `reporting_capabilities` is source of truth)
  - `features.content_standards` / `features.audience_targeting` / `features.conversion_tracking` (object presence replaces booleans)
  - `content_standards_detail` → renamed to `content_standards`
  - `brand.identity` (implied by brand protocol)
  - `trusted_match.supported` (object presence)
  - `targeting.device_platform` / `targeting.device_type` (implied by media_buy)
  - `targeting.audience_include` / `targeting.audience_exclude` (implied by audience_targeting)

  **Required fields:**

  - `reporting_capabilities` on every product (see `product.json`)

- a90700f: Revert geo capability flattening (#2157). Restore `geo_countries` and `geo_regions` (booleans) and `geo_metros` and `geo_postal_areas` (typed objects with `additionalProperties: false`) as primary capability fields. Remove flat array alternatives (`supported_geo_levels`, `supported_metro_systems`, `supported_postal_systems`) introduced in #2143.

- 95f1174: Media buy status lifecycle (#2034). Rename `pending_activation` → `pending_start`. Add `pending_creatives` status for approved buys with no creatives assigned. Add top-level `compliance_testing: { scenarios: [...] }` capability block (not a `supported_protocols` value) for declaring `comply_test_controller` support.

- 100b740: Move storyboards into the protocol as `/compliance/{version}/` (#2176). Add `specialisms` field to `get_adcp_capabilities` with 21 specialisms across 6 domains (media-buy, creative, signals, governance, brand, sponsored_intelligence). Promote `sponsored_intelligence` from specialism to full protocol in `supported_protocols`. Rename `broadcast-platform` → `sales-broadcast-tv`, `social-platform` → `sales-social`. Merge `property-governance` + `collection-governance` into `inventory-lists`. Add `status: preview` marker for 3.1 archetypes (`sales-streaming-tv`, `sales-exchange`, `sales-retail-media`, `measurement-verification`). Publish per-version protocol tarball at `/protocol/{version}.tgz` for bulk sync. New `enums/specialism.json` and `enums/adcp-domain.json`.

- 07d82dd: Require `account` on `update_media_buy` for governance and account resolution parity with `create_media_buy` (#2179). Flatten `preview_creative` union schema into single object with `request_type` discriminant.

- b674082: Add `GOVERNANCE_DENIED` to standard error codes with correctable recovery (#2194). Make `signal_id` required on `get-signals-response` signal items. Add `context` and `ext` fields to all request/response schemas (governance, collection, property, sponsored-intelligence, content-standards).

- 60f2a9e: Generalize governance to all purchase types (#2014). Remove `media_buy_id` from governance schemas — `governance_context` is the sole lifecycle correlator. Add `purchase_type` field on `check_governance` and `report_plan_outcome`. Add budget allocations on plans for per-type budget partitioning. Audit logs group by `governance_context` instead of `media_buy_id`.

### Minor Changes — trust surface

- 9e1b0eb: **RFC 9421 request signing profile (optional in 3.0, mandatory under AdCP Verified)** (#2323). Agents MAY sign mutating requests using RFC 9421 HTTP Message Signatures with Ed25519 over a canonicalized covered-component list (including method, target URI, `content-digest`, and protocol-level fields). Published test vectors (`request-signing/positive/*`, `request-signing/negative/*`) and a 15-step verification checklist (alg allowlist, `keyid` cap-before-crypto, JWKS resolution via SSRF-validated fetch, replay dedup via `jti`). sf-binary encoding pinned (#2341) and URL canonicalization tightened (#2343) so independent implementations produce bit-identical canonical inputs. Verifier guidance at `docs/building/implementation/security.mdx`; test vectors at `static/compliance/source/test-vectors/request-signing/`.

- 2e3ec71: **Signed JWS `governance_context`** (#2316). `governance_context` is a signed JWS produced by the governance agent and echoed by the buyer in the media-buy envelope. Sellers verify the signature using the governance agent's JWKS (resolved via `sync_governance`) and bind decisions to a specific buyer, plan, phase, and time. Replaces the opaque-string carrier from earlier 3.0 drafts. Enables sellers to reject stale or forged governance decisions without round-tripping to the governance agent. Fields: `alg`, `typ`, `iss`, `sub`, `aud`, `phase`, `exp`, `iat`, `jti`, plus governance-specific claims.

- f2918f4: **Signed-requests runner harness contract** (#2350, #2353). Compliance runner declares a `signed_requests` harness profile: given a seller endpoint and a signing keypair, the runner issues a battery of signed requests and validates conformance to RFC 9421 + the AdCP profile. Covers positive cases, tampering (header injection, body mutation, timestamp skew), replay (`jti` reuse), and `keyid`-cap-before-crypto path. Runner output conforms to `static/compliance/source/runner-output.json`.

- feat(compliance): Universal security baseline storyboard (#2304). Every AdCP agent now runs `/compliance/{version}/universal/security.yaml` regardless of claimed protocols or specialisms. Covers unauthenticated rejection, API key enforcement (when declared), OAuth discovery per RFC 9728, audience binding, and the request-signing harness when signing is declared. Failing the security storyboard fails overall compliance.

- 7eacbc3: Require cross-instance state persistence (#2363). Architecture specification now REQUIRES that agent state (tasks, media buys, plans, signed artifacts, idempotency keys) be persistent across horizontally-scaled instances. In-memory-only state is non-compliant for any production agent. Enables idempotency semantics, task resumption, and multi-instance fleets to behave consistently from a buyer's perspective.

- 8856f2e: Security narrative, threat model, and principal terminology retirement (#2381). New `docs/building/implementation/security.mdx` explains the 3.0 trust model end-to-end: transport auth (MCP bearer, OAuth 2.1 + RFC 9728), request-level auth (RFC 9421 signing), governance-level auth (signed JWS `governance_context`), and idempotency semantics. Retires ambiguous "principal" terminology in favor of three explicit roles: brand (who the campaign is for), operator (who runs the campaign on the brand's behalf), and agent (what software places the buy).

- ab95109: Runner output contract + security hardening (#2352, #2364). Compliance runner produces a signed, structured output artifact (`runner-output.json`) that third parties can verify independently. Output includes per-storyboard verdicts with evidence, the agent's declared capabilities at evaluation time, and a hash chain over the test-kit corpus so tampering is detectable.

- da1bc66: **Unify webhook signing on the AdCP RFC 9421 profile** (#2423). Webhooks are now a symmetric variant of request signing — the seller signs outbound webhook requests with a key published at its `jwks_uri` (discoverable via `brand.json` `agents[]`), and the buyer verifies against that JWKS. No shared secret crosses the wire. `push_notification_config.authentication` is optional (was required); 14-step webhook verifier checklist with `webhook_signature_*` error codes covers trust-anchor scoping, downgrade resistance, and per-keyid replay dedup (100K / 10M caps). Baseline-required in 3.0 — sellers emitting webhooks MUST sign. HMAC-SHA256 remains a legacy fallback for 3.x; removed in 4.0.

- 14a3864: **Require `idempotency_key` on every webhook payload** (#2416, #2417). Webhooks use at-least-once delivery, so receivers must dedupe. Every webhook payload now carries a required sender-generated `idempotency_key` stable across retries of the same event, using the same name and format as the request-side field (16-255 chars, cryptographically random UUID v4 required — predictable keys allow pre-seeding a receiver's dedup cache). Replaces fragile `(task_id, status, timestamp)` tuples. Schemas updated: `mcp-webhook-payload`, `collection-list-changed-webhook`, `property-list-changed-webhook`, `artifact-webhook-payload`, `revocation-notification` (renames `notification_id` → `idempotency_key` to unify protocol-wide dedup vocabulary).

- 7aaf579: Tighten the governance-invocation threshold (#2403, #2419). When a governance agent is configured on the plan, sellers MUST call `check_governance` before committing budget, and MUST reject a spend-commit lacking a valid `governance_context` with `PERMISSION_DENIED`. Closes the loophole where execution-path governance could be skipped on partial spends.

- d874136: **Experimental status mechanism** (#2422). New `status: experimental` marker for protocol fields and tasks that are in production-tested use but not yet covered by full stability guarantees. Implementations MAY adopt experimental features; breaking changes remain possible within the 3.x line. `custom` pricing-model escape hatch added on signals so non-standard pricing constructs can round-trip through the protocol without blocking stable-model adoption.

### Minor Changes

- 57d6e6c: Add collection lists for program-level brand safety (#2005). Collection lists are a parallel construct to property lists using distribution identifiers (IMDb, Gracenote, EIDR) for cross-publisher matching. Supports content rating and genre filters. New targeting overlay fields (`collection_list`, `collection_list_exclude`) enable both inclusion and exclusion. New genre taxonomy enum. 16 new collection schemas.

- 63dba34: Broadcast TV support (#2046). Ad-ID identifiers via `industry_identifiers` on creative assets and manifests. `creative-identifier-type` enum (`ad_id`, `isci`, `clearcast_clock`). Broadcast spot formats (:15, :30, :60). `agency_estimate_number` on media buys and packages. Measurement windows (Live, C3, C7) on `reporting_capabilities` and `billing_measurement`. `is_final` and `measurement_window` on per-package delivery data.

- e628d69: Structured measurement terms and cancellation policy for guaranteed buys (#1962). New `measurement_terms` schema for billing measurement vendor, IVT threshold, and viewability floor negotiation. New `cancellation_policy` schema for guaranteed products with notice periods and penalties. New `viewability-standard` enum. `TERMS_REJECTED` error code.

- 7086cc2: Unified vendor pricing across creative, governance, and property list agents (#1937). New `vendor-pricing-option.json` and `creative-consumption.json` schemas. Add `pricing_options[]` to `list_creatives` response, `build_creative` response, `get_creative_features` response, and `property-list.json`. Add `account` and `include_pricing` to `list_creatives` request. Add `pricing_option_id`, `vendor_cost`, and `consumption` to `build_creative` response.

- 7736865: Per-request version declaration (#1959). Add `adcp_major_version` field to all 56+ request schemas. Buyers declare which major version their payloads conform to. Sellers validate against `major_versions` and return `VERSION_UNSUPPORTED` if unsupported. When omitted, sellers assume their highest supported version.

- 106831c: Broadcast forecast schema (#1853). Add `measurement_source`, `packages`, and `guaranteed_impressions` to `DeliveryForecast`. New `forecast-range-unit` and `forecastable-metric` enums.

- 38957fa: Formalize offline/bucket reporting delivery (#2198). Add `reporting_delivery_methods` to capabilities, `reporting_bucket` to accounts, `supports_offline_delivery` to product `reporting_capabilities`. New `cloud-storage-protocol` enum.

- 457a5ba: Add Avro and ORC as file format options for offline reporting delivery (#2205).

- f0083c3: TMPX exposure tracking, country-partitioned identity, and macro connectivity (#2079). Add `agent-encryption-key` schema. Update `identity-match-request` and `identity-match-response` schemas. Add new universal macros.

- 89cb946: Add TMP provider registration schema (`provider-registration.json`) with provider endpoint, capabilities, lifecycle status (active/inactive/draining), and timeout budgets. Health endpoint (`GET /health`). Dual discovery models (static config and dynamic API) (#2210).

- 5dec4a4: TMP Identity Match supports multiple identity tokens per request (#2251). Replaces single `user_token` + `uid_type` with an `identities` array (minItems 1, maxItems 3). Router filters per provider and re-signs; `identities_hash` and cache key use RFC 8785 JCS canonicalization. `consent_hash` partitions cache by consent state. Adds `rampid_derived` to `uid-type` enum. TMP remains pre-release in 3.0; stable surface targeted for 3.1.0.

- a497d02: Add `border_radius`, `elevation`, `spacing`, and extended color roles to `brand.json` visual tokens (#1871).

- 4ffb1c1: Add `station_id` and `facility_id` identifier types for broadcast stations. Add `linear_tv` as a property type (#1912).

- cf4e9ee: Extend brand fonts with structured definitions including `weight`, `style`, `stretch`, `optical_size`, and `usage` (#1856).

- 5e9a748: Add generic `agents` array to `brand.json` schema with `brand-agent-type` enum for declaring brand-associated agents (#1973).

- b674082: Flatten `comply_test_controller` from oneOf union to flat object with scenario discriminant and if/then conditional validation (#2194).

### Patch Changes

- 399fd77: Add `relationship` field to brand.json property definition (`owned`, `direct`, `delegated`, `ad_network`) for bilateral verification with `adagents.json` delegation types (#2171).

- ea313bb: Restore `sales` to `brand-agent-type` enum for publisher-side sales agents (#2125).

- 3c23472: Per-item errors in `sync_creatives`, `sync_catalogs`, and `sync_event_sources` responses now use `error.json` ref instead of bare strings (#2060).

- 4bc686d: Add "Required tasks by protocol" reference page consolidating required, conditional, and optional tasks across all AdCP protocols by agent role (#2204).

- 91eeb76: Add managed network deployment guide for `adagents.json` at scale covering `authoritative_location` pointer files, delegation types, and deployment patterns (#2169).

- 3c7cc57: Deprecate `X-Dry-Run` header documentation, standardize on sandbox mode (#2092).

- 475c2f6: Clarify TMP uses path-based endpoints, not type-based dispatch (#2031).

- b95ac19: Document `MediaBuyStatus` breaking change (`pending_activation` split) and migration guide (#2035).

- 601f1dd: Add "Operating an Agent" guide (#2202, #2362) for publishers without engineering teams — three paths: partner with a managed platform, self-host a prebuilt agent, or build your own.

- f916b00: Publish named release cadence policy (#2312, #2313, #2359). AdCP follows semver with predictable cadence: patch releases monthly for security and doc fixes, minor quarterly for additive features, major annually if needed. v2 EOL August 1, 2026.

- 532578f, 601f1dd: Publish `CHARTER.md` (#2309, #2321). Formal governance charter linked from README, IPR, and intro.

- bec4e4b: Harden creative lifecycle for 3.0 (#2357). Decouple creative state from assignment so inline and library flows can reference the same creative without state conflicts.

- 679ff68: Populate signals protocol baseline storyboard phases (#2365). Makes the signals domain baseline executable under the compliance runner.

- 84b322c: Scope3 Common Sense renamed to CSBS (Common Sense Brand Suitability) throughout the policy registry (#2305, #2318).

- 02b4a59, 60e31f8: AI disclosure page and footer transparency on the main site (#2311, #2329, #2382).

- 39977c9: Registry publication-completeness linter (#2319, #2361) — catches policy entries missing required fields before they reach the registry.

- cae0ead: Spec-hardening pass: trust, commerce, and governance semantics (#2415). Closes the hostile-reviewer punch list identified during 3.0 spec review.

- 91334fe: Lint storyboards for `idempotency_key` on mutating steps (#2372, #2373). Ensures compliance storyboards model idempotency correctly.

- b508749: Schema-mutating lint + `past_start_date` split (#2376, #2377). Separate error for start-date-in-the-past vs schema validation failures.

- 40aacfc: Pin sf-binary encoding + tighten URL canonicalization (#2341, #2343) — signing-profile consistency.

- 8be601f: Clarify request-signing checklist step 9a — per-keyid cap before crypto (#2339, #2342). Defense against DoS via unbounded signature verification.

- 251beea: Training agent: enforce idempotency replay/conflict/expired semantics (#2346, #2367).

- 73958aa: Drop non-spec `escalated` status from `check_governance` in training agent (#2354).

- 83b623d: Training agent + storyboard fixes: comply session persistence, `sync_plans` field drift (#2266, #2274, #2345).

- 45650e1: Register brand-protocol tools under `tasks.*` in schema index (#2245, #2358).

- 0b6f271: Declare `auth.api_key` and `auth.probe_task` on fictional test kits (#2317, #2360).

- 6fe61b8: Wire 3.0 scenarios into `sales-*` specialisms (#2228, #2344).

- 9c19239: Correct stale `Content-Digest` in request-signing test vector `positive/002` (#2337).

- 9e38124: Capability-driven storyboard selection; retire `platform_type` in favor of declared capabilities (#2277, #2282).

- 298fa5a: Add a `submitted` branch to `create_media_buy` and `ai_generated_image` right-use pattern (#2425). Clarifies the `submitted` state on async media-buy creation (the seller has accepted the payload for processing but has not yet confirmed the order) and specifies the right-use pattern for AI-generated images.

- 28a6991: Time semantics + `activate_signal` idempotency row (#2407). Tightens the spec-completeness story — unifies time-field semantics across the protocol and adds `activate_signal` to the required idempotency table.

- 46c19d9: Known-limitations, privacy-considerations, and why-not FAQs (#2427). Three new reference pages plus a platform-agnostic lint that prevents vendor-specific language from creeping into the spec.

- 5b52bf8: Tighten three audited claims (#2385, #2404). Scope-truthfulness pass on specific protocol claims surfaced during spec review.

- 08210ff: Add `webhook_mode_mismatch` and `webhook_target_uri_malformed` reason codes to the webhook verifier checklist (#2467).

- fa3835c: Fix webhook test vectors 004/005 to apply full `@target-uri` canonicalization (#2470).

- af67104: Inline the `@authority` Host-header rule at step 10 of the request-signing verification checklist (#2471). Closes an ambiguity about which header value binds signature verification.

- 3f07492: C2PA foundation for signing AAO-generated imagery (#2370 stage 1, #2453). Groundwork for verifying the provenance of AdCP-generated creative assets.

- c360ed5: Stop characterizing unsalted `hashed_email` as privacy-preserving (#2454, #2469). Updates privacy-considerations language to match what hashing actually provides.

- 30f8344: Add `REQUOTE_REQUIRED` error for envelope-breach on `update_media_buy` (#2456, #2472). Scoped to 3.1 — seller returns this when an update would require re-pricing rather than a silent amend.

- 5111aac: Known-limitations entry: "No key-transparency anchoring in the registry" (#2458). Documents the CT-log gap for signing-key publication.

- 6710bb5: `push-notification-config` schema note — `idempotency_key` lives in the webhook payload, not in the config (#2457).

- 7567e27: Compliance fix — webhook-emission capability-discovery check (#2468).

- cc99243: Compliance lint — positive `schema_ref` on mutating storyboard steps (#2451).

- 4b7e314: Security example updated to use `Set.has()` instead of `Array.includes()` in the auth-precheck path (performance + correctness).

---

## 3.0.0-rc.3

### Major Changes

- 8f06eed: Remove `sampling` parameter from `get_media_buy_artifacts` request — sampling is configured at media buy creation time, not at retrieval time. Replace `sampling_info` with `collection_info` in the response. Add `failures_only` boolean filter for retrieving only locally-failed artifacts. Add `content_standards` to `get_adcp_capabilities` for pre-buy visibility into local evaluation and artifact delivery capabilities. Add podcast, CTV, and AI-generated content artifact examples to documentation.
- 63a33b4: Rename show/episode to collection/installment for cross-channel clarity. Add installment deadlines, deadline policies, and print-capable creative formats.

  Breaking: show→collection, episode→installment across all schemas, enums, and field names (show_id→collection_id, episode_id→installment_id, etc.). Collections gain kind field (series, publication, event_series, rotation) and deadline_policy for lead-time rules. Installments gain optional booking, cancellation, and staged material submission deadlines. Image asset requirements gain physical units (inches/cm/mm), DPI, bleed (uniform or per-side via oneOf), color space, and print file formats (TIFF, PDF, EPS). Format render dimensions support physical units and decimal aspect ratios.

- Simplify governance protocol for 3.0:

  1. Remove `binding` field from `check_governance` request — governance agents infer check type from discriminating fields: `tool`+`payload` (intent check, orchestrator) vs `media_buy_id`+`planned_delivery` (execution check, seller). Adds `AMBIGUOUS_CHECK_TYPE` error for requests containing both field sets.
  2. Remove `mode` (audit/advisory/enforce) from `sync_plans` — mode is governance agent configuration, not a protocol field.
  3. Remove `escalated` as a `check_governance` status — human review is handled via standard async task lifecycle. Three terminal statuses remain: `approved`, `denied`, `conditions`.
  4. Simplify `get_plan_audit_logs` response schema.

- ad33379: Remove FormatCategory enum and `type` field from Format objects

  The `format-category.json` enum, `type` field on Format, `format_types` filter on product-filters and creative-filters, and `type` filter on list-creative-formats-request have been removed.

  **What to use instead:**

  - To understand what a format requires: inspect the `assets` array
  - To filter formats by content type: use the `asset_types` filter on `list_creative_formats`
  - To filter products by channel: use the `channels` filter on `get_products`
  - To filter by specific formats: use `format_ids`

  **Breaking changes:**

  - `format-category.json` enum deleted
  - `type` property removed from `format.json`
  - `format_types` removed from `product-filters.json` and `creative-filters.json`
  - `type` filter removed from `list-creative-formats-request.json`

- 5ecc29d: Remove buyer_ref, buyer_campaign_ref, and campaign_ref. Seller-assigned media_buy_id and package_id are canonical. Add idempotency_key to all mutating requests. Replace structured governance-context.json with opaque governance_context string in protocol envelope and check_governance.

### Minor Changes

- d238645: Expand `adagents.json` to support richer publisher authorization and placement governance.

  This adds scoped authorization fields for property-side `authorized_agents`, including:

  - `delegation_type`
  - `collections`
  - `placement_ids`
  - `placement_tags`
  - `countries`
  - `effective_from`
  - `effective_until`
  - `exclusive`
  - `signing_keys`

  It also adds publisher-level placement governance with:

  - top-level `placements`
  - top-level `placement_tags`
  - canonical `placement-definition.json`

  Validation and tooling are updated to enforce placement-to-property linkage, placement tag scoping, country and time-window constraints, and authoritative-location resolution. Related docs are updated to explain the stronger publisher authorization model and compare `adagents.json` with `ads.txt`.

- c5b3143: Add advertiser industry taxonomy. New `advertiser-industry` enum with two-level dot-notation categories (e.g., `media_entertainment.podcasts`, `technology.software`). The brand manifest `industries` field now references the enum, and `CreateMediaBuyRequest` gains an optional `advertiser_industry` field so agents can classify the advertiser when creating campaigns. Sellers map these to platform-native codes (Spotify ADV categories, LinkedIn industry IDs, IAB Content Taxonomy). Includes restricted categories (gambling_betting, cannabis, dating) that platforms require explicit declaration for.
- 257463e: Add structured audience data for bias/fairness governance validation.

  **Schemas**: audience-selector (signal ref or description), audience-constraints (include/exclude), policy-category-definition (regulatory regime groupings), attribute-definition (restricted data categories), match-id-type (identity resolution enum), restricted-attribute (GDPR Article 9 enum).

  **Plan fields**: policy_categories, audience constraints (include/exclude), restricted_attributes, restricted_attributes_custom, min_audience_size. Separates brand.industries (what the company is) from plan.policy_categories (what regulatory regimes apply).

  **Governance**: audience_targeting on governance-context and planned-delivery for three-way comparison. audience_distribution on delivery_metrics for demographic drift detection. restricted_attributes and policy_categories on signal-definition.json for structural governance matching.

  **Registry**: 10 policy category definitions (children_directed, political_advertising, age_restricted, gambling_advertising, fair_housing, fair_lending, fair_employment, pharmaceutical_advertising, health_wellness, firearms_weapons). 8 restricted attribute definitions (GDPR Article 9 categories). 13 seed policies covering US (FHA, ECOA, EEOC, COPPA, FDA DTC, FTC health claims, TTB alcohol, state gambling), EU (DSA political targeting, prescription DTC ban, GDPR special category targeting), and platform (special ad categories, firearms) regulations.

  **Media buy**: per-identifier-type match_breakdown and effective_match_rate on sync_audiences response (#1314).

  **Docs**: Updated governance specification, sync_plans, check_governance, policy registry, sync_audiences, brand protocol, and signal/data provider documentation.

  **Breaking changes** (pre-1.0 RC — expected):

  - `brand.industry` (string) renamed to `brand.industries` (string array). See migration guide.
  - `policy-entry.verticals` renamed to `policy-entry.policy_categories`.

  **Design notes**:

  - `policy_categories` on plans is intentionally freeform `string[]` (not an enum). Unlike GDPR Article 9 restricted attributes (a closed legal text), policy categories are open-ended — new jurisdictions and regulatory regimes add categories over time. Validation is at the registry level, not the schema level.
  - `audience-selector.json` uses flat `oneOf` with four inline variants (signal-binary, signal-categorical, signal-numeric, description) rather than `allOf` composition with `signal-targeting.json`. This avoids codegen fragility — `allOf` with `$ref` breaks quicktype, go-jsonschema, and similar tools.

- c17b119: Support availability forecasts for guaranteed and direct-sold inventory

  - Make `budget` optional on `ForecastPoint` — when omitted, the point represents total available inventory for the requested targeting and dates
  - Add `availability` value to `forecast-range-unit` enum for forecasts where metrics express what exists, not what a given spend level buys
  - Guaranteed products now include availability forecasts with `metrics.spend` expressing estimated cost
  - Update delivery forecast documentation with availability forecast examples and buyer-side underdelivery calculation guidance

- 9ae4fdc: Add comply_test_controller tool to training agent for deterministic compliance testing. Fix SISessionStatus description in si-initiate-session-response schema.
- 28ba53a: Add weight_grams on image asset requirements for print inserts, and material_submission on products for print creative delivery instructions. Retry transient network failures in owned-link checker. Driven by DBCFM gap analysis.
- 949c534: Event source health and measurement readiness for conversion tracking quality.

  - **Event source health**: Optional `health` object on each event source in `sync_event_sources` response. Includes status (insufficient/minimum/good/excellent), seller-defined detail, match rate, evaluated_at timestamp, 24h event volume, and actionable issues. Analogous to Snap EQS / Meta EMQ — sellers without native scores derive status from operational metrics.
  - **Measurement readiness**: Optional `measurement_readiness` on products in `get_products` response. Evaluates whether the buyer's event setup is sufficient for the product's optimization capabilities. Includes status, required/missing event types, and issues.
  - New schemas: `event-source-health.json`, `measurement-readiness.json`, `diagnostic-issue.json`, `assessment-status.json` enum

- 0fb4210: Add `sync_governance` task for syncing governance agent endpoints to accounts. Supports both explicit accounts (account_id) and implicit accounts (brand + operator) via account references. Governance agents removed from `sync_accounts` and `list_accounts`.
- 5c41b60: Add order lifecycle management to the Media Buy Protocol.

  - `confirmed_at` timestamp on create_media_buy response (required) — a successful response constitutes order confirmation
  - Cancellation via update_media_buy with `canceled: true` and optional `cancellation_reason` at both media buy and package level
  - `canceled_by` field (buyer/seller) on media buys and packages to identify who initiated cancellation
  - `canceled_at` timestamp on packages (parity with media buy level)
  - Per-package `creative_deadline` for mixed-channel orders where packages have different material deadlines (e.g., print vs digital)
  - `valid_actions` on get_media_buys response — seller declares what actions are permitted in the current state so agents don't need to internalize the state machine
  - `get_media_buys` MCP tool added to Addie for reading media buy state, creative approvals, and delivery snapshots
  - `revision` number on media buys for optimistic concurrency — callers pass in update requests, sellers reject on mismatch
  - `include_history` on get_media_buys request — opt-in revision history per media buy with actor, action, summary, and package attribution
  - `status` field on update_media_buy response to confirm state transitions
  - Formal state transition diagram and normative rules in specification
  - Valid actions mapping table in specification and get_media_buys docs
  - Curriculum updates: S1 (lifecycle lab), C1 (get_media_buys + lifecycle concepts), A2 (confirmed_at + status check step)
  - `new_packages` on update_media_buy request for adding packages mid-flight. Sellers advertise `add_packages` in `valid_actions`.
  - `CREATIVE_DEADLINE_EXCEEDED` error code — separates deadline violations from content policy rejections (`CREATIVE_REJECTED`)
  - Frozen snapshots: sellers MUST retain delivery data for canceled packages and SHOULD return final snapshot at cancellation time
  - 7 error codes added to enum: INVALID_STATE, NOT_CANCELLABLE, MEDIA_BUY_NOT_FOUND, PACKAGE_NOT_FOUND, VALIDATION_ERROR, BUDGET_EXCEEDED, CREATIVE_DEADLINE_EXCEEDED

- f132f84: Add structured business entity data to accounts and media buys for B2B invoicing. New `billing_entity` field on accounts provides default invoicing details (legal name, VAT ID, tax ID, address, contacts with roles, bank). New `invoice_recipient` on media buys enables per-buy billing overrides. Add `billing: "advertiser"` option for when operator places orders but advertiser pays directly. Bank details are write-only (never echoed in responses).
- 37d97f4: Add proposal lifecycle with draft/committed status, finalization via refine action, insertion order signing, and expiry enforcement on create_media_buy. Proposals containing guaranteed products now start as draft (indicative pricing) and must be finalized before purchase. Committed proposals include hold windows and optional insertion orders for formal agreements.
- 5a1710b: Remove `oneOf` from `get-products-request.json` and `build-creative-request.json` to fix code generation issues across TypeScript, Python, and Go. Conditional field validity is documented in field descriptions and validated in application logic.

  Fix webhook HMAC verification contradictions between `security.mdx` and `webhooks.mdx`. `security.mdx` now references `webhooks.mdx` as the normative source and adds guidance on verification order, secret rotation, and SSRF prevention. Three adversarial test vectors added.

  Localize `tagline` in `brand.json` and `get-brand-identity-response.json` — accepts a plain string (backwards compatible) or a localized array keyed by BCP 47 locale codes. Update `localized_name` definition to reference BCP 47 codes. Examples updated to use region-specific locale codes.

- f28c77b: Add `special` and `limited_series` fields to shows and episodes. Specials anchor content to real-world events (championships, awards, elections) with name, category, and date window. Limited series declare bounded content runs with total episode count and end date. Both are composable — a show can be both. Also adds `commentator` and `analyst` to the talent role enum, and fixes pre-existing training agent bugs (content_rating mapped as array, duration as ISO string instead of integer, invalid enum values).
- fe0f8a0: Add native streaming/audio metrics to delivery schema.

  - Broadens `views` description to cover audio/podcast stream starts
  - Renames `video_completions` to `completed_views` in aggregated_totals
  - Adds `views`, `completion_rate`, `reach`, `reach_unit`, `frequency` to aggregated_totals
  - Adds `reach_unit` field to `delivery-metrics.json` referencing existing `reach-unit.json` enum with `dependencies` co-occurrence constraint (reach requires reach_unit)
  - Aggregated reach/frequency omitted when media buys have heterogeneous reach units
  - Updates `frequency` description from "per individual" to "per reach unit"
  - Training agent: channel-specific completion rates (podcast 87%, streaming audio 72%, CTV 82%), `views` at package level, audio/video metrics rolled up into totals, `reach_unit` emission (accounts for streaming, devices for CTV/OLV)

- bf1773b: feat: deprecate AXE fields, add TMP provider discovery, property_rid, typed artifacts, lightweight context match

  Marks `axe_include_segment`, `axe_exclude_segment`, and `required_axe_integrations` as deprecated in favor of TMP. Adds `trusted_match` filter to product-filters for filtering by TMP provider + match type. Adds `providers` array to the product `trusted_match` object so publishers can declare which TMP providers are integrated per product. Adds `trusted_match` to the `fields` enum on get-products-request. Removes `available_packages` from context match requests — providers use synced package metadata instead of receiving it per-request. Optional `package_ids` narrows the set when needed. Adds `property_rid` (UUID v7 from property catalog) as the primary identifier on context match requests, with `property_id` optional for logging. Replaces plain-string artifacts with typed objects (`url`, `url_hash`, `eidr`, `gracenote`, `rss_guid`, `isbn`, `custom`) so buyers can resolve content via public registries. Removes top-level `url_hash` field (now an artifact type).

- dcbb3c8: feat: Trusted Match Protocol (TMP) — real-time execution layer for AdCP

  Adds 9 TMP schemas, 12 documentation pages, and updates across the protocol to support real-time package activation with structural privacy separation. Deprecates AXE.

### Patch Changes

- 4d7eb0a: Update documentation for audience targeting
- b046963: Fix 7 issues: get_signals docs, members CSS, training agent types, outreach SQL, brand localization, webhook HMAC spec, schema oneOf removal
- a95f809: fix: escape dollar signs in docs to prevent LaTeX math rendering
- 446a625: Add request and response schema links to preview_creative task reference, matching the pattern used by other creative task references.
- a4aff56: fix: include editorial working group perspectives in public API

## 3.0.0-rc.2

### Major Changes

- 06363b9: Remove `account_resolution` capability field. `require_operator_auth` now determines both the auth model and account reference style: `true` means explicit accounts (discover via `list_accounts`, pass `account_id`), `false` means implicit accounts (declare via `sync_accounts`, pass natural key).

### Minor Changes

- fe079dc: Add `ai_media` channel to media channel taxonomy for AI platform advertising (AI assistants, AI search, generative AI experiences). New industry guide for AI media sales agents. Strengthen accounts and sandbox guidance for production sales agents.
- fc14940: Add brand protocol rights lifecycle: get_rights, acquire_rights, update_rights with generation credentials, creative approval, revocation notifications, and usage reporting. Includes rights-terms shared schema, authenticated webhooks (HMAC-SHA256), actionable vs final rejection convention, DDEX PIE mapping for music licensing, and sandbox tooling for scenario testing.
- a326b30: Add visual_guidelines to brand.json schema: photography, graphic style, shapes, iconography, composition, motion, logo placement, colorways, type scale, asset libraries, and restrictions. These structured visual rules enable generative creative systems to produce on-brand assets consistently.
- 44a8be9: Add optional inline preview to build_creative. Request can set `include_preview: true` to get preview renders in the response alongside the manifest. The preview structure matches preview_creative's single response, so clients parse previews identically regardless of source. For single-format requests, `preview_inputs` controls variant generation. For multi-format requests, one default preview per format is returned with explicit `format_id` on each entry. `preview_error` uses the standard error structure (`code`, `message`, `recovery`) for agent-friendly failure handling. Agents that don't support inline preview simply omit the field.
- d6518dc: Add quality parameter to preview_creative for controlling render fidelity (draft vs production). Clarify that creative agents and sales agents are not mutually exclusive. A sales agent can implement the Creative Protocol alongside Media Buy Protocol. Updated documentation, certification curriculum, and training agent.
- 689adb4: Add generation controls to build_creative and preview_creative: quality tier (draft/production), item_limit for catalog cost control, expires_at on build_creative response for generated asset URL expiration, and storyboard reference asset role.
- f460ece: Move list_creatives and sync_creatives from media-buy to creative protocol. All creative library operations now live in one protocol — any agent hosting a creative library implements the creative protocol for both reads and writes. Extend build_creative with library retrieval mode (creative_id, macro_values, media_buy_id, package_id). Add creative agent interaction models (supports_generation, supports_transformation, has_creative_library) to get_adcp_capabilities. New creative-variable.json schema for DCO variable definitions. Redesign list_creatives as a library catalog: replace include_performance/performance_score with include_snapshot (lightweight delivery snapshot following get_media_buys pattern), rename has_performance_data filter to has_served, add errors to response. Rename sub-asset.json to item.json and sub_assets to items throughout — neutral naming that works for both native (flat components) and carousel (repeated groups) patterns.
- fee669b: Add disclosure persistence model for jurisdiction-specific render requirements.

  New `disclosure-persistence` enum with values: `continuous` (must persist throughout content duration), `initial` (must appear at start for minimum duration), `flexible` (presence sufficient, publisher discretion). When multiple sources specify persistence for the same jurisdiction, most restrictive wins: `continuous > initial > flexible`.

  Schema changes:

  - `provenance.json`: new `declared_at` (date-time) recording when the provenance claim was made, distinct from `created_time`. Jurisdiction items in `disclosure.jurisdictions[]` gain `render_guidance` with `persistence`, `min_duration_ms`, and `positions` (ordered preference list).
  - `format.json`: new `disclosure_capabilities` array — each entry pairs a disclosure position with its supported persistence modes. Supersedes `supported_disclosure_positions` for persistence-aware matching; the flat field is retained for backward compatibility. Formats should only claim persistence modes they can enforce.
  - `creative-brief.json`: new optional `persistence` on `compliance.required_disclosures[]` items.
  - `list-creative-formats-request.json` (media-buy and creative domains): new `disclosure_persistence` filter. Creative-domain request also gains `disclosure_positions` filter for parity with media-buy.
  - `error-code.json`: `COMPLIANCE_UNSATISFIED` description updated to cover persistence mode mismatches.

- fe61385: Add exclusivity enum and preferred_delivery_types to product discovery

  - New `exclusivity` enum (none, category, exclusive) on products and as a filter
  - New `preferred_delivery_types` soft preference array on get_products requests
  - Documentation for publisher product design patterns, content sponsorship, and delivery preferences

- 0c98c26: Discriminate flat_rate pricing parameters by inventory type and clarify package type names.

  **Breaking for existing v3 DOOH flat_rate parameters:** `flat-rate-option.json` `parameters` now requires a `"type": "dooh"` discriminator field. Existing implementations passing `parameters` without `type` must add `"type": "dooh"`. Sponsorship/takeover flat_rate options that have no `parameters` are unaffected.

  DOOH `parameters` fields: `sov_percentage`, `loop_duration_seconds`, `min_plays_per_hour`, `venue_package`, `duration_hours`, `daypart`, `estimated_impressions`. `min_plays_per_hour` minimum is now 1 (was 0).

  `get-media-buys-response.json` inline package items are now titled `PackageStatus` to distinguish them from `PackageRequest` (create input) and `Package` (create output). The name reflects what this type adds: creative approval state and an optional delivery snapshot.

- c3a0883: Add optional `start_time` and `end_time` to package schemas and product allocations for per-package flight scheduling.

  - `core/package.json`, `media-buy/package-request.json`, `media-buy/package-update.json`: buyers can set independent flight windows per package within a media buy.
  - `core/product-allocation.json`: publishers can propose per-flight scheduling in proposals.

- ff30c6a: Add governance_context to check-governance-request for canonical budget/geo/channel/flight extraction. Add mode to sync-plans plan items. Add committed_budget and typed package budget to report-plan-outcome. Add categories_evaluated and policies_evaluated to check-governance-response.
- 6a9faa4: build_creative: support multi-format output via target_format_ids

  Add `target_format_ids` array as an alternative to `target_format_id` on build_creative requests. When provided, the creative agent produces one manifest per requested format and returns them in a `creative_manifests` array. This lets buyers request multiple format variants (e.g., 300x250 + 728x90 + 320x50) in a single call instead of making N sequential requests.

  Closes #1395

- c4f8f58: Make `delivery_measurement` optional in the product schema. Publishers without integrated measurement tools can now omit this field rather than providing vague values.
- 9c2a978: Campaign Governance and Policy Registry. Adds governance modes (audit/advisory/enforce), delegations for multi-agency authorization, portfolio governance for holding companies, finding confidence scores, drift detection metrics with thresholds, escalation approval tiers, seller-side governance checks, and a safety model page. Includes unified check_governance with binding discriminator, 14 seeded policies, multi-agent governance composition, and enforced_policies on planned delivery.
- 5a54824: Move sandbox capability from `media_buy.features.sandbox` to `account.sandbox` in `get_adcp_capabilities`. Sandbox is account-level, not a media-buy protocol feature — sellers declare it alongside other account capabilities like `supported_billing` and `account_financials`.
- 421cb69: Add sandbox to account-ref natural key. Implicit-account operators can reference sandbox accounts via `{ brand, operator, sandbox: true }` without provisioning or discovering an account_id. Explicit-account operators discover pre-existing sandbox test accounts via `list_accounts`. The sandbox field participates in the natural key but its usage follows the same implicit/explicit account model rules as non-sandbox accounts.
- fe61385: Add shows and episodes as a content dimension for products. Shows represent persistent content programs (podcasts, TV series, YouTube channels) that produce episodes over time. Products reference shows via `show_ids` array, and `get_products` responses include a top-level `shows` array. Includes distribution identifiers for cross-seller matching, episode lifecycle states (scheduled, tentative, live, postponed, cancelled, aired, published), break-based ad inventory configuration, talent linking to brand.json, show declarations in adagents.json, show relationships (spinoff, companion, sequel, prequel, crossover), derivative content (clips, highlights, recaps), production quality tiers, season tracking, and international content rating systems (BBFC, FSK).
- d6866dc: Add payment_terms to sync_accounts request and formalize enum across schemas
- 30c3ad8: Add `time_budget` to `get_products` request and `incomplete` to response.

  - `time_budget` (Duration): buyers declare how long they will commit to a request. Sellers return best-effort results within the budget and do not start processes (human approvals, expensive external queries) that cannot complete in time.
  - `incomplete` (array): sellers declare what they could not finish — each entry has a `scope` (`products`, `pricing`, `forecast`, `proposals`), a human-readable `description`, and an optional `estimated_wait` duration so the buyer can decide whether to retry.
  - Adds `seconds` to the Duration `unit` enum.

### Patch Changes

- 12a30f5: Add HMAC-SHA256 test vectors for cross-language webhook signature verification
- dfc8203: Update sync_audiences spec with clarifications
- 018ab61: Clarify sandbox account protocol by account model. Explicit accounts (`require_operator_auth: true`) discover pre-existing sandbox test accounts via `list_accounts`. Implicit accounts declare sandbox via `sync_accounts` with `sandbox: true` and reference by natural key.
- 9c1fc25: Update HMAC-SHA256 webhook spec to match the @adcp/client reference implementation: add X-ADCP-Timestamp header, sha256= signature prefix, timestamp-based replay protection, raw body verification guidance, and publisher signing example.

## 3.0.0-rc.1

### Major Changes

- 892da1d: Delete brand-manifest.json. The brand object in brand.json is now the single
  canonical brand definition. Task schemas reference brands by domain + brand_id
  instead of passing inline manifests. Brand data is always resolved from
  brand.json or the registry.
- 5b8feea: **BREAKING**: Rename `catalog` to `catalogs` (array) on creative manifest. Formats can declare multiple catalog_requirements (e.g., product + inventory + store); the manifest now supports multiple catalogs to match. Each catalog's `type` maps to the corresponding catalog_requirements entry.
- 7cf7476: Remove `estimated_exposures` from Product, replace with optional `forecast`

  - Remove the unitless `estimated_exposures` integer field from the Product schema
  - Add optional `forecast` field using the existing `DeliveryForecast` type, giving buyers structured delivery estimates with time periods, metric ranges, and methodology context during product discovery

- 811bd0e: Redesign `refine` as a typed change-request array with seller acknowledgment

  The `refine` field is now an array of change requests, each with a `scope` discriminator (`request`, `product`, or `proposal`) and an `ask` field describing what the buyer wants. The seller responds via `refinement_applied` — a positionally-matched array reporting whether each ask was `applied`, `partial`, or `unable`. This replaces the previous object structure with separate `overall`, `products`, and `proposals` fields.

- 544230b: Address schema gaps that block autonomous agent operation, plus consistency fixes.

  **Error handling (#1223)**

  - `Error`: add `recovery` field (`transient | correctable | terminal`) so agents can classify failures without escalating every error to humans
  - New `enums/error-code.json`: standard vocabulary (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `PRODUCT_UNAVAILABLE`, `PROPOSAL_EXPIRED`, `BUDGET_TOO_LOW`, `CREATIVE_REJECTED`, `UNSUPPORTED_FEATURE`, `AUDIENCE_TOO_SMALL`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SUSPENDED`)

  **Idempotency (#1224)**

  - `UpdateMediaBuyRequest`, `SyncCreativesRequest`: add `idempotency_key` for safe retries after timeouts
  - `CreateMediaBuyRequest.buyer_ref`: document deduplication semantics (buyer_ref is the idempotency key for create)

  **Media buy lifecycle (#1225)**

  - `MediaBuyStatus`: add `rejected` enum value for post-creation seller declines
  - `MediaBuy`: add `rejection_reason` field present when `status === rejected`

  **Protocol version (#1226)**

  - `GetAdCPCapabilitiesResponse.adcp.major_versions`: document version negotiation via capabilities handshake; HTTP header is optional

  **Async polling (#1227)**

  - `GetAdCPCapabilitiesResponse.adcp`: add `polling` object (`supported`, `recommended_interval_seconds`, `max_wait_seconds`) for agents without persistent webhook endpoints

  **Package response (#1229)**

  - `Package`: add `catalogs` (array) and `format_ids` fields echoed from the create request so agents can verify what the seller stored

  **Signal deactivation (#1231)**

  - `ActivateSignalRequest`: add `action: activate | deactivate` field with `activate` default; deactivation removes segments from downstream platforms to support GDPR/CCPA compliance

  **Signal metadata (#1232)**

  - `GetSignalsResponse` signal entries: add `categories` (for `categorical` signals) and `range` (for `numeric` signals) so buyers can construct valid targeting values

  **Property list filters (#1233)**

  - `PropertyListFilters`: make `countries_all` and `channels_any` optional; omitting means no restriction (enables global lists and all-channel lists)

  **Content standards response (#1234)**

  - `UpdateContentStandardsResponse`: replace flat object with `UpdateContentStandardsSuccess | UpdateContentStandardsError` discriminated union (`success: true/false`) consistent with all other write operations

  **Product refinement (#1235)**

  - `GetProductsRequest`: add `buying_mode: "refine"` with `refine` array of typed change requests — each entry declares a `scope` (`request`, `product`, or `proposal`) with an `ask` field. `GetProductsResponse`: add `refinement_applied` array where the seller acknowledges each ask by position (`applied`, `partial`, or `unable`)

  **Creative assignments (#1237)**

  - `SyncCreativesRequest.assignments`: replace ambiguous `{ creative_id: package_id[] }` map with typed array `{ creative_id, package_id, weight?, placement_ids? }[]`

  **Batch preview (#1238)**

  - `PreviewBatchResultSuccess`: add required `success: true`, `creative_id`, proper `response` object with `previews` and `expires_at`
  - `PreviewBatchResultError`: add required `success: false`, `creative_id`, `errors: Error[]` (referencing standard Error schema)

  **Creative delivery pagination (#1239)**

  - `GetCreativeDeliveryRequest.pagination`: replace ad-hoc `limit/offset` with standard `PaginationRequest` cursor-based pagination

  **Signals account consistency (#1242)**

  - `GetSignalsRequest`, `ActivateSignalRequest`: replace `account_id: string` with `account: $ref account-ref.json` for consistency with all other endpoints

  **Signals field naming (#1244)**

  - `ActivateSignalRequest`: rename `deployments` to `destinations` for consistency with `GetSignalsRequest`

  **Creative features billing (#1245)**

  - `GetCreativeFeaturesRequest`: add optional `account` field for governance agents that charge per evaluation

  **Consent basis enum (#1246)**

  - New `enums/consent-basis.json`: extract inline GDPR consent basis enum to shared schema

  **Date range extraction (#1247)**

  - New `core/date-range.json` and `core/datetime-range.json`: extract duplicated inline period objects from financials, usage, and feedback schemas

  **Creative features clarity (#1248)**

  - `GetCreativeFeaturesRequest`/`Response`: clarify description to make evaluation semantics explicit

  **Remove non-standard keyword (#1250)**

  - `SyncAudiencesRequest`: remove ajv-specific `errorMessage` keyword that violates JSON Schema draft-07

  **Package catalogs**

  - `Package`, `PackageRequest`: change `catalog` (single) to `catalogs` (array) to support multi-catalog packages (e.g., product + store catalogs)

  **Error code vocabulary expansion (#1269–1276)**

  - `ErrorCode`: add `BUDGET_EXHAUSTED` (account/campaign budget spent, distinct from `BUDGET_TOO_LOW`) and `CONFLICT` (concurrent modification)
  - `Error.code`: stays `type: string` (not wired to enum) so sellers can use platform-specific codes; description references error-code.json as the standard vocabulary

  **Frequency cap semantics (#1272)**

  - `FrequencyCap`: add normative AND semantics — when both `suppress` and `max_impressions` are set, an impression is delivered only if both constraints permit it

  **Catalog uniqueness (#1276)**

  - `Package`, `PackageRequest`: strengthen catalog type uniqueness from SHOULD to MUST; sellers MUST reject duplicates with `validation_error`

  **Creative weight semantics**

  - `CreativeAssignment`, `SyncCreativesRequest.assignments`: clarify weight is relative proportional (weight 2 = 2x weight 1), omitted = equal rotation, 0 = assigned but paused

  **Outcome measurement window (breaking)**

  - `OutcomeMeasurement.window`: change from `type: string` (e.g., `"30_days"`) to `$ref: duration.json` (structured `{interval, unit}`)

  **Media buy lifecycle**

  - `MediaBuyStatus`: add `canceled` (buyer-initiated termination, distinct from `completed` and `rejected`)
  - `GetMediaBuyDeliveryResponse`: add `canceled` to inline status enum

- 4c33b99: Add required `buying_mode` discriminator to `get_products` request for explicit wholesale vs curated buying intent.

  Buyers with their own audience stacks (DMPs, CDPs, AXE integrations) can now set `buying_mode: "wholesale"` to declare they want raw inventory without publisher curation. Buyers using curated discovery set `buying_mode: "brief"` and include `brief`. This removes ambiguity from legacy requests that omitted `buying_mode`.

  When `buying_mode` is `"wholesale"`:

  - Publisher returns products supporting buyer-directed targeting
  - No AI curation or personalization is applied
  - No proposals are returned
  - `brief` must not be provided (mutually exclusive)

### Minor Changes

- f6336af: Serve AgenticAdvertising.org brand.json from hosted_brands database so it can be managed via Addie tools. Seed initial brand data including structured tone format with voice and attributes.
- a9e118d: Introduce Accounts Protocol documentation as a named cross-protocol section covering commercial infrastructure: `sync_accounts`, `list_accounts`, and `report_usage`. Includes Accounts Protocol overview connecting brand registry, account establishment, and settlement into a transaction lifecycle. Moves account management tasks from Media Buy Protocol to the new Accounts Protocol section.
- 142bcd5: Replace account_id with account reference, restructure account model.

  - Add `account-ref.json`: union type accepting `{ account_id }` or `{ brand, operator }`
  - Use `brand-ref.json` (domain + brand_id) instead of flat house + brand_id in account schemas
  - Make `operator` required everywhere (brand sets operator to its own domain when operating its own seat)
  - Add `account_resolution` capability (string: `explicit_account_id` or `implicit_from_sync`)
  - Simplify billing to `operator` or `agent` only (brand-as-operator when brand pays directly)
  - **Breaking**: `billing` is now required in `sync_accounts` request (previously optional). Existing callers that omit `billing` will receive validation errors. Billing is accept-or-reject — sellers cannot silently remap billing.
  - Make `account` required on create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
  - Make `account` required per record on report_usage
  - `sync_accounts` no longer returns `account_id` — the seller manages account identifiers internally. Buyers discover IDs via `list_accounts` (explicit model) or use natural keys (implicit model).
  - Make `account_id` required in `account.json` (remove conditional if/then — the schema is only used in seller responses where the seller always has an ID)
  - Add `account_scope` to account and sync_accounts response schemas
  - Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes
  - Add `get_account_financials` task for operator-billed account financial status

- ff62171: Add `app` catalog type for mobile app install and re-engagement advertising.

  Introduces `AppItem` schema with fields for `bundle_id`, `apple_id`, `platform` (ios/android), store metadata, and deep links. Maps to Google App Campaigns, Apple Search Ads, Meta App Ads, TikTok App Campaigns, and Snapchat App Install Ads.

  Also adds `app_id` to `content-id-type` for conversion event matching and `APP_ITEM_ID` to universal macros for tracking URL substitution.

- 8ec2ab3: Add `external_id` field to AudienceMember for buyer-assigned stable identifiers (CRM record ID, loyalty ID). Remove `external_id` from uid-type enum — it was not a universal ID and belongs as a dedicated field. Add `external_id` to `supported_identifier_types` in capabilities so sellers can advertise support.
- ce439ca: Brand registry lookup, unified enrichment, and membership inheritance
- c872c94: Brand registry as primary company identity source. Member profiles now link to the brand registry via `primary_brand_domain` instead of storing logos and colors directly. Members set up their brand through the brand tools and get a hosted brand.json at `agenticadvertising.org/brands/yourdomain.com/brand.json`. Placing a one-line pointer at `/.well-known/brand.json` makes AgenticAdvertising.org the authoritative brand source for any domain.
- 1051929: Add optional `campaign_ref` field to `get_products` and `create_media_buy` for grouping related operations under a buyer-defined campaign label. Echoed in media buy responses for CRM and ad server correlation.
- 15a64e6: Refactor `CatalogFieldBinding` schema to use a `kind` discriminator field (`"scalar"`, `"asset_pool"`, `"catalog_group"`) instead of `allOf + oneOf` with negative `not` constraints. Scalar and asset pool variants are extracted to `definitions` for reuse in `per_item_bindings`. Generates a clean TypeScript discriminated union instead of triplicated intersections.
- 5b8feea: Add catalog item macros for item-level attribution: SKU, GTIN, OFFERING_ID, JOB_ID, HOTEL_ID, FLIGHT_ID, VEHICLE_ID, LISTING_ID, STORE_ID, PROGRAM_ID, and DESTINATION_ID (mirroring the content_id_type enum), plus CATALOG_ID for catalog-level attribution and CREATIVE_VARIANT_ID for seller-assigned creative variant tracking. Enables closed-loop attribution from impression tracking through conversion events.
- e2e68d3: Add typed catalog assets, field bindings, and feed field mappings.

  **Typed assets on vertical catalog items**: `hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`, and `app` item schemas now support an `assets` array using `OfferingAssetGroup` structure. Enables buyers to provide typed image pools (`images_landscape`, `images_vertical`, `logo`, etc.) alongside existing scalar fields, so formats can declare which asset group to use for each platform-specific slot rather than relying on a single `image_url`.

  **Field bindings on format catalog requirements**: `catalog_requirements` entries now support `field_bindings` — explicit mappings from format template slots (`asset_id`) to catalog item fields (dot-notation path) or typed asset pools (`asset_group_id`). Supports scalar field binding, asset pool binding, and repeatable group iteration over catalog items. Optional — agents can still infer without bindings.

  **Feed field mappings on catalog**: The `Catalog` object now accepts `feed_field_mappings` for normalizing external feeds during `sync_catalogs` ingestion. Supports field renames, named transforms (`date`, `divide`, `boolean`, `split`) with per-transform parameters, static literal injection, and placement of image URLs into typed asset pools. Eliminates the need to preprocess every non-AdCP feed before syncing.

- cc41e01: Add compliance fields to creative-brief schema. Unify manifest to format_id + assets.

  Add optional `compliance` object to `creative-brief.json` with `required_disclosures` (structured array with text, position, jurisdictions, regulation, min_duration_ms, and language) and `prohibited_claims` (string array). Disclosures support per-jurisdiction requirements via ISO 3166-1/3166-2 codes (country or subdivision). Extract disclosure position to shared `disclosure-position.json` enum with values: prominent, footer, audio, subtitle, overlay, end_card, pre_roll, companion. Creative agents that cannot satisfy a required disclosure MUST fail the request.

  Move `creative_brief` and `catalogs` from top-level manifest fields to proper asset types (`brief` and `catalog`) within the `assets` map. Add `"brief"` and `"catalog"` to the asset-content-type enum. Create `brief-asset.json` and `catalog-asset.json` schemas. Move format-level `catalog_requirements` into the catalog asset's `requirements` field within the format's `assets` array. Add `max_items` to `catalog-requirements.json`. The manifest is now `format_id` + `assets`.

  Add `supported_disclosure_positions` to `format.json` so formats declare which disclosure positions they can render.

  Remove `creative_brief` from `build-creative-request.json` and delete `creative-brief-ref.json`. Remove `supports_brief` capability flag.

  Note: `creative_brief` on manifests, `catalog_requirements` on formats, `creative-brief-ref.json`, and `supports_brief` were added during this beta cycle and never released, so these structural changes are not breaking.

- 5622c51: Add build capability discovery to creative formats.

  `format.json` gains `input_format_ids` — the source creative formats a format accepts as input manifests (alongside the existing `output_format_ids` for what can be produced).

  `list_creative_formats` gains two new filter parameters:

  - `output_format_ids` — filter to formats that can produce any of the specified outputs
  - `input_format_ids` — filter to formats that accept any of the specified formats as input

  Together these let agents ask a creative agent "what can you build?" and query in either direction: "given outputs I need, what inputs do you accept?" or "given inputs I have, what outputs can you produce?"

- 7b1d51e: Add `get_creative_features` task for creative governance

  Introduces the creative analog of `get_property_features` — a general-purpose task for evaluating creatives and returning feature values. Supports security scanning, creative quality assessment, content categorization, and any other creative evaluation through the same feature-based pattern used by property governance.

  New schemas:

  - `get-creative-features-request.json` — accepts a creative manifest and optional feature_ids filter
  - `get-creative-features-response.json` — returns feature results with discriminated union (success/error)
  - `creative-feature-result.json` — individual feature evaluation (value, confidence, expires_at, etc.)

  Also adds `creative_features` to the governance section of `get_adcp_capabilities` response, allowing agents to advertise which creative features they can evaluate.

- 9652531: Add dimension breakdowns to delivery reporting and device_type targeting.

  New enums: `device-type.json` (desktop, mobile, tablet, ctv, dooh, unknown), `audience-source.json` (synced, platform, third*party, lookalike, retargeting, unknown), `sort-metric.json` (sortable numeric delivery-metrics fields). New shared schema: `geo-breakdown-support.json` for declaring geographic breakdown capabilities. Add `device_type` and `device_type_exclude` to targeting overlay. Add `reporting_dimensions` request parameter to `get_media_buy_delivery` for opting into geo, device_type, device_platform, audience, and placement breakdowns with configurable sort and limit. Add corresponding `by*\*`arrays with truncation flags to the delivery response under`by_package`. Declare breakdown support in `reporting_capabilities`(product-level). Add`device_type`to seller-level targeting capabilities in`get_adcp_capabilities`.

  Note: the speculative `by_geography` example in docs (never in the schema or spec) has been replaced with the formal `by_geo` structure.

- 5289d34: Add 3-tier event visibility: public, invite-only listed, and invite-only unlisted. Invite-only events support explicit email invite lists and rule-based access (membership required, org allow-list). Adds `interested` as a distinct registration status for non-invited users who express interest.
- ca18472: Flatten `deliver_to` in `get_signals` request into top-level `destinations` and `countries` fields.

  Previously, callers were required to construct a nested `deliver_to` object with `deployments` and `countries` sub-fields, even when querying a platform's own signal agent where the destination is implicit. Both fields are now optional top-level parameters:

  - `destinations`: Filter signals to those activatable on specific agents/platforms. When omitted, returns all signals available on the current agent.
  - `countries`: Geographic filter for signal availability.

- 1590905: Add `geo_proximity` targeting for arbitrary-location proximity targeting. Three methods: travel time isochrones (e.g., "within 2hr drive of Düsseldorf"), simple radius (e.g., "within 30km of Heathrow"), and pre-computed GeoJSON geometry (buyer provides the polygon). Structured capability declaration in `get_adcp_capabilities` allows sellers to declare supported methods and transport modes independently.
- cb5af61: Add `get_media_buys` task for operational campaign monitoring. Returns current media buy status, creative approval state per package, missing format IDs, and optional near-real-time delivery snapshots with `staleness_seconds` to indicate data freshness. Complements `get_media_buy_delivery` which is for authoritative reporting over date ranges.
- daff9a2: Make `account` optional in `get_media_buys` request — when omitted, returns data across all accessible accounts. Add backward-compatibility clause to `get_products`: sellers receiving requests from pre-v3 clients without `buying_mode` should default to `"brief"`.
- 13919b5: Add keyword targeting for search and retail media platforms.

  New fields in `targeting_overlay`:

  - `keyword_targets` — array of `{keyword, match_type, bid_price?}` objects for search/retail media targeting. Per-keyword `bid_price` overrides the package-level bid for that keyword and inherits `max_bid` interpretation from the pricing option. Keywords identified by `(keyword, match_type)` tuple.
  - `negative_keywords` — array of `{keyword, match_type}` objects to exclude matching queries from delivery.

  New fields in `package-update` (incremental operations):

  - `keyword_targets_add` — upsert keyword targets by `(keyword, match_type)` identity; adds new keywords or updates `bid_price` on existing ones
  - `keyword_targets_remove` — remove keyword targets by `(keyword, match_type)` identity
  - `negative_keywords_add` — append negative keywords to a live package without replacing the existing list
  - `negative_keywords_remove` — remove specific negative keyword+match_type pairs from a live package

  New field in delivery reporting (`by_package`):

  - `by_keyword` — keyword-grain breakdown with one row per `(keyword, match_type)` pair and standard delivery metrics

  New capability flags in `get_adcp_capabilities`:

  - `execution.targeting.keyword_targets`
  - `execution.targeting.negative_keywords`

  New reporting capability:

  - `reporting_capabilities.supports_keyword_breakdown`

- c782f66: Note: These changes are breaking relative to earlier betas but no fields removed here were ever in a stable release.

  Add `sync_catalogs` task and unified `Catalog` model. Replace separate `offerings[]` and `product_selectors` fields on `PromotedOfferings` with a typed `Catalog` object that supports inline items, external URL references, and platform-synced catalogs. Expand catalog types beyond offerings and product to include inventory, store, and promotion feeds. Add `sync_catalogs` task with request/response schemas, async response patterns (working, input-required, submitted), per-catalog approval workflow, and item-level review status. Add `catalog_requirements` on `Format` so formats can declare what catalog feeds they need and what fields each must provide. Add `OfferingAssetGroup` schema for structured per-offering creative pools, `OfferingAssetConstraint` for format-level asset requirements, and `geo_targets` on `Offering` for location-specific offerings. Add `account-state` conceptual doc framing Account as the central stateful container in AdCP 3.0. Rename promoted-offerings doc to catalogs to reflect its expanded scope. Add `StoreItem` schema for physical locations within store-type catalogs, with lat/lng coordinates, structured address, operating hours, and tags. Add `Catchment` schema for defining store catchment areas via three methods: isochrone inputs (travel time + transport mode), simple radius, or pre-computed GeoJSON geometry. Add `transport-mode` and `distance-unit` enums. Add industry-vertical catalog types (`hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`) with canonical item schemas for each, drawn from Google Ads, Meta, LinkedIn, and Microsoft platform feed specs. Add shared `Price` schema. Add `linkedin_jobs` feed format. Remove `PromotedOfferings` wrapper — catalogs are now first-class. Creatives reference catalogs via `catalog` field instead of embedding in assets. Remove `promoted_offering` from media-buy and creative-manifest schemas. Add `conversion_events` and `content_id_type` to Catalog for conversion attribution. Rename catalog type `offerings` to `offering` for consistency with other singular type names. Remove `portfolio_ref` from Offering — structured `assets` (OfferingAssetGroup) replaces external portfolio references. Replace `product_selectors` (PromotedProducts) on `get_products` with `catalog` ($ref catalog.json) — one concept, one schema. Delete `promoted-products.json`. Add `catalog_types` to Product so products declare what catalog types they support. Add `matched_ids` and `matched_count` to `catalog_match`, remove `matched_skus`. Add `catalog` field to `package-request` and `package-update` for catalog-driven packages. Add `store_catchments` targeting dimension referencing synced store catalogs. Add `by_catalog_item` delivery breakdown in `get_media_buy_delivery` response for per-item reporting on catalog-driven packages. Update `creative-variant` description to clarify that catalog items rendered as ads are variants.

- 0e96a78: Add capability declarations for metric optimization goals, cross-channel engagement metrics, video view duration control, and value optimization.

  **New metric kinds** (`optimization_goals` with `kind: 'metric'`):

  - `engagements` — direct ad interaction beyond viewing: social reactions/comments/shares, story/unit opens, interactive overlay taps on CTV, companion banner interactions on audio
  - `follows` — new followers, page likes, artist/podcast/channel subscribes
  - `saves` — saves, bookmarks, playlist adds, pins
  - `profile_visits` — visits to the brand's page, artist page, or channel

  **Video view duration control:**

  - `view_duration_seconds` on metric goals — minimum view duration (in seconds) that qualifies as a `completed_views` event (e.g., 2s, 6s, 15s). Sellers declare supported durations in `metric_optimization.supported_view_durations`. Sellers must reject unsupported values.

  **New event goal target kind:**

  - `maximize_value` — maximize total conversion value within budget without a specific ROAS ratio target. Steers spend toward higher-value conversions. Requires `value_field` on event sources.

  **Product schema additions:**

  - `metric_optimization` — declares which metric kinds a product can optimize for (`supported_metrics`), which view durations are available (`supported_view_durations`), and which target kinds are supported (`supported_targets`). Presence indicates support for `kind: 'metric'` goals without any conversion tracking setup.
  - `max_optimization_goals` — maximum number of goals a package can carry. Most social platforms accept only 1.

  **Product schema corrections:**

  - `conversion_tracking.supported_optimization_strategies` renamed to `conversion_tracking.supported_targets` for consistency with `metric_optimization.supported_targets`. Both fields answer the same question: "what can I put in `target.kind`?"
  - Target kind enum values aligned across product capabilities and optimization goal schemas. Product `supported_targets` values (`cost_per`, `threshold_rate`, `per_ad_spend`, `maximize_value`) now exactly match `target.kind` values on optimization goals — agents can do direct string comparison.
  - `conversion_tracking` description clarified to be for `kind: 'event'` goals only.

  **Delivery metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` count fields added to delivery-metrics.json so buyers can see performance against the new metric optimization goals.
  - `completed_views` description updated to acknowledge configurable view duration threshold.

  **Forecastable metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` added to forecastable-metric.json for forecast completeness.

  **Capabilities schema addition:**

  - `media_buy.conversion_tracking.multi_source_event_dedup` — declares whether the seller can deduplicate events across multiple sources. When absent or false, buyers should use a single event source per goal.

  **Optimization goal description clarifications:**

  - `event_sources` references the `multi_source_event_dedup` capability; explains first-source-wins fallback when dedup is unsupported.
  - `value_field` and `value_factor` clarified as seller obligations (not optional hints). The seller must use these for value extraction and aggregation. They are not passed to underlying platform APIs.

- 5b25ccd: Redesign optimization goals with multiple event sources, threshold rates, and attention metrics.

  - `optimization_goal` (singular) → `optimization_goals` (array) on packages
  - `OptimizationGoal` is a discriminated union on `kind`:
    - `kind: "event"` — optimize for advertiser-tracked conversion events via `event_sources` array of source-type pairs. Seller deduplicates by `event_id` across sources. Each entry can specify `value_field` and `value_factor` for value-based targets.
    - `kind: "metric"` — optimize for a seller-native delivery metric with optional `cost_per` or `threshold_rate` target
  - Target kinds: `cost_per` (cost per unit), `threshold_rate` (minimum per-impression value), `per_ad_spend` (return ratio on event values), `maximize_value` (maximize total conversion value)
  - Metric enum: `clicks`, `views`, `completed_views`, `viewed_seconds`, `attention_seconds`, `attention_score`, `engagements`, `follows`, `saves`, `profile_visits`
  - Both kinds support optional `priority` (integer, 1 = highest) for multi-goal packages
  - `product.conversion_tracking.supported_targets`: `cost_per`, `per_ad_spend`, `maximize_value`
  - `product.metric_optimization.supported_targets`: `cost_per`, `threshold_rate`

- e6767f2: Add `overlays` to format asset definitions for publisher-controlled elements that render over buyer content.

  Publishers can now declare video player controls, publisher logos, and similar per-asset chrome as `overlays` on individual assets. Each overlay includes `bounds` (pixel or fractional, relative to the asset's own top-left corner) and optional `visual` URLs for light and dark theme variants. Creative agents use this to avoid placing critical buyer content behind publisher chrome when composing creatives.

- dfcb522: Add structured pricing options to signals and content standards protocols.

  `get_signals` now returns `pricing_options` (array of typed pricing option objects) instead of the legacy `pricing: {cpm, currency}` field. This enables signals agents to offer time-based subscriptions, flat-rate, CPCV, and other pricing models alongside CPM.

  `list_content_standards` / `get_content_standards` now include `pricing_options` on content standards objects as an optional field, using the same structure. Full billing integration for governance agents will be defined when the account setup flow for that protocol is designed.

  `report_usage` has been simplified: `kind` and `operator_id` are removed. The receiving vendor agent already knows what type of service it provides, and the billing operator is captured by the account reference (`brand + operator` form or implied by account setup when using `account_id`).

  `report_usage` now accepts an `idempotency_key` field. Supply a client-generated UUID per request to prevent duplicate billing on retries.

  `activate_signal` now accepts `pricing_option_id`. Pass the pricing option selected from `get_signals` to record the buyer's pricing commitment at activation time.

- 2957069: Add promoted-offerings-requirement enum and `requires` property to promoted offerings asset requirements (#1040)
- a7feccb: Add property list check and enhancement to the AAO registry API.

  Registry:

  - New `domain_classifications` table with typed entries (`ad_server`, `intermediary`, `cdn`, `tracker`), seeded with ~60 known ad tech infrastructure domains
  - New `property_check_reports` table stores full check results by UUID for 7 days

  API:

  - `POST /api/properties/check` — accepts up to 10,000 domains, returns remove/modify/assess/ok buckets and a report ID
  - `GET /api/properties/check/:reportId` — retrieve a stored report

  Tools:

  - `check_property_list` MCP tool — runs the check and returns a compact summary + report URL (avoids flooding agent context with thousands of domain entries)
  - `enhance_property` MCP tool — analyzes a single unknown domain: WHOIS age check (< 90 days = high risk), adagents.json validation, AI site structure analysis, submits as pending registry entry for Addie review

- add28ec: Add AI provenance and disclosure schema for creatives and artifacts.

  New schemas:

  - `digital-source-type` enum — IPTC-aligned classification of AI involvement (with `enumDescriptions`)
  - `provenance` core object — declares how content was produced, C2PA references, disclosure requirements, and verification results

  Key design decisions:

  - `verification` is an array (multiple services can independently evaluate content)
  - `declared_by` identifies who attached the provenance claim, enabling trust assessment
  - Provenance is a claim — the enforcing party should verify independently
  - Inheritance uses full-object replacement (no field-level merging)
  - IPTC vocabulary uses current values (`digital_creation`, `human_edits`)

  Optional `provenance` field added to:

  - `creative-manifest` (default for all assets in the manifest)
  - `creative-asset` (default for the creative in the library)
  - `artifact` (top-level and per inline asset type)
  - All 11 typed asset schemas (image, video, audio, text, html, css, javascript, vast, daast, url, webhook)

  Optional `provenance_required` field added to `creative-policy`.

- 73e3639: Add reach as a metric optimization goal and expand frequency cap capabilities.

  **New metric optimization kind:**

  - `reach` added to the `metric` enum on `kind: 'metric'` optimization goals
  - `reach_unit` field — specifies the measurement entity (individuals, households, devices, etc.). Must match a value in `metric_optimization.supported_reach_units`.
  - `target_frequency` field — optional `{ min, max, window }` band that frames frequency as an optimization signal, not a hard cap. `window` is required (e.g., `'7d'`, `'campaign'`) — frequency bands are meaningless without a time dimension. The seller de-prioritizes impressions toward entities already within the band and shifts budget toward unreached entities. Can be combined with `targeting_overlay.frequency_cap` for a hard ceiling.

  **Product capability additions:**

  - `metric_optimization.supported_reach_units` — declares which reach units the product supports for reach optimization goals. Required when `supported_metrics` includes `'reach'`.
  - `reach` added to the `supported_metrics` enum in `metric_optimization`.

  **Frequency cap expansion:**

  - `max_impressions` — maximum impressions per entity per window (integer, minimum 1).
  - `per` — entity to count against, using the same values as `reach-unit` enum (individuals, households, devices, accounts, cookies, custom). Aligns with `reach_unit` on reach optimization goals so hard caps and optimization signals stay in sync.
  - `window` — time window for the cap (e.g., `'1d'`, `'7d'`, `'30d'`, `'campaign'`). Required when `max_impressions` is set.
  - `suppress` (formerly `suppress_minutes`) — cooldown between consecutive exposures, now a duration object (e.g. `{"interval": 60, "unit": "minutes"}`). Optional — the two controls (cooldown vs. impression cap) serve different purposes and can be used independently or together.

- 80afa97: Add sandbox mode as a protocol parameter on all task requests. Sellers declare support via `features.sandbox` in capabilities. Buyers pass `sandbox: true` on any request to run without real platform calls or spend. Replaces the previously documented HTTP header approach (X-Dry-Run, X-Test-Session-ID, X-Mock-Time).
- 2b8d6b6: Schema refinements for frequency caps, signal pricing, audience identifiers, keyword capabilities, and duration representation.

  - **Duration type**: Added reusable `core/duration.json` schema (`{interval, unit}` where unit is `"minutes"`, `"hours"`, `"days"`, or `"campaign"`). Used consistently for all time durations. When unit is `"campaign"`, interval must be 1 — the window spans the full campaign flight. (#1215)
  - **FrequencyCap.window**: Changed from pattern-validated string (`"7d"`) to a duration object (e.g. `{"interval": 7, "unit": "days"}` or `{"interval": 1, "unit": "campaign"}`). Also applied to `optimization_goal.target_frequency.window`. (#1215)
  - **Attribution windows**: Replaced string fields with duration objects throughout. `attribution_window.click_through`/`view_through` (strings) became `post_click`/`post_view` (duration objects) on optimization goals, capability declarations, and delivery response. (#1215)
  - **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
  - **FrequencyCap.suppress**: Added `suppress` (duration object, e.g. `{"interval": 60, "unit": "minutes"}`) as the preferred cooldown field. `suppress_minutes` (scalar) is deprecated but still accepted for backwards compatibility. (#1215)
  - **supported_identifier_types**: Removed `platform_customer_id` from the identifier type enum. Added `supports_platform_customer_id` boolean to audience targeting capabilities — a binary capability flag is clearer than an enum value for this closed-ecosystem matching key. (#1217)
  - **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)

- 1c5bbb0: Add percent_of_media pricing model and transaction context to signals protocol:

  - **`signal-pricing.json`**: New schema for signal-specific pricing — discriminated union of `cpm` (fixed CPM) and `percent_of_media` (percentage of spend, with optional `max_cpm` cap for TTD-style hybrid pricing)
  - **`signal-pricing-option.json`**: New schema wrapping `pricing_option_id` + `signal-pricing`. The `get_signals` response now uses this instead of the generic media-buy `pricing-option.json`
  - **`signal-filters.json`**: New `max_percent` filter for percent-of-media signals
  - **`get_signals` request**: Optional `account_id` (per-account rate cards) and `buyer_campaign_ref` (correlate discovery with settlement)
  - **`activate_signal` request**: Optional `account_id` and `buyer_campaign_ref` for transaction context

- 8f26baf: Add Swiss (`ch_plz`) and Austrian (`at_plz`) postal code systems to geo targeting.
- b61f271: Add `sync_audiences` task for CRM-based audience management.

  Buyers wrapping closed platforms (LinkedIn, Meta, TikTok, Google Ads) need to upload hashed CRM data before creating campaigns that target or suppress matched audiences. This adds a dedicated task for that workflow, parallel to `sync_event_sources`.

  Schema:

  - New task: `sync_audiences` with request and response schemas
  - New core schema: `audience-member.json` — hashed identifiers for CRM list members (email, phone, MAIDs)
  - `targeting.json`: add `audience_include` and `audience_exclude` arrays for referencing audiences in `create_media_buy` targeting overlays

  Documentation:

  - New task reference: `docs/media-buy/task-reference/sync_audiences.mdx`
  - Updated `docs/media-buy/advanced-topics/targeting.mdx` with `audience_include`/`audience_exclude` overlay documentation

- 142bcd5: Add `rejected` account status for accounts that were never approved. Previously, `closed` covered both "was active, now terminated" and "seller declined the request", which was counterintuitive. Now `pending_approval` → `rejected` (declined) is distinct from `active` → `closed` (terminated).
- f5e6a21: Agent ergonomics improvements from #1240 tracking issue.

  **Media Buy**

  - `get_products`: Add `fields` parameter for response field projection, reducing context window cost for discovery calls
  - `get_media_buy_delivery`: Add `include_package_daily_breakdown` opt-in for per-package daily pacing data
  - `get_media_buy_delivery`: Add `attribution_window` on request for buyer-controlled attribution windows (model optional)
  - `get_media_buys`: Add buy-level `start_time`/`end_time` (min/max of package flight dates)

  **Capabilities**

  - `get_adcp_capabilities`: Add `supported_pricing_models` and `reporting` block (date range, daily breakdown, webhooks, available dimensions) at seller level

  **Audiences**

  - `sync_audiences` request: Add `description`, `audience_type` (crm/suppression/lookalike_seed), and `tags` metadata
  - `sync_audiences` response: Add `total_uploaded_count` for match rate calculation

  **Forecasting**

  - `ForecastPoint.metrics`: Add explicit typed properties for all 13 forecastable-metric enum values

- 0cede41: Add CreativeBrief type to BuildCreativeRequest for structured campaign context

### Patch Changes

- 24782c2: Add dedicated task reference pages for `sync_accounts` and `list_accounts` under Media Buy Protocol Task Reference.
- 719135b: Move accounts management from manage to admin; fix stale prospect links to removed organizations page.
- 5a90c55: Fix Addie billing status conflating active subscriptions with paid invoices.
- cc6da0c: Increase Addie conversation history from 10 to 20 messages for longer debugging sessions.
- 53e1d65: Add property registry context to Addie's tool reference so she understands what the community property registry is, how data is managed across the three source tiers (authoritative/enriched/community), and when to use each property tool.
- d4f7723: Empty changeset — internal Addie improvements (no protocol changes).
- dce0090: Update Addie's test_adcp_agent tool to use @adcp/client 3.20.0 suite API.
- acd9db7: Addie quality improvements from thread review: accurate spec claims, fictional example names, ads.txt knowledge, shorter deflections, agent type awareness, and session-level web feedback prompt.
- 2d072c1: Clarify push notification config flow in docs and schema.

  - Fix `push_notification_config` placement and naming in webhook docs (task body, not protocol metadata)
  - Add `push_notification_config` explicitly to `create_media_buy` request schema
  - Fix `operation_id` description: client-generated, echoed by publisher
  - Fix HMAC signature format to match wire implementation

- 93e19a1: Remove generated_creative_ref from build_creative and preview_creative schemas. Creative refinement uses manifest passback and creative brief updates instead. Document iterative refinement patterns for build_creative and get_signals.
- 2b79286: Clarify that end_date is exclusive in get_media_buy_delivery documentation

  - Add explicit "inclusive" and "exclusive" labels to start_date/end_date parameters
  - Add callout explaining start-inclusive, end-exclusive behavior with examples
  - Add examples table showing common date range patterns
  - Reinforce behavior in Query Behavior section

- 24b972e: Document save endpoints for brands and properties in registry API docs.
- b311f65: Fix Addie brand management: add missing brand tools to tool reference, prevent save_brand from overwriting enrichment data
- 5e5a3b7: Fix Addie streaming errors, MCP token expiry, and SSE error handling.
- d447e71: Fix three brand identity bugs: has_manifest false when brand.json found, uploaded logo not showing on member card, and "Set up brand" link redirecting to dashboard.
- 5b8feea: Fix build_creative doc examples: remove catalog_id from inline catalogs, add missing offering_id to inline offering items.
- 29bfe08: fix: couple brand enrichment to save in public REST endpoint
- 34d2764: Fix incorrect data wrapper in get_products MCP response examples
- 9f70a06: fix: set CORS headers on MCP 401 responses so OAuth flow can start
- 603ed69: Fix duplicate Moltbook Slack notifications from concurrent poster runs
- 894e9e9: Empty changeset — no protocol impact.
- 3378218:
- e84f932: Fix forbidden-field `not: {}` pattern in response schemas and document `deliver_to` breaking change.

  Remove `"not": {}` property-level constraints from 7 response schemas (creative and content-standards). These markers were intended to mark fields as forbidden in discriminated union variants, but caused Python code generators to emit `Any | None` instead of omitting the field. The `oneOf` + `required` constraints provide correct discrimination; the `not: {}` entries were counterproductive — payloads mixing success and error fields are now correctly rejected by `oneOf` instead of being accepted as one variant.

  Add migration guide to release notes for the `get_signals` `deliver_to` restructuring: the nested `deliver_to.deployments` object was replaced by top-level `destinations` and `countries` fields.

- cf3ebb3: Fix schema version alias resolution for prereleases

  - Fix prerelease sorting bug in schema middleware: `/v3/` was resolving to `3.0.0-beta.1` instead of `3.0.0-beta.3` because prereleases were sorted ascending instead of descending
  - Update `sync_event_sources` and `log_event` docs to use `/v3/` schema links (these schemas were added in v3)

- bf19909: Fix API key authentication for WorkOS keys using the new `sk_` prefix. WorkOS changed their key format from `wos_api_key_` to `sk_`, which caused all newer API keys to be rejected by the auth middleware before reaching validation.
- 5418b93: Fix broken schema links in sync_audiences documentation. Changed from `/schemas/v2/` to `/schemas/v1/` since this task was added after the v2.5.x and v3.0.0-beta releases and its schemas only exist in `latest` (which v1 points to).
- 3e7e545: Fix UTF-8 encoding corruption for non-ASCII characters in brand and agent registry files.

  When external servers serve `.well-known/brand.json` or `.well-known/adagents.json` with a non-UTF-8 charset in their `Content-Type` header (e.g. `charset=iso-8859-1`), axios was decoding the UTF-8 response bytes using that charset, corrupting multi-byte characters like Swedish ä/ö/å into mojibake.

  Fix: use `responseType: 'arraybuffer'` on all external fetches so axios delivers raw bytes, then explicitly decode as UTF-8 regardless of what the server declares.

- 751760a:
- 5b7cbb3: Add Lusha-powered company lookup to referral prospect search: domain-first create form auto-imports companies with full enrichment data.
- 5b7cbb3: Add /manage tier for kitchen cabinet governance access
- 5b7cbb3: Add member referral code system: invite prospects with a personalized landing page, lock the discount to their account on acceptance, and show a 30-day countdown in the membership dashboard.
- 333618c: Download brand logos from Brandfetch CDN to our own PostgreSQL-backed store when enriching brands. Logos are served from `/logos/brands/:domain/:idx` so external agents can download them without hitting Brandfetch hotlinking restrictions.
- ae1b769: Release candidate documentation: RC1 release notes covering all changes since beta.3 including keyword targeting, optimization goals redesign, signal pricing, dimension breakdowns, device type targeting, brand identity unification, delivery forecasts, proposal refinement via session continuity, first-class catalogs, new tasks, sandbox mode, and creative briefs. Rewrote intro page and added dedicated architecture page. Updated v3 overview with complete breaking changes and migration checklists.
- 6259155: Restructure registry: unified hub page and dedicated agents page

  - `/registry` is now a hub page showing all four entity types (Members, Agents, Brands, Properties)
  - `/agents` is now the dedicated agent registry page (formerly at `/registry`)
  - The duplicate "quick links" section that mirrored the tabs on the agent page has been removed
  - `agents`, `brands`, and `publishers` added to reserved member profile slugs

- e6a62ad:
- 34ac3ba: Clarify schema descriptions (ai_tool.version, buyer_ref deduplication) and add attribution migration guide and creative agent disclosure guidance from downstream feedback.
- 155bb4d: Add schema link checker workflow for docs PRs. The checker validates that schema URLs in documentation point to schemas that exist, and warns when schemas exist in source but haven't been released yet.

  Update schema URLs from v1/v2 to v3 across documentation for schemas that are only available in v3:

  - Content standards tasks (calibrate_content, create/get/list/update_content_standards, get_media_buy_artifacts, validate_content_delivery)
  - Creative delivery (get_creative_delivery)
  - Conversion tracking (log_event, sync_event_sources, event-custom-data, user-match)
  - Pricing options (cpa-option, cpm-option, time-option, vcpm-option)
  - Property governance (base-property-source)
  - Protocol capabilities (get-adcp-capabilities-response)
  - Media buy operations (get_media_buys, sync_audiences)
  - Migration guides and reference docs

  Some of these schemas are already released in 3.0.0-beta.3, others will be available in the next beta release (3.0.0-beta.4).

- b61fcd7: Register all tool sets for web chat, matching Slack channel parity. Previously web chat only had knowledge, billing, and schema tools — brand, directory, property, admin, events, meetings, collaboration, and other tools were missing, causing "Unknown tool" errors. Extracts shared baseline tool registration into a single module both channels import.
- 565fb86: Made font and tagline fields editable in brand registry on the UI

## 3.0.0-beta.3

### Major Changes

- e81235c: Add structured tone guidelines and structured logo fields to Brand Manifest schema.

  **BREAKING: Tone field changes:**

  - Tone is now an object type only (string format removed)
  - Structured tone includes `voice`, `attributes`, `dos`, and `donts` fields
  - Existing string values should migrate to `{ "voice": "<previous-string>" }`
  - Enables creative agents to generate brand-compliant copy programmatically

  **Logo object changes:**

  - Added `orientation` enum field: `square`, `horizontal`, `vertical`, `stacked`
  - Added `background` enum field: `dark-bg`, `light-bg`, `transparent-bg`
  - Added `variant` enum field: `primary`, `secondary`, `icon`, `wordmark`, `full-lockup`
  - Added `usage` field for human-readable descriptions
  - Kept `tags` array for additional custom categorization

  These structured fields enable creative agents to reliably filter and select appropriate logo variants.

  Closes #945

- 96a90ec: Standardize cursor-based pagination across all list operations.

  ### Breaking Changes

  - **`list_creatives`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`tasks_list`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`list_property_lists`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_property_list`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_media_buy_artifacts`**: Move top-level `limit`/`cursor` into nested `pagination` object

  ### Non-Breaking Changes

  - Add shared `pagination-request.json` and `pagination-response.json` schemas to `core/`
  - Add optional `pagination` support to `list_accounts`, `get_products`, `list_creative_formats`, `list_content_standards`, and `get_signals`
  - Update documentation for all affected operations

  All list operations now use a consistent pattern: `pagination.max_results` + `pagination.cursor` in requests, `pagination.has_more` + `pagination.cursor` + optional `pagination.total_count` in responses.

### Minor Changes

- d7e7550: Add optional account_id parameter to get_media_buy_delivery and get_media_buy_artifacts requests, allowing buyers to scope queries to a specific account.
- b708168: Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

  `account_id` is optional on `create_media_buy`. Single-account agents can omit it; multi-account agents must provide it.

  - `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
  - `authorized_operators` in brand.json: Brand declares which operators can represent them
  - Account capabilities in `get_adcp_capabilities`: require_operator_auth, supported_billing, required_for_products
  - Three-party billing model: brand, operator, agent
  - Account status lifecycle: active, pending_approval, payment_required, suspended, closed

- 0da0b36: Add channel fields to property and product schemas. Properties can now declare `supported_channels` and products can declare `channels` to indicate which advertising channels they align with. Both fields reference the Media Channel Taxonomy enum and are optional.
- ac4a81f: Add CPA (Cost Per Acquisition) pricing model for outcome-based campaigns.

  CPA enables advertisers to pay per conversion event (purchase, lead, signup, etc.) rather than per impression or click. The pricing option declares which `event_type` triggers billing, independent of any optimization goal.

  This single model covers use cases previously described as CPO (Cost Per Order), CPL (Cost Per Lead), and CPI (Cost Per Install) — differentiated by event type rather than separate pricing models.

  New schema:

  - `cpa-option.json`: CPA pricing option (fixed price per conversion event)

  Updated schemas:

  - `pricing-model.json`: Added `cpa` enum value
  - `pricing-option.json`: Added cpa-option to discriminated union
  - `index.json`: Added cpa-option to registry

- 34ece9f: Add conversion tracking with log_event and sync_event_sources tasks
- 098fce2: Add TIME pricing model for sponsorship-based advertising where price scales with campaign duration. Supports hour, day, week, and month time units with optional min/max duration constraints.
- a854090: Add attribution window metadata to delivery response. The response root now includes an optional `attribution_window` object describing `click_window_days`, `view_window_days`, and attribution `model` (last_touch, first_touch, linear, time_decay, data_driven). Placed at response level since all media buys from a single seller share the same attribution methodology. Enables cross-platform comparison of conversion metrics.
- 8a8e4e7: Add Brand Protocol for brand discovery and identity resolution

  Schema:

  - Add brand.json schema with 4 mutually exclusive variants:
    - Authoritative location redirect
    - House redirect (string domain)
    - Brand agent (MCP-based)
    - House portfolio (full brand hierarchy)
  - Support House/Brand/Property hierarchy parallel to Publisher/Property/Inventory
  - Add keller_type for brand architecture (master, sub-brand, endorsed, independent)
  - Add flat names array for localized brand names and aliases
  - Add parent_brand for sub-brand relationships
  - Add properties array on brands for digital property ownership

  Builder Tools:

  - Add brand.html builder tool for creating brand.json files
  - Supports all 4 variants: portfolio, house redirect, agent, authoritative location
  - Live JSON preview with copy/download functionality
  - Domain validation against existing brand.json files

  Manifest Reference Registry:

  - Add manifest_references table for member-contributed references (not content)
  - References point to URLs or MCP agents where members host their own manifests
  - Support both brand.json and adagents.json references
  - Verification status tracking (pending, valid, invalid, unreachable)
  - Completeness scoring for ranking when multiple refs exist for same domain

  Infrastructure:

  - Add BrandManager service for validation and resolution from well-known URLs
  - Add MCP tools: resolve_brand, validate_brand_json, validate_brand_agent
  - Add manifest reference API routes: list, lookup, create, verify, delete
  - Add TypeScript types: BrandConfig, BrandDefinition, HouseDefinition, ResolvedBrand

  Admin UI:

  - Add /admin/manifest-refs page for unified manifest registry management
  - Show all member-contributed references with verification status
  - Add/verify/delete references to brand.json and adagents.json

  Documentation:

  - Add Brand Protocol section as standalone (not under Governance)
  - Complete brand.json specification with all 4 variants documented

- 8079271: Add commerce attribution metrics to delivery response schema. Adds `new_to_brand_rate` as a first-class field in DeliveryMetrics. Adds `roas` and `new_to_brand_rate` to `aggregated_totals` and `daily_breakdown` in the delivery response. Updates documentation to reflect commerce metric availability.
- 37dbd0d: Add creative delivery reporting to the AdCP specification.

  - Add optional `by_creative` metrics breakdown within `by_package` in delivery responses
  - Add `get_creative_delivery` task on creative agents for variant-level delivery data with manifests
  - Add `creative-variant` core object supporting three tiers: standard (1:1), asset group optimization, and generative creative. Variants include full creative manifests showing what was rendered.
  - Extend `preview_creative` with `request_type: "variant"` for post-flight variant previews
  - Add `selection_mode` to repeatable asset groups to distinguish sequential (carousel) from optimize (asset pool) behavior
  - Add `supports_creative_breakdown` to reporting capabilities
  - Add `delivery` creative agent capability

- 37f46ec: Add delivery forecasting to the Media Buy protocol

  - Add `DeliveryForecast` core type with budget curve, forecast method, currency, and measurement context
  - Add `ForecastRange` core type (low/mid/high) for metric forecasts
  - Add `ForecastPoint` core type — pairs a budget level with metric ranges; single point is a standard forecast, multiple points form a budget curve
  - Add `forecast-method` enum (estimate, modeled, guaranteed)
  - Add `forecastable-metric` enum defining standard metric vocabulary (audience_size, reach, impressions, clicks, spend, etc.)
  - Add `demographic-system` enum (nielsen, barb, agf, oztam, mediametrie, custom) for GRP demographic notation
  - Add `reach-unit` enum (individuals, households, devices, accounts, cookies, custom) for cross-channel reach comparison
  - Add `demographic_system` to CPP pricing option parameters
  - Add optional `forecast` field to `ProductAllocation`
  - Add optional `forecast` field to `Proposal`
  - Add `daypart-target` core type for explicit day+hour targeting windows (follows Google Ads / DV360 pattern)
  - Add `day-of-week` enum (monday through sunday)
  - Add `forecast-range-unit` enum (spend, reach_freq, weekly, daily, clicks, conversions) for interpreting forecast curves
  - Add `daypart_targets` to `Targeting` for hard daypart constraints
  - Add `daypart_targets` to `ProductAllocation` for publisher-recommended time windows in spot plans
  - Add `forecast_range_unit` to `DeliveryForecast` for curve type identification
  - Document forecast scenarios: budget curves, CTV with GRP demographics, retail media with outcomes, allocation-level forecasts

- f37a00c: Deprecate FormatCategory enum and make `type` field optional in Format objects

  The `type` field (FormatCategory) is now optional on Format objects. The `assets` array is the authoritative source for understanding creative requirements.

  **Rationale:**

  - Categories like "video", "display", "native" are lossy abstractions that don't scale to emerging formats
  - Performance Max spans video, display, search, and native simultaneously
  - Search ads (RSA) are text-only with high intent context - neither "display" nor "native" fits
  - The `assets` array already provides precise information about what asset types are needed

  **Migration:**

  - Existing formats with `type` field continue to work
  - New formats may omit `type` entirely
  - Buyers should inspect the `assets` array to understand creative requirements

- 37dbd0d: Add reported_metrics to creative formats and expand available-metric enum
- a859fd1: Add geographic exclusion targeting fields to targeting overlay schema.

  New fields: `geo_countries_exclude`, `geo_regions_exclude`, `geo_metros_exclude`, `geo_postal_areas_exclude`. These enable RCT holdout groups and regulatory compliance exclusions without requiring exhaustive inclusion lists.

- 8836151: Make top-level format_id optional in preview_creative request. The field was redundant with creative_manifest.format_id (which is always required). Callers who omit it fall back to creative_manifest.format_id. Existing callers who send both still work.
- 96d6fa0: Add product_selectors to get_products for commerce product discovery. Add manifest_gtins to promoted-products schema for cross-retailer GTIN matching.
- c8cdbca: Add Signal Catalog feature for data providers

  Data providers (Polk, Experian, Acxiom, etc.) can now publish signal catalogs via `adagents.json`, enabling AI agents to discover, verify authorization, and activate their signals—without custom integrations.

  **Why this matters:**

  - **Discovery**: AI agents can find signals via natural language or structured lookup
  - **Authorization verification**: Buyers can verify a signals agent is authorized by checking the data provider's domain directly
  - **Typed targeting**: Signal definitions include value types (binary, categorical, numeric) so agents construct correct targeting expressions
  - **Scalable partnerships**: Authorize agents once; as you add signals, authorized agents automatically have access

  **New schemas:**

  - `signal-id.json` - Universal signal identifier with `source` discriminator: `catalog` (data_provider_domain + id, verifiable) or `agent` (agent_url + id, trust-based)
  - `signal-definition.json` - Signal spec in data provider's catalog
  - `signal-targeting.json` - Discriminated union for targeting by value_type
  - `signal-category.json` / `signal-value-type.json` / `signal-source.json` - Enums

  **Modified schemas:**

  - `adagents.json` - Added `signals` array, `signal_tags`, and signal authorization types
  - `get-signals-request.json` / `get-signals-response.json` - Added `signal_ids` lookup and structured responses
  - `product.json` - Added `signal_targeting_allowed` flag

  **Server updates:**

  - `AdAgentsManager` - Full signals validation, creation, and authorization verification
  - AAO Registry - Data providers as first-class member type with federated discovery

  See [Data Provider Guide](/docs/signals/data-providers) for implementation details.

- e84aafd: Add functional restriction overlays: age_restriction (with verification methods for compliance), device_platform (technical compatibility using Sec-CH-UA-Platform values), and language (localization). These are compliance/technical restrictions, not audience targeting - demographic preferences should be expressed in briefs.
- f543f44: Add typed asset requirements schemas for creative formats

  Introduces explicit requirement schemas for every asset type with proper discriminated unions. In `format.json`, assets use `oneOf` with `asset_type` as the discriminator - each variant pairs a specific `asset_type` const with its typed requirements schema. This produces clean discriminated union types for code generation.

  - **image-asset-requirements**: `min_width`, `max_width`, `min_height`, `max_height`, `formats`, `max_file_size_kb`, `animation_allowed`, etc.
  - **video-asset-requirements**: dimensions, duration, `containers`, `codecs`, `max_bitrate_kbps`, etc.
  - **audio-asset-requirements**: `min_duration_ms`, `max_duration_ms`, `formats`, `sample_rates`, `channels`, bitrate constraints
  - **text-asset-requirements**: `min_length`, `max_length`, `min_lines`, `max_lines`, `character_pattern`, `prohibited_terms`
  - **markdown-asset-requirements**: `max_length`
  - **html-asset-requirements**: `sandbox` (none/iframe/safeframe/fencedframe), `external_resources_allowed`, `allowed_external_domains`, `max_file_size_kb`
  - **css-asset-requirements**: `max_file_size_kb`
  - **javascript-asset-requirements**: `module_type`, `external_resources_allowed`, `max_file_size_kb`
  - **vast-asset-requirements**: `vast_version`
  - **daast-asset-requirements**: `daast_version`
  - **promoted-offerings-asset-requirements**: (extensible)
  - **url-asset-requirements**: `protocols`, `allowed_domains`, `macro_support`, `role`
  - **webhook-asset-requirements**: `methods`

  This allows sales agents to declare execution environment constraints for HTML creatives (e.g., "must work in SafeFrame with no external JS") as part of the format definition.

- efa8e6a: Add universal macro enum schema and improve macro documentation

  Schema:

  - Add universal-macro.json enum defining all 54 standard macros with descriptions
  - Update format.json supported_macros to reference enum (backward compatible via oneOf)
  - Update webhook-asset.json supported_macros and required_macros to reference enum
  - Register universal-macro enum in schema index

  New Macros:

  - GPP_SID: Global Privacy Platform Section ID(s) for privacy framework identification
  - IP_ADDRESS: User IP address with privacy warnings (often masked/restricted)
  - STATION_ID: Radio station or podcast identifier
  - SHOW_NAME: Program or show name
  - EPISODE_ID: Podcast episode identifier
  - AUDIO_DURATION: Audio content duration in seconds

  Documentation:

  - Add GPP_SID to Privacy & Compliance Macros section
  - Add IP_ADDRESS with privacy warning callout
  - Add Audio Content Macros section for audio-specific macros
  - Add TIMESTAMP to availability table
  - Add GPP_STRING and GPP_SID to availability table
  - Add IP_ADDRESS to availability table with privacy restriction notation (✅‡)
  - Add Audio Content macros to availability table
  - Update legend with ✅‡ notation for privacy-restricted macros

### Patch Changes

- 330676f: Replace Coke/Publicis examples with fictional brands (Acme Corp, Pinnacle Media, Nova Brands) and add CLAUDE.md rule against using real brand names in examples.

## 3.0.0-beta.2

### Minor Changes

- 8b8b63c: Add A2UI and MCP Apps support to Sponsored Intelligence for agent-driven UI rendering.
- 8e37138: Add accounts and agents specification to AdCP protocol.

  AdCP now distinguishes three entities in billable operations:

  - **Brand**: Whose products are advertised (identified by brand manifest)
  - **Account**: Who gets billed, what rates apply (identified by `account_id`)
  - **Agent**: Who is placing the buy (identified by authentication token)

  New schemas:

  - `account.json`: Billing relationship with rate cards, payment terms, credit limits
  - `list-accounts-request.json` / `list-accounts-response.json`: Discover accessible accounts

  Updated schemas:

  - `media-buy.json`: Added account attribution
  - `create-media-buy-request.json`: Added optional `account_id` field
  - `create-media-buy-response.json`: Added account in response
  - `get-products-request.json`: Added optional `account_id` for rate card context
  - `sync-creatives-request.json`: Added optional `account_id` field for creative ownership
  - `sync-creatives-response.json`: Added account attribution in response
  - `list-creatives-response.json`: Added account attribution per creative
  - `creative-filters.json`: Added `account_ids` filter for querying by account

  Deprecates the "Principal" terminology in favor of the more precise Account/Agent distinction.

- cd0274e: Add "creative" to supported_protocols enum in get_adcp_capabilities. Creative agents indicate protocol support via presence in supported_protocols array.
- 1d7c687: Add governance and SI agent types to Addie with complete AdCP protocol tool coverage. Adds 21 new tools for update_media_buy, list_creatives, provide_performance_feedback, property lists, content standards, sponsored intelligence, and get_adcp_capabilities.
- 895bd23: Add property targeting for products and packages

  **Product schema**: Add `property_targeting_allowed` flag to declare whether buyers can filter a product to a subset of its `publisher_properties`:

  - `property_targeting_allowed: false` (default): Product is "all or nothing" - excluded from `get_products` results unless buyer's list contains all properties
  - `property_targeting_allowed: true`: Product included if any properties intersect with buyer's list

  **Targeting overlay schema**: Add `property_list` field to specify which properties to target when purchasing products with `property_targeting_allowed: true`. The package runs on the intersection of the product's properties and the buyer's list.

  This enables publishers to offer run-of-network products that can't be cherry-picked alongside flexible inventory where buyers can target specific properties.

- 2a82501: Add video and audio technical constraint fields for CTV and streaming platforms

  - Add frame rate constraints: acceptable_frame_rates, frame_rate_type, scan_type
  - Add color/HDR fields: color_space, hdr_format, chroma_subsampling, video_bit_depth
  - Add GOP/streaming fields: gop_interval_seconds_min/max, gop_type, moov_atom_position
  - Add audio constraints: audio_required, audio_codec, audio_sampling_rate_hz, audio_channels, audio_bit_depth, audio_bitrate_kbps_min/max
  - Add audio loudness fields: audio_loudness_lufs, audio_loudness_tolerance_db, audio_true_peak_dbfs
  - Extend video-asset.json and audio-asset.json with matching properties
  - Add CTV format examples to video documentation

### Patch Changes

- cef3dfc: Add committee leadership tools for Addie - allows committee leaders to add/remove co-leaders for their own committees (working groups, councils, chapters, industry gatherings) without requiring admin access
- b2189d5: Register account domain with list_accounts task in schema index
- 34c7f8a: Refactor members page to remove pricing table and add URL filter support

  - Replace full pricing grid with compact "Become a Member" banner linking to /membership
  - Add URL query parameter support for filtering (e.g., /members?type=sales_agent)
  - URL updates as users interact with filters for shareable/bookmarkable views

- 00cd9b8: Extract shared PriceGuidance schema to fix duplicate type generation

  **Schema Changes:**

  - Create new `/schemas/pricing-options/price-guidance.json` shared schema
  - Update all 7 pricing option schemas to use `$ref` instead of inline definitions

  **Issue Fixed:**

  - Fixes #884 (Issue 1): Duplicate `PriceGuidance` classes causing mypy arg-type errors
  - When Python types are generated, there will now be a single `PriceGuidance` class instead of 7 identical copies

  **Note:** Issue 2 (RootModel wrappers) requires Python library changes to export type aliases for union types.

- d66bf3d: Remove deprecated v3 features: list_property_features task, list_authorized_properties task, adcp-extension.json schema, assets_required format field, and preview_image format field. All removed items have replacements via get_adcp_capabilities and the new assets discovery model.
- 69435f3: Fix onboarding redirect and add org admin audit tool

  - Remove ?signup parameter check in onboarding - users with existing org memberships now always redirect to dashboard
  - Add admin tool to audit organizations without admins
  - Auto-fix single-member orgs; flag multi-member orgs for manual review

## 3.0.0-beta.1

### Major Changes

- f4ef555: Add Media Channel Taxonomy specification with standardized channel definitions.

  **BREAKING**: Replaces channel enum values (display, video, audio, native, retail → display, olv, social, search, ctv, etc.)

  - Introduces 19 planning-oriented media channels representing how buyers allocate budget
  - Channels: display, olv, social, search, ctv, linear_tv, radio, streaming_audio, podcast, dooh, ooh, print, cinema, email, gaming, retail_media, influencer, affiliate, product_placement
  - Adds desktop_app property type for Electron/Chromium wrapper applications
  - Clear distinction between channels (planning abstractions), property types (addressable surfaces), and formats (how ads render)
  - Includes migration guide and edge cases documentation

- a0039cc: Clarify pricing option field semantics with better separation of hard constraints vs soft hints

  **Breaking Changes:**

  - Rename `fixed_rate` → `fixed_price` in all pricing option schemas
  - Move `price_guidance.floor` → top-level `floor_price` field
  - Remove `is_fixed` discriminator (presence of `fixed_price` indicates fixed pricing)

  **Schema Consolidation:**

  - Consolidate 9 pricing schemas into 7 (one per pricing model)
  - All models now support both fixed and auction pricing modes

  **Semantic Distinction:**

  - Hard constraints (`fixed_price`, `floor_price`) - Publisher-enforced prices that cause bid rejection
  - Soft hints (`price_guidance.p25`, `.p50`, `.p75`, `.p90`) - Historical percentiles for bid calibration

### Minor Changes

- f4ef555: Add unified `assets` field to format schema for better asset discovery

  - Add new `assets` array to format schema with `required` boolean per asset
  - Deprecate `assets_required` (still supported for backward compatibility)
  - Enables full asset discovery for buyers and AI agents to see all supported assets
  - Optional assets like impression trackers can now be discovered and used

- f4ef555: Add Content Standards Protocol for content safety and suitability evaluation.

  Discovery tasks:

  - `list_content_features`: Discover available content safety features
  - `list_content_standards`: List available standards configurations
  - `get_content_standards`: Retrieve content safety policies

  Management tasks:

  - `create_content_standards`: Create a new standards configuration
  - `update_content_standards`: Update an existing configuration
  - `delete_content_standards`: Delete a configuration

  Calibration & Validation tasks:

  - `calibrate_content`: Collaborative dialogue to align on policy interpretation
  - `validate_content_delivery`: Batch validate delivery records

- f4ef555: Add protocol-level get_adcp_capabilities task for cross-protocol capability discovery

  Introduces `get_adcp_capabilities` as a **protocol-level task** that works across all AdCP domain protocols.

  **Tool-based discovery:**

  - AdCP discovery uses native MCP/A2A tool discovery
  - Presence of `get_adcp_capabilities` tool indicates AdCP support
  - Distinctive name ensures no collision with other protocols' capability tools
  - Deprecates `adcp-extension.json` agent card extension

  **Cross-protocol design:**

  - `adcp.major_versions` - Declare supported AdCP major versions
  - `supported_protocols` - Which domain protocols are supported (media_buy, signals)
  - `extensions_supported` - Extension namespaces this agent supports (e.g., `["scope3", "garm"]`)
  - Protocol-specific capability sections nested under protocol name

  **Media-buy capabilities (media_buy section):**

  - `features` - Optional features (inline_creative_management, property_list_filtering, content_standards)
  - `execution.axe_integrations` - Agentic ad exchange URLs
  - `execution.creative_specs` - VAST/MRAID version support
  - `execution.targeting` - Geo targeting with granular system support
  - `portfolio` - Publisher domains, channels, countries

  **Geo targeting:**

  - Countries (ISO 3166-1 alpha-2)
  - Regions (ISO 3166-2)
  - Metros with named systems (nielsen_dma, uk_itl1, uk_itl2, eurostat_nuts2)
  - Postal areas with named systems encoding country and precision (us_zip, gb_outward, ca_fsa, etc.)

  **Product filters - two models for geography:**

  _Coverage filters (for locally-bound inventory like radio, OOH, local TV):_

  - `countries` - country coverage (ISO 3166-1 alpha-2)
  - `regions` - region coverage (ISO 3166-2) for regional OOH, local TV
  - `metros` - metro coverage ({ system, code }) for radio, DOOH, DMA-based inventory

  _Capability filters (for digital inventory with broad coverage):_

  - `required_geo_targeting` - filter by seller capability with two-layer structure:
    - `level`: targeting granularity (country, region, metro, postal_area)
    - `system`: classification taxonomy (e.g., 'nielsen_dma', 'us_zip')
  - `required_axe_integrations` - filter by AXE support
  - `required_features` - filter by protocol feature support

  Use coverage filters when products ARE geographically bound (radio station = DMA).
  Use capability filters when products have broad coverage and you'll target at buy time.

  **Targeting schema:**

  - Updated `targeting.json` with structured geo systems
  - `geo_metros` and `geo_postal_areas` now require system specification
  - System names encode country and precision (us_zip, gb_outward, nielsen_dma, etc.)
  - Aligns with capability declarations in get_adcp_capabilities

  **Governance capabilities (governance section):**

  - `property_features` - Array of features this governance agent can evaluate
  - Each feature has: `feature_id`, `type` (binary/quantitative/categorical), optional `range`/`categories`
  - `methodology_url` - Optional URL to methodology documentation (helps buyers understand/compare vendor approaches)
  - Deprecates `list_property_features` task (schemas removed, doc page retained with migration guide)

  **Capability contract:** If a capability is declared, the seller MUST honor it.

- f4ef555: Add privacy_policy_url field to brand manifest and adagents.json schemas

  Enables consumer consent flows by providing a link to advertiser/publisher privacy policies. AI platforms can use this to present explicit privacy choices to users before data handoff. Works alongside MyTerms/IEEE P7012 discovery for machine-readable privacy terms.

- f4ef555: Clarify creative handling in media buy operations:

  **Breaking:** Replace `creative_ids` with `creative_assignments` in `create_media_buy` and `update_media_buy`

  - `creative_assignments` supports optional `weight` and `placement_ids` for granular control
  - Simple assignment: `{ "creative_id": "my_creative" }` (weight/placement optional)
  - Advanced assignment: `{ "creative_id": "my_creative", "weight": 60, "placement_ids": ["p1"] }`

  **Clarifications:**

  - `creatives` array creates NEW creatives only (add `CREATIVE_ID_EXISTS` error)
  - `delete_missing` in sync_creatives cannot delete creatives in active delivery (`CREATIVE_IN_ACTIVE_DELIVERY` error)
  - Document that existing library creatives should be managed via `sync_creatives`

- f4ef555: Add OpenAI Commerce integration to brand manifest

  - Add `openai_product_feed` as a supported feed format for product catalogs
  - Add `agentic_checkout` object to enable AI agents to complete purchases via structured checkout APIs
  - Document field mapping from Google Merchant Center to OpenAI Product Feed spec

- f4ef555: Add Property Governance Protocol support to get_products

  - Add optional `property_list` parameter to get_products request for filtering products by property list
  - Add `property_list_applied` response field to indicate whether filtering was applied
  - Enables buyers to pass property lists from governance agents to sales agents for compliant inventory discovery

- 5b45d83: Refactor schemas to use $ref for shared type definitions

  **New shared type:**

  - `core/media-buy-features.json` - Shared definition for media-buy protocol features (inline_creative_management, property_list_filtering, content_standards)

  **Breaking change:**

  - `required_features` in product-filters.json changed from string array to object with boolean properties
    - Before: `["content_standards", "inline_creative_management"]`
    - After: `{ "content_standards": true, "inline_creative_management": true }`
  - This aligns the filter format with the capabilities declaration format in `get_adcp_capabilities`

  **Schema deduplication:**

  - `get-adcp-capabilities-response.json`: `media_buy.features` now uses $ref to `core/media-buy-features.json`
  - `product-filters.json`: `required_features` now uses $ref to `core/media-buy-features.json`
  - `artifact.json`: `property_id` now uses $ref to `core/identifier.json`
  - `artifact.json`: `format_id` now uses $ref to `core/format-id.json`

  **Benefits:**

  - Single source of truth for shared types
  - Consistent validation across all usages
  - Reduced schema maintenance burden

### Patch Changes

- 240b50c: Add Addie code version tracking and shorter performance timeframes
- ccdbe18: Fix Addie alert spam and improve content relevance

  **Alert deduplication fix:**
  The alert query now checks if ANY perspective with the same external_url
  has been alerted to a channel, preventing spam from cross-feed duplicates.

  **Content relevance improvement:**
  Tightened `mentions_agentic` detection to require BOTH agentic AI terms
  AND advertising context. This prevents general AI news (e.g., ChatGPT updates)
  from being flagged as relevant to our agentic advertising community.

- f4ef555: Fix Mintlify callout syntax and add case-insensitivity notes for country/language codes

  - Convert `:::note` Docusaurus syntax to Mintlify `<Note>` components
  - Add case-insensitivity documentation for country codes (ISO 3166-1 alpha-2) and language codes (ISO 639-1/BCP 47)
  - Remove orphaned webhook-config.json and webhook-authentication.json schemas

- ec0e4fe: Fix API response parsing in Addie member tools

  Multiple MCP tool handlers were incorrectly parsing API responses, expecting flat arrays/objects when APIs return wrapped responses. Fixed:

  - `list_working_groups`: Extract `working_groups` from `{ working_groups: [...] }`
  - `get_working_group`: Extract `working_group` from `{ working_group: {...}, is_member }`
  - `get_my_working_groups`: Extract `working_groups` from wrapped response
  - `get_my_profile`: Extract `profile` from `{ profile, organization_id, organization_name }`

- 99f7f60: Fix pagination in auto-add domain users feature to fetch all organization members
- a7f0d87: Remove deprecated schema files no longer part of v3 schema design:
  - `creative-formats-v1.json` - replaced by modular format schemas in `source/core/`
  - `standard-format-ids.json` - enum no longer used in current schema structure
  - Cleaned up `index.json` registry (removed stale changelog and version fields)
- 6708ad4: Add debug logging support to Addie's AdCP tools and clarify probe vs test behavior.

  - Add `debug` parameter to all 10 AdCP tool schemas (get_products, create_media_buy, etc.)
  - Include debug_logs in tool output when debug mode is enabled
  - Remove redundant `call_adcp_agent` tool (individual tools provide better schema validation)
  - Fix `probe_adcp_agent` messaging to clarify it only checks connectivity, not protocol compliance

- 65358cb: Fix profile visibility check for invoice-based memberships (Founding Members)
- 91f7bb3: docs: Consolidate data models and schema versioning into schemas-and-sdks page

## 2.6.0

### Major Changes

- Add Content Standards Protocol for brand safety and suitability evaluation (#621)

  **New Protocol:**

  Introduces a comprehensive content standards framework enabling buyers to define, calibrate, and enforce brand safety policies across advertising placements.

  **New Tasks:**

  - `list_content_standards` - List available content standards configurations
  - `get_content_standards` - Retrieve full standards configuration with policy details
  - `create_content_standards` - Create new content standards configuration
  - `update_content_standards` - Update existing content standards configuration
  - `calibrate_content` - Collaborative calibration dialogue for policy alignment
  - `validate_content_delivery` - Batch validate delivery records against standards
  - `get_media_buy_artifacts` - Retrieve content artifacts from media buys for validation

  **New Schemas:**

  - `content-standards.json` - Reusable content standards configuration
  - `content-standards-artifact.json` - Content artifact for evaluation
  - `artifact-webhook-payload.json` - Webhook payload for artifact delivery

- Add Property Governance Protocol for AdCP 3.0 (#588)

  **New Protocol:**

  Enables governance agents to evaluate properties against feature-based requirements for brand safety, content quality, and compliance.

  **New Tasks:**

  - `list_property_features` - Discover governance agent capabilities
  - `create_property_list` - Create managed property lists with filters
  - `update_property_list` - Update existing property lists
  - `get_property_list` - Retrieve property list with resolved properties
  - `list_property_lists` - List all property lists
  - `delete_property_list` - Delete a property list

  **New Schemas:**

  - `property-feature-definition.json` - Feature definition schema
  - `property-feature.json` - Feature assessment schema
  - `feature-requirement.json` - Feature-based requirement schema
  - `property-list.json` - Managed property list schema
  - `property-list-filters.json` - Dynamic filter schema
  - `property-list-changed-webhook.json` - Webhook payload for list changes

### Minor Changes

- Add unified `assets` field to format schema for better asset discovery

  **Schema Changes:**

  - **format.json**: Add new `assets` array field that includes both required and optional assets
  - **format.json**: Deprecate `assets_required` (still supported for backward compatibility)

  **Rationale:**

  Previously, buyers and AI agents could only see required assets via `assets_required`. There was no way to discover optional assets that enhance creatives (companion banners, third-party tracking pixels, etc.).

  Since each asset already has a `required` boolean field, we introduced a unified `assets` array where:

  - `required: true` - Asset MUST be provided for a valid creative
  - `required: false` - Asset is optional, enhances the creative when provided

  This enables:

  - **Full asset discovery**: Buyers and AI agents can see ALL assets a format supports
  - **Richer creatives**: Optional assets like impression trackers can now be discovered and used
  - **Cleaner schema**: Single array instead of two separate arrays

  **Example:**

  ```json
  {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "video_30s"
    },
    "assets": [
      {
        "item_type": "individual",
        "asset_id": "video_file",
        "asset_type": "video",
        "required": true
      },
      {
        "item_type": "individual",
        "asset_id": "end_card",
        "asset_type": "image",
        "required": false
      },
      {
        "item_type": "individual",
        "asset_id": "impression_tracker",
        "asset_type": "url",
        "required": false
      }
    ]
  }
  ```

  **Migration:** Non-breaking change. `assets_required` is deprecated but still supported. New implementations should use `assets`.

- Add typed extensions infrastructure with auto-discovery (#648)

  **New Feature:**

  Introduces a typed extension system allowing vendors and domains to add custom data to AdCP schemas in a discoverable, validated way.

  **New Schemas:**

  - `extensions/extension-meta.json` - Meta schema for extension definitions
  - `extensions/index.json` - Auto-generated registry of all extensions
  - `protocols/adcp-extension.json` - AdCP extension for agent cards

  **Benefits:**

  - Vendor-specific data without polluting core schemas
  - Auto-discovery of available extensions
  - Validation support for extension data

- Add OpenAI Commerce integration to brand manifest (#802)

  **Schema Changes:**

  - **brand-manifest.json**: Add `openai_commerce` field for OpenAI shopping integration

  Enables brands to include their OpenAI Commerce merchant ID for AI-powered shopping experiences.

- Add privacy_policy_url to brand manifest and adagents.json (#801)

  **Schema Changes:**

  - **brand-manifest.json**: Add optional `privacy_policy_url` field
  - **adagents.json**: Add optional `privacy_policy_url` field

  Enables publishers and brands to declare their privacy policy URLs for compliance and transparency.

- Refactor: replace creative_ids with creative_assignments (#794)

  **Breaking Change:**

  Package schema now uses `creative_assignments` array instead of `creative_ids` for more flexible creative-to-package mapping with placement support.

  **Migration:**

  ```json
  // Before
  { "creative_ids": ["creative_1", "creative_2"] }

  // After
  { "creative_assignments": [
    { "creative_id": "creative_1" },
    { "creative_id": "creative_2", "placement_ids": ["homepage_banner"] }
  ]}
  ```

### Patch Changes

- fix: Mintlify callout syntax and case-insensitivity docs (#834)
- fix: Convert governance docs to relative links (#820)
- build: rebuild dist/schemas/2.6.0 with impressions and paused fields
- chore: regenerate dist/schemas/2.6.0 with additionalProperties: true
- ci: add 2.6.x branch to all workflows
- docs: add deprecated assets_required examples with deprecation comments
- schema: make 'required' field mandatory in assets array and nested repeatable_group assets
- schema: add formal deprecated: true to assets_required field

## 2.5.3

### Patch Changes

- 309a880: Allow additional properties in all JSON schemas for forward compatibility

  Changes all schemas from `"additionalProperties": false` to `"additionalProperties": true`. This enables clients running older schema versions to accept responses from servers with newer schemas without breaking validation - a standard practice for protocol evolution in distributed systems.

- 5d0ce75: Add explicit type definition to error.json details property

  The `details` property in core/error.json now explicitly declares `"type": "object"` and `"additionalProperties": true`, consistent with other error details definitions in the codebase. This addresses issue #343 where the data type was unspecified.

- cdcd70f: Fix migration 151 to delete duplicates before updating Slack IDs to WorkOS IDs
- 39abf79: Add missing fields to package request schemas for consistency with core/package.json.

  **Schema Changes:**

  - `media-buy/package-request.json`: Added `impressions` and `paused` fields
  - `media-buy/update-media-buy-request.json`: Added `impressions` field to package updates

  **Details:**

  - `impressions`: Impression goal for the package (optional, minimum: 0)
  - `paused`: Create package in paused state (optional, default: false)

  These fields were defined in `core/package.json` but missing from the request schemas, making it impossible to set impression goals or initial paused state when creating/updating media buys.

  **Documentation:**

  - Updated `create_media_buy` task reference with new package parameters
  - Updated `update_media_buy` task reference with impressions parameter

- fa68588: fix: display Slack profile name for chapter leaders without WorkOS accounts

  Leaders added via Slack ID that haven't linked their WorkOS account now display
  their Slack profile name (real_name or display_name) instead of the raw Slack
  user ID (e.g., U09BEKNJ3GB).

  The getLeaders and getLeadersBatch queries now include slack_user_mappings as an
  additional name source in the COALESCE chain.

- 9315247: Release schemas with `additionalProperties: true` for forward compatibility

  This releases `dist/schemas/2.5.2/` containing the relaxed schema validation
  introduced in #646. Clients can now safely ignore unknown fields when parsing
  API responses, allowing the API to evolve without breaking existing integrations.

## 2.5.2

### Patch Changes

- Add documentation versioning support with Mintlify
  - Version switcher dropdown with 2.5 (default) and 2.6-rc (preview)
  - GitHub Actions workflow to sync 2.6.x branch docs to v2.6-rc
  - Local sync script for testing (`npm run sync:docs`)

## 2.5.1

### Patch Changes

- 72a5802: Fix semantic version sorting for agreements. When multiple agreement versions share the same effective date, the system now correctly selects the highest version (e.g., 1.1.1 before 1.1).
- 935eb43: Fix JSON Schema validation failures when using allOf composition with additionalProperties: false.

  Schemas using `allOf` to compose with base schemas (dimensions.json, push-notification-config.json) were failing AJV validation because each sub-schema independently rejected the other's properties.

  **Fixed schemas:**

  - `dimensions.json` - removed `additionalProperties: false` (composition-only schema)
  - `push-notification-config.json` - removed `additionalProperties: false` (used via allOf in reporting_webhook)
  - `video-asset.json` - inlined width/height properties, removed allOf
  - `image-asset.json` - inlined width/height properties, removed allOf

  **Added:**

  - New `test:composed` script to validate data against schemas using allOf composition
  - Added to CI pipeline to prevent regression
  - Bundled (dereferenced) schemas at `/schemas/{version}/bundled/` for tools that don't support $ref resolution

  Fixes #275.

- 10d5b6a: Fix analytics dashboard revenue tracking with Stripe webhook customer linkage
- b3b4eed: Fix reporting_webhook schema to enable additionalProperties validation.

  Inlined push-notification-config fields because allOf + additionalProperties:false breaks PHP schema generation (reported by Lukas Meier). Documented this pattern in CLAUDE.md.

- 64b08a1: Redesign how AdCP handles push notifications for async tasks. The key change is separating **what data is sent** (AdCP's responsibility) from **how it's delivered** (protocol's responsibility).

  **Renamed:**

  - `webhook-payload.json` → `mcp-webhook-payload.json` (clarifies this envelope is MCP-specific)

  **Created:**

  - `async-response-data.json` - Union schema for all async response data types
  - Status-specific schemas for `working`, `input-required`, and `submitted` statuses

  **Deleted:**

  - Removed redundant `-async-response-completed.json` and `-async-response-failed.json` files (6 total)
  - For `completed`/`failed`, we now use the existing task response schemas directly

  **Before:** The webhook spec tried to be universal, which created confusion about how A2A's native push notifications fit in.

  **After:**

  - MCP uses `mcp-webhook-payload.json` as its envelope, with AdCP data in `result`
  - A2A uses its native `Task`/`TaskStatusUpdateEvent` messages, with AdCP data in `status.message.parts[].data`
  - Both use the **exact same data schemas** - only the envelope differs

  This makes it clear that AdCP only specifies the data layer, while each protocol handles delivery in its own way.

  **Schemas:**

  - `static/schemas/source/core/mcp-webhook-payload.json` (renamed + simplified)
  - `static/schemas/source/core/async-response-data.json` (new)
  - `static/schemas/source/media-buy/*-async-response-*.json` (6 deleted, 9 remain)

  - Clarified that both MCP and A2A use HTTP webhooks (A2A's is native to the spec, MCP's is AdCP-provided)
  - Fixed webhook trigger rules: webhooks fire for **all status changes** if `pushNotificationConfig` is provided and the task runs async
  - Added proper A2A webhook payload examples (`Task` vs `TaskStatusUpdateEvent`)
  - **Task Management** added to sidebar, it was missing

## 2.5.0

### Minor Changes

- cbc95ae: Add explicit discriminator fields to discriminated union types for better TypeScript type generation

  **Schema Changes:**

  - **product.json**: Add `selection_type` discriminator ("all" | "by_id" | "by_tag") to `publisher_properties` items. The new "all" variant enables representing all properties from a publisher domain without requiring explicit IDs or tags.
  - **adagents.json**: Add `authorization_type` discriminator ("property_ids" | "property_tags" | "inline_properties" | "publisher_properties") to `authorized_agents` items, and nested `selection_type` discriminator ("all" | "by_id" | "by_tag") to `publisher_properties` arrays
  - **format.json**: Add `item_type` discriminator ("individual" | "repeatable_group") to `assets_required` items

  **Rationale:**

  Without explicit discriminators, TypeScript generators produce poor types - either massive unions with broken type narrowing or generic index signatures. With discriminators, TypeScript can properly narrow types and provide excellent IDE autocomplete.

  **Migration Guide:**

  All schema changes are **additive** - new required discriminator fields are added to existing structures:

  **Product Schema (`publisher_properties`):**

  ```json
  // Before (property IDs)
  {
    "publisher_domain": "cnn.com",
    "property_ids": ["cnn_ctv_app"]
  }

  // After (property IDs)
  {
    "publisher_domain": "cnn.com",
    "selection_type": "by_id",
    "property_ids": ["cnn_ctv_app"]
  }

  // New: All properties from publisher
  {
    "publisher_domain": "cnn.com",
    "selection_type": "all"
  }
  ```

  **AdAgents Schema (`authorized_agents`):**

  ```json
  // Before
  {
    "url": "https://agent.com",
    "authorized_for": "All inventory",
    "property_ids": ["site_123"]
  }

  // After
  {
    "url": "https://agent.com",
    "authorized_for": "All inventory",
    "authorization_type": "property_ids",
    "property_ids": ["site_123"]
  }
  ```

  **Format Schema (`assets_required`):**

  ```json
  // Before
  {
    "asset_group_id": "product",
    "repeatable": true,
    "min_count": 3,
    "max_count": 10,
    "assets": [...]
  }

  // After
  {
    "item_type": "repeatable_group",
    "asset_group_id": "product",
    "min_count": 3,
    "max_count": 10,
    "assets": [...]
  }
  ```

  Note: The `repeatable` field has been removed from format.json as it's redundant with the `item_type` discriminator.

  **Validation Impact:**

  Schemas now have stricter validation - implementations must include the discriminator fields. This ensures type safety and eliminates ambiguity when parsing union types.

- 161cb4e: Add required package-level pricing fields to delivery reporting schema to match documentation.

  **Schema Changes:**

  - Added required `pricing_model` field to `by_package` items in `get-media-buy-delivery-response.json`
  - Added required `rate` field to `by_package` items for pricing rate information
  - Added required `currency` field to `by_package` items to support per-package currency

  These required fields enable buyers to see pricing information directly in delivery reports for better cost analysis and reconciliation, as documented in the recently enhanced reporting documentation (#179).

- a8471c4: Enforce atomic operation semantics with success XOR error response pattern. Task response schemas now use `oneOf` discriminators to ensure responses contain either complete success data OR error information, never both, never neither.

  **Response Pattern:**

  All mutating operations (create, update, build) now enforce strict either/or semantics:

  1. **Success response** - Operation completed fully:

     ```json
     {
       "media_buy_id": "mb_123",
       "buyer_ref": "campaign_2024_q1",
       "packages": [...]
     }
     ```

  2. **Error response** - Operation failed completely:
     ```json
     {
       "errors": [
         {
           "code": "INVALID_TARGETING",
           "message": "Tuesday-only targeting not supported",
           "suggestion": "Remove day-of-week constraint or select all days"
         }
       ]
     }
     ```

  **Why This Matters:**

  Partial success in advertising operations is dangerous and can lead to unintended spend or incorrect targeting. For example:

  - Buyer requests "US targeting + Tuesday-only dayparting"
  - Partial success returns created media buy without Tuesday constraint
  - Buyer might not notice error, campaign runs with wrong targeting
  - Result: Budget spent on unwanted inventory

  The `oneOf` discriminator enforces atomic semantics at the schema level - operations either succeed completely or fail completely. Buyers must explicitly choose to modify their requirements rather than having the system silently omit constraints.

  **Updated Schemas:**

  All mutating operation schemas now use `oneOf` with explicit success/error branches:

  **Media Buy Operations:**

  - `create-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`, `packages`; Error requires `errors` array
  - `update-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`; Error requires `errors` array
  - `build-creative-response.json` - Success requires `creative_manifest`; Error requires `errors` array
  - `provide-performance-feedback-response.json` - Success requires `success: true`; Error requires `errors` array
  - `sync-creatives-response.json` - Success requires `creatives` array (with per-item results); Error requires `errors` array (operation-level failures only)

  **Signals Operations:**

  - `activate-signal-response.json` - Success requires `decisioning_platform_segment_id`; Error requires `errors` array

  **Webhook Validation:**

  - `webhook-payload.json` - Uses conditional validation (`if/then` with `allOf`) to validate result field against the appropriate task response schema based on task_type. Ensures webhook results are properly validated against their respective task schemas.

  **Schema Structure:**

  ```json
  {
    "oneOf": [
      {
        "description": "Success response",
        "required": ["media_buy_id", "buyer_ref", "packages"],
        "not": { "required": ["errors"] }
      },
      {
        "description": "Error response",
        "required": ["errors"],
        "not": { "required": ["media_buy_id", "buyer_ref", "packages"] }
      }
    ]
  }
  ```

  The `not` constraints ensure responses cannot contain both success and error fields simultaneously.

  **Benefits:**

  - **Safety**: Prevents dangerous partial success scenarios in advertising operations
  - **Clarity**: Unambiguous success vs failure - no mixed signals
  - **Validation**: Schema-level enforcement of atomic semantics
  - **Consistency**: All mutating operations follow same pattern

  **Batch Operations Pattern**

  `sync_creatives` uses a two-level error model that distinguishes:

  - **Operation-level failures** (oneOf error branch): Authentication failed, service down, invalid request format - no creatives processed
  - **Per-item failures**: Individual creative validation errors (action='failed' within the creatives array) - rest of batch still processed

  This provides best-effort batch semantics (process what you can, report what failed) while maintaining atomic operation boundaries (either you can process the batch OR you can't).

  **Migration:**

  This is a backward-compatible change. Existing valid responses (success with all required fields) continue to validate successfully. The change prevents invalid responses (missing required success fields or mixing success/error fields) that were technically possible but semantically incorrect.

  **Alignment with Protocol Standards:**

  This pattern aligns with both MCP and A2A error handling:

  - **MCP**: Tool returns either result content OR sets `isError: true`, not both
  - **A2A**: Task reaches terminal state `completed` OR `failed`, not both
  - **AdCP**: Task payload contains success data XOR errors, enforced at schema level

- 0b76037: Add batch preview and direct HTML embedding support to `preview_creative` task for dramatically faster preview workflows.

  **Enhancements:**

  1. **Batch Mode** - Preview 1-50 creatives in one API call (5-10x faster)

     - Request includes `requests` array instead of single creative
     - Response returns `results` array with success/error per creative
     - Supports partial success (some succeed, others fail)
     - Order preservation (results match request order)

  2. **Direct HTML Embedding** - Skip iframes entirely with `output_format: "html"`
     - Request includes `output_format: "html"` parameter
     - Response includes `preview_html` field with raw HTML
     - No iframe overhead - embed HTML directly in page
     - Perfect for grids of 50+ previews
     - Batch-level and per-request `output_format` support

  **Benefits:**

  - **Performance**: 5-10x faster for 10+ creatives (single HTTP round trip)
  - **Scalability**: No 50 iframe requests for preview grids
  - **Flexibility**: Mix formats and output types in one batch
  - **Developer Experience**: Simpler grid rendering with direct HTML

  **Backward Compatibility:**

  - Existing requests unchanged (same request/response structure)
  - Default `output_format: "url"` maintains iframe behavior
  - Schema uses `oneOf` for seamless mode detection
  - No breaking changes

  **Use Cases:**

  - Bulk creative review UIs with 50+ preview grids
  - Campaign management dashboards
  - A/B testing creative variations
  - Multi-format preview generation

  **Schema Changes:**

  - `/schemas/v1/creative/preview-creative-request.json`:
    - Accepts single OR batch requests via `oneOf`
    - New `output_format` parameter ("url" | "html")
  - `/schemas/v1/creative/preview-creative-response.json`:
    - Returns single OR batch responses via `oneOf`
    - New `preview_html` field in renders (alternative to `preview_url`)

  **Documentation Improvements:**

  - **Common Workflows** section with real-world examples:
    - Format showcase pages (catalog of all available formats)
    - Creative review grids (campaign approval workflows)
    - Web component integration patterns
  - **Best Practices** section covering:
    - When to use URL vs HTML output
    - Batch request optimization strategies
    - Three production-ready architecture patterns
    - Caching strategies for URLs vs HTML
    - Error handling patterns
  - Clear guidance on building efficient applications with 50+ preview grids

- c561479: Make create_media_buy and update_media_buy responses consistent by returning full Package objects.

  **Changes:**

  - `create_media_buy` response now returns full Package objects instead of just package_id + buyer_ref
  - `update_media_buy` response already returned full Package objects (no change to behavior)
  - Both responses now have identical Package structure for consistency

  **Benefits:**

  - **Consistency**: Both create and update operations return the same response structure
  - **Full state visibility**: Buyers see complete package state including budget, status, targeting, creative assignments
  - **Single parse pattern**: Client code can use the same parsing logic for both operations
  - **Atomic state view**: Buyers see exactly what was created/modified without follow-up calls
  - **Modification transparency**: If publisher adjusted budget or other fields, buyer sees actual values immediately

  **Backward Compatibility:**

  - **Additive change only**: New fields added to create_media_buy response
  - **Existing fields unchanged**: media_buy_id, buyer_ref, creative_deadline, packages array all remain
  - **Non-breaking**: Clients parsing just package_id and buyer_ref will continue to work
  - **Dual ID support maintained**: Both publisher IDs (media_buy_id, package_id) and buyer refs are included

  **Response Structure:**

  ```json
  {
    "media_buy_id": "mb_12345",
    "buyer_ref": "media_buy_ref",
    "creative_deadline": "2024-01-30T23:59:59Z",
    "packages": [
      {
        "package_id": "pkg_001",
        "buyer_ref": "package_ref",
        "product_id": "ctv_premium",
        "budget": 50000,
        "status": "active",
        "pacing": "even",
        "pricing_option_id": "cpm-fixed",
        "creative_assignments": [],
        "format_ids_to_provide": [...]
      }
    ]
  }
  ```

- 32ca877: Consolidate agent registry into main repository and unify server architecture.

  **Breaking Changes:**

  - Agent registry moved from separate repository into `/registry` directory
  - Unified Express server now serves homepage, registry UI, schemas, and API endpoints
  - Updated server dependencies and structure

  **New Features:**

  - Single unified server for all AdCP services (homepage, registry, schemas, API, MCP)
  - Updated homepage with working documentation links
  - Slack community navigation link
  - Applied 4dvertible → Advertible Inc rebranding (registry PR #8)

  **Documentation:**

  - Consolidated UNIFIED-SERVER.md, CONSOLIDATION.md, and REGISTRY.md content into main README
  - Updated repository structure documentation
  - Added Docker deployment instructions

- 2a126fe: - Enhanced `get_media_buy_delivery` response to include package-level pricing information: `pricing_model`, `rate`, and `currency` fields added to `by_package` section.

  - Added offline file delivery examples for JSON Lines (JSONL), CSV, and Parquet formats.
  - Added tab structure to list different formats of offline delivery files in optimization reporting documentation.
  - Updated all delivery reporting examples to include new pricing fields.
  - Added comprehensive JSONL, CSV, and Parquet format examples with schema documentation.

  **Impact:**

  - Buyers can now see pricing information directly in delivery reports for better cost analysis.
  - Publishers have clearer guidance on structured batch reporting formats that maintain nested data.
  - Documentation provides a detailed examples for implementing offline file delivery.

- e56721c: Consolidate and rename enum types to eliminate naming collisions

  ## Problem

  Type generators (Python, TypeScript, Go) produced collisions when the same enum name appeared in different schemas:

  - `AssetType` collided across 3 different schemas with overlapping value sets
  - `Type` field name used for both asset content types and format categories
  - Filtering contexts used incomplete subsets rather than full enum

  This caused downstream issues:

  - Python codegen exported first-alphabetically enum, hiding others
  - TypeScript generators produced `Type1`, `Type2` aliases
  - Developers needed internal imports to access correct types

  ## Changes

  **New enum files**:

  - `/schemas/v1/enums/asset-content-type.json` - Asset content types (image, video, html, javascript, vast, daast, text, markdown, css, url, webhook, promoted_offerings, audio)
  - `/schemas/v1/enums/format-category.json` - Format categories (audio, video, display, native, dooh, rich_media, universal)

  **Removed**:

  - `/schemas/v1/core/asset-type.json` - Orphaned schema (never referenced). Originally intended for format requirements but superseded by inline asset definitions in format.json. The enum values from this schema informed the new asset-content-type.json enum.

  **Updated schemas**:

  - `format.json`: `type` field now references `format-category.json`
  - `format.json`: `asset_type` fields now reference `asset-content-type.json`
  - `list-creative-formats-request.json`: All filter fields now use full enum references (no more artificial subsets)
  - `brand-manifest.json`: `asset_type` now references full enum with documentation note about typical usage

  ## Wire Protocol Impact

  **None** - This change only affects schema organization and type generation. The JSON wire format is unchanged, so all API calls remain compatible.

  ## SDK/Type Generation Impact

  **Python**: Update imports from internal generated modules to stable exports:

  ```python
  # Before
  from adcp.types.stable import AssetType  # Actually got asset content types
  from adcp.types.generated_poc.format import Type as FormatType  # Had to alias

  # After
  from adcp.types.stable import AssetContentType, FormatCategory
  ```

  **TypeScript**: Update type imports:

  ```typescript
  // Before
  import { AssetType, Type } from "./generated/types"; // Ambiguous

  // After
  import { AssetContentType, FormatCategory } from "./generated/types"; // Clear
  ```

  **Schema references**: If you're implementing validators, update `$ref` paths:

  ```json
  // Before
  { "type": "string", "enum": ["image", "video", ...] }

  // After
  { "$ref": "/schemas/v1/enums/asset-content-type.json" }
  ```

  ## Rationale

  - **Type safety**: Generators produce clear, non-colliding type names
  - **API flexibility**: Filters now accept full enum (no artificial restrictions)
  - **Maintainability**: Single source of truth for each concept
  - **Clarity**: Semantic names (`AssetContentType` vs `FormatCategory`) self-document

  ## Spec Policy

  Going forward, AdCP follows strict enum naming rules documented in `/docs/spec-guidelines.md`:

  - No reused enum names across different schemas
  - Use semantic, domain-specific names
  - Consolidate enums rather than creating subsets
  - All enums in `/schemas/v1/enums/` directory

- 4bf2874: Application-Level Context in Task Payloads

  - Task request schemas now accept an optional `context` object provided by the initiator
  - Task response payloads (and webhook `result` payloads) echo the same `context`

- e5802dd: Add explicit `is_fixed` discriminator field to all pricing option schemas for consistent discrimination.

  **What Changed:**

  - Fixed-rate options (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate): Now include `is_fixed: true` as a required field
  - Auction-based options (CPM Auction, vCPM Auction): Now include `is_fixed: false` as a required field

  **Why This Change:**
  Previously, only `flat-rate-option` had an explicit `is_fixed` field. Other pricing options had inconsistent discrimination:

  - CPM Fixed vs CPM Auction: Both used `pricing_model: "cpm"`, differentiated only by presence of `rate` vs `price_guidance`
  - vCPM Fixed vs vCPM Auction: Both used `pricing_model: "vcpm"`, same structural inference issue

  This created two different discrimination patterns (explicit field-based vs structural inference), making it difficult for TypeScript generators and clients to properly discriminate between fixed and auction pricing.

  **Benefits:**

  - **Consistent discrimination**: All pricing options use the same explicit pattern
  - **Type safety**: Discriminated unions work properly with `is_fixed` as discriminator
  - **Client simplicity**: No need to check for `rate` vs `price_guidance` existence
  - **API clarity**: Explicit is always better than implicit
  - **Forward compatibility**: Adding new pricing models is easier with explicit discrimination

  **Migration Guide:**
  All pricing option objects must now include the `is_fixed` field:

  ```json
  // Fixed-rate pricing (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate)
  {
    "pricing_option_id": "cpm_usd_guaranteed",
    "pricing_model": "cpm",
    "is_fixed": true,
    "rate": 5.50,
    "currency": "USD"
  }

  // Auction pricing (CPM Auction, vCPM Auction)
  {
    "pricing_option_id": "cpm_usd_auction",
    "pricing_model": "cpm",
    "is_fixed": false,
    "price_guidance": {
      "floor": 2.00
    },
    "currency": "USD"
  }
  ```

- 881ffbf: Remove unused legacy fields from list_creatives response schema.

  **Fields removed:**

  - `media_url` - URL of the creative file
  - `click_url` - Landing page URL
  - `duration` - Duration in milliseconds
  - `width` - Width in pixels
  - `height` - Height in pixels

  **Why this is a minor change (not breaking):**

  These fields were never implemented or populated by any AdCP server implementation. They existed in the schema from the initial creative library implementation but were non-functional. All creative metadata is accessed through the structured `assets` dictionary, which has been the only working approach since AdCP v2.0.

  **Migration:**

  No migration needed - if you were parsing these fields, they were always empty/null. Use the `assets` dictionary to access creative properties:

  ```json
  {
    "creative_id": "hero_video_30s",
    "assets": {
      "vast": {
        "url": "https://vast.example.com/video/123",
        "vast_version": "4.1"
      }
    }
  }
  ```

  All creative asset metadata (URLs, dimensions, durations, click destinations) is contained within the typed asset objects in the `assets` dictionary.

- 649aa2d: Add activation key support for signal protocol with permission-based access. Enables signal agents and buyers to receive activation keys (segment IDs or key-value pairs) based on authenticated permissions.

  **Breaking Changes:**

  - `activate_signal` response: Changed from single `activation_key` field to `deployments` array
  - Both `get_signals` and `activate_signal` now consistently use `destinations` (plural)

  **New Features:**

  - Universal `activation-key.json` schema supporting segment IDs and key-value pairs
  - Flexible destination model supporting DSP platforms (string) and sales agents (URL)
  - Permission-based key inclusion determined by signal agent authentication
  - Buyers with multi-platform credentials receive keys for all authorized platforms

  **New Schemas:**

  - `activation-key.json` - Universal activation key supporting segment_id and key_value types

  **Modified Schemas:**

  - `get-signals-request.json` - destinations array with platform OR agent_url
  - `get-signals-response.json` - deployments include activation_key when authorized
  - `activate-signal-request.json` - destinations array (plural)
  - `activate-signal-response.json` - deployments array with per-destination keys

  **Security:**

  - Removed `requester` flag (can't be spoofed)
  - Signal agent validates caller has access to requested destinations
  - Permission-based access control via authentication layer

- 17f3a16: Add discriminator fields to multiple schemas for improved TypeScript type safety and reduced union signature complexity.

  **Breaking Changes**: The following schemas now require discriminator fields:

  **Signal Schemas:**

  - `destination.json`: Added discriminator with `type: "platform"` or `type: "agent"`
  - `deployment.json`: Added discriminator with `type: "platform"` or `type: "agent"`

  **Creative Asset Schemas:**

  - `sub-asset.json`: Added discriminator with `asset_kind: "media"` or `asset_kind: "text"`
  - `vast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`
  - `daast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`

  **Preview Response Schemas:**

  - `preview-render.json`: NEW schema extracting render object with proper `oneOf` discriminated union
  - `preview-creative-response.json`: Refactored to use `$ref` to `preview-render.json` instead of inline `allOf`/`if`/`then` patterns

  **Benefits:**

  - Reduces TypeScript union signature count significantly (estimated ~45 to ~20)
  - Enables proper discriminated unions in TypeScript across all schemas
  - Eliminates broken index signature intersections from `allOf`/`if`/`then` patterns
  - Improves IDE autocomplete and type checking
  - Provides type-safe discrimination between variants
  - Single source of truth for shared schema structures (DRY principle)
  - 51% reduction in preview response schema size (380 → 188 lines)

  **Migration Guide:**

  ### Signal Destinations and Deployments

  **Before:**

  ```json
  {
    "destinations": [
      {
        "platform": "the-trade-desk",
        "account": "agency-123"
      }
    ]
  }
  ```

  **After:**

  ```json
  {
    "destinations": [
      {
        "type": "platform",
        "platform": "the-trade-desk",
        "account": "agency-123"
      }
    ]
  }
  ```

  For agent URLs:

  ```json
  {
    "destinations": [
      {
        "type": "agent",
        "agent_url": "https://wonderstruck.salesagents.com"
      }
    ]
  }
  ```

  ### Sub-Assets

  **Before:**

  ```json
  {
    "asset_type": "headline",
    "asset_id": "main_headline",
    "content": "Premium Products"
  }
  ```

  **After:**

  ```json
  {
    "asset_kind": "text",
    "asset_type": "headline",
    "asset_id": "main_headline",
    "content": "Premium Products"
  }
  ```

  For media assets:

  ```json
  {
    "asset_kind": "media",
    "asset_type": "product_image",
    "asset_id": "hero_image",
    "content_uri": "https://cdn.example.com/image.jpg"
  }
  ```

  ### VAST/DAAST Assets

  **Before:**

  ```json
  {
    "url": "https://vast.example.com/tag",
    "vast_version": "4.2"
  }
  ```

  **After:**

  ```json
  {
    "delivery_type": "url",
    "url": "https://vast.example.com/tag",
    "vast_version": "4.2"
  }
  ```

  For inline content:

  ```json
  {
    "delivery_type": "inline",
    "content": "<VAST version=\"4.2\">...</VAST>",
    "vast_version": "4.2"
  }
  ```

  ### Preview Render Output Format

  **Note:** The `output_format` discriminator already existed in the schema. This change improves TypeScript type generation by replacing `allOf`/`if`/`then` conditional logic with proper `oneOf` discriminated unions. **No API changes required** - responses remain identical.

  **Schema pattern (existing behavior, better typing):**

  ```json
  {
    "renders": [
      {
        "render_id": "primary",
        "output_format": "url",
        "preview_url": "https://...",
        "role": "primary"
      }
    ]
  }
  ```

  The `output_format` field acts as a discriminator:

  - `"url"` → only `preview_url` field present
  - `"html"` → only `preview_html` field present
  - `"both"` → both `preview_url` and `preview_html` fields present

- 75d12c3: Simplify BrandManifest Schema

  - Replace `anyOf` constraint with single `required: ["name"]` field
  - Fixes code generation issue where schema generators created duplicate types (BrandManifest1 | BrandManifest2)
  - Brand name is now always required, URL remains optional
  - Supports both URL-based brands and white-label brands without URLs

- b7745a4: - Standardize webhook payload: protocol envelope at top-level; task-specific data moved under result.
  - Result schema is bound to task_type via JSON Schema refs; result MAY be present for any status (including failed).
  - Error remains a string; can appear alongside result.
  - Required fields updated to: task_id, task_type, status, timestamp. Domain is no longer required.
  - Docs updated to reflect envelope + result model.
  - Compatibility: non-breaking for users of adcp/client (already expects result); breaking for direct webhook consumers that parsed task fields at the root.
- efc90f2: Add testable documentation infrastructure and improve library discoverability

  **Library Discoverability:**

  - Added prominent "Client Libraries" section to intro.mdx with NPM badge and installation links
  - Updated README.md with NPM package badge and client library installation instructions
  - Documented Python client development status (in development, use MCP SDK directly)
  - Added links to NPM package, PyPI (future), and GitHub repositories

  **Documentation Snippet Testing:**

  - Created comprehensive snippet validation test suite (`tests/snippet-validation.test.js`)
  - Extracts code blocks from all documentation files (.md and .mdx)
  - Tests JavaScript, TypeScript, Python, and Bash (curl) examples
  - Snippets marked with `test=true` or `testable` are automatically validated
  - Integration with test suite via `npm run test:snippets` and `npm run test:all`
  - Added contributor guide for writing testable documentation snippets

  **What this enables:**

  - Documentation examples stay synchronized with protocol changes
  - Broken examples are caught in CI before merging
  - Contributors can confidently update examples knowing they'll be tested
  - Users can trust that documentation code actually works

  **For contributors:**
  See `docs/contributing/testable-snippets.md` for how to write testable documentation examples.

- 058ee19: Add visual card support for products and formats. Publishers and creative agents can now include optional card definitions that reference card formats and provide visual assets for display in user interfaces.

  **New schema fields:**

  - `product_card` and `product_card_detailed` fields in Product schema (both optional)
  - `format_card` and `format_card_detailed` fields in Format schema (both optional)

  **Two-tier card system:**

  - **Standard cards**: Compact 300x400px cards (2x density support) for browsing grids
  - **Detailed cards**: Responsive layout with description alongside hero carousel, markdown specs below

  **Rendering flexibility:**

  - Cards can be rendered dynamically via `preview_creative` task
  - Or pre-generated and served as static CDN assets
  - Publishers/agents choose based on infrastructure

  **Standard card format definitions:**

  - `product_card_standard`, `product_card_detailed`, `format_card_standard`, `format_card_detailed`
  - Will be added to the reference creative-agent repository
  - Protocol specification only defines the schema fields, not the format implementations

  **Deprecation:**

  - `preview_image` field in Format schema is now deprecated (but remains functional)
  - Will be removed in v3.0.0
  - Migrate to `format_card` for better flexibility and structure

  **Benefits:**

  - Improved product/format discovery UX with visual cards
  - Detailed cards provide media-kit-style presentation (description left, carousel right, specs below)
  - Consistent card rendering across implementations
  - Uses AdCP's own creative format system for extensibility
  - Non-breaking: Completely additive, existing implementations continue to work

### Patch Changes

- 7b2ebd4: Complete consolidation of ALL inline enum definitions into /schemas/v1/enums/ directory for consistency and maintainability.

  **New enum schemas created (31 total):**

  _Video/Audio Ad Serving:_

  - `vast-version.json`, `vast-tracking-event.json` - VAST specs
  - `daast-version.json`, `daast-tracking-event.json` - DAAST specs

  _Core Protocol:_

  - `adcp-domain.json` - Protocol domains (media-buy, signals)
  - `property-type.json` - Property types (website, mobile_app, ctv_app, dooh, etc.)
  - `dimension-unit.json` - Dimension units (px, dp, inches, cm)

  _Creative Policies & Requirements:_

  - `co-branding-requirement.json`, `landing-page-requirement.json` - Creative policies
  - `creative-action.json` - Creative lifecycle
  - `validation-mode.json` - Creative validation strictness

  _Asset Types:_

  - `javascript-module-type.json`, `markdown-flavor.json`, `url-asset-type.json`
  - `http-method.json`, `webhook-response-type.json`, `webhook-security-method.json`

  _Performance & Reporting:_

  - `metric-type.json`, `feedback-source.json` - Performance feedback
  - `reporting-frequency.json`, `available-metric.json` - Delivery reports
  - `notification-type.json` - Delivery notifications

  _Signals & Discovery:_

  - `signal-catalog-type.json` - Signal catalog types
  - `creative-agent-capability.json` - Creative agent capabilities
  - `preview-output-format.json` - Preview formats

  _Brand & Catalog:_

  - `feed-format.json`, `update-frequency.json` - Product catalogs
  - `auth-scheme.json` - Push notification auth

  _UI & Sorting:_

  - `sort-direction.json`, `creative-sort-field.json`, `history-entry-type.json`

  **Schemas updated (25+ files):**

  _High-impact (eliminated duplication):_

  - `vast-asset.json`, `daast-asset.json` - Removed duplicate enum definitions
  - `performance-feedback.json`, `provide-performance-feedback-request.json` - Unified metrics/sources
  - `signals/get-signals-request.json`, `signals/get-signals-response.json` - Unified catalog types
  - `list-creative-formats-response.json` (2 files) - Unified capabilities
  - `preview-creative-request.json` - Unified output formats (3 occurrences)

  _Asset schemas:_

  - `webhook-asset.json`, `javascript-asset.json`, `markdown-asset.json`, `url-asset.json`

  _Core schemas:_

  - `property.json`, `format.json`, `creative-policy.json`
  - `reporting-capabilities.json`, `push-notification-config.json`, `webhook-payload.json`

  _Task schemas:_

  - `sync-creatives-request.json`, `sync-creatives-response.json`
  - `list-creatives-request.json`, `list-creatives-response.json`
  - `get-media-buy-delivery-request.json`, `get-products-request.json`
  - Various task list/history schemas

  **Documentation improvements:**

  - Added comprehensive enum versioning strategy to CLAUDE.md
  - Clarifies when enum changes are MINOR vs MAJOR version bumps
  - Documents best practices for enum evolution (add → deprecate → remove)
  - Provides examples of proper enum deprecation workflows

  **Registry update:**

  - Added all 31 new enums to `index.json` with descriptions

  **Impact:**

  - **Enum files**: 16 → 46 (31 new enums)
  - **Schemas validated**: 112 → 137 (25 new enum files)
  - **Duplication eliminated**: 8+ instances across schemas
  - **Single source of truth**: All enums now centralized

  **Benefits:**

  - Complete consistency across all schemas
  - Eliminates all inline enum duplication
  - Easier to discover and update enum values
  - Better SDK generation from consolidated enums
  - Clear guidance for maintaining backward compatibility
  - Follows JSON Schema best practices

- 0504fcf: Extract duplicated property ID and tag patterns into reusable core schemas.

  **New schemas:**

  - `property-id.json` - Single source of truth for property identifier validation
  - `property-tag.json` - Single source of truth for property tag validation

  **Updated schemas:**

  - `publisher-property-selector.json` - Now references shared property-id and property-tag schemas
  - `adagents.json` - Now references shared property-id and property-tag schemas
  - `property.json` - Now references shared property-id and property-tag schemas for property_id and tags fields

  **Benefits:**

  - Eliminates inline pattern duplication across multiple schemas
  - SDK generators now produce single types for property IDs and tags instead of multiple incompatible types
  - Single source of truth for validation rules - changes apply everywhere
  - Clearer semantic meaning with explicit type names
  - Easier to maintain and evolve constraints in the future

  **Breaking change:** No - validation behavior is identical, this is a refactoring only.

- 16f632a: Add explicit type declarations to discriminator fields in JSON schemas.

  All discriminator fields using `const` now include explicit `"type"` declarations (e.g., `"type": "string", "const": "value"`). This enables TypeScript generators to produce proper literal types instead of `Any`, improving type safety and IDE autocomplete.

  **Fixed schemas:**

  - daast-asset.json: delivery_type discriminators
  - vast-asset.json: delivery_type discriminators
  - preview-render.json: output_format discriminators
  - deployment.json: type discriminators
  - sub-asset.json: asset_kind discriminators
  - preview-creative-response.json: response_type and success discriminators

  **Documentation:**

  - Updated CLAUDE.md with best practices for discriminator field typing

- b09ddd6: Update homepage documentation links to external docs site. All documentation links on the homepage, navigation, and footer now point to https://docs.adcontextprotocol.org instead of local paths, directing users to the hosted documentation site.
- 17382ac: Extract filter objects into separate schema files for better type generation.

  **Schema Changes:**

  - Created `product-filters.json` core schema for `get_products` filters
  - Created `creative-filters.json` core schema for `list_creatives` filters
  - Created `signal-filters.json` core schema for `get_signals` filters
  - Updated request schemas to use `$ref` instead of inline filter definitions

  **Benefits:**

  - Type generators can now create proper `ProductFilters`, `CreativeFilters`, and `SignalFilters` classes
  - Enables direct object instantiation: `GetProductsRequest(filters=ProductFilters(delivery_type="guaranteed"))`
  - Better IDE autocomplete and type checking for filter parameters
  - Single source of truth for each filter type
  - Consistent with other AdCP core object patterns

  **Migration:**
  No breaking changes - filter structures remain identical, just moved to separate schema files. Existing code continues to work without modification.

- 8d2bfbb: Fix provide_performance_feedback to support buyer_ref identifier

  The provide_performance_feedback request schema now accepts either `media_buy_id` or `buyer_ref` to identify the media buy, matching the pattern used in update_media_buy and other operations. This was the only schema in the entire specification that forced buyers to track publisher-assigned IDs, creating an inconsistency.

  **What changed:**

  - Added `buyer_ref` field to provide-performance-feedback-request.json
  - Changed `required` array to `oneOf` pattern allowing either identifier
  - Buyers can now provide feedback using their own reference instead of having to track the publisher's media_buy_id

  **Impact:**

  - Backward compatible - existing calls using media_buy_id continue to work
  - Removes the only forced ID tracking requirement in the buyer workflow
  - Aligns with the principle that buyers use their own references throughout

- 8904e6c: Fix broken documentation links for Mintlify deployment.

  Converted all relative internal links to absolute Mintlify-compatible paths with `/docs/` prefix. This fixes 389 broken links across 50 documentation files that were causing 404 errors when users clicked them on docs.adcontextprotocol.org.

  **Technical details:**

  - Changed relative paths like `./reference/release-notes` to absolute `/docs/reference/release-notes`
  - Mintlify requires absolute paths with `/docs/` prefix and no file extensions
  - Links now match Mintlify's URL structure and routing expectations

  Fixes #167

- ddeef70: Fix Slack working group invite link in community documentation. The previous invite URL was not functional; replaced with working invite link for the agenticads Slack workspace.
- 259727a: Add discriminator fields to preview_creative request and response schemas.

  **Changes:**

  - Added `request_type` discriminator to preview-creative-request.json ("single" | "batch")
  - Added `response_type` discriminator to preview-creative-response.json ("single" | "batch")

  **Why:**
  Explicit discriminator fields enable TypeScript generators to produce proper discriminated unions with excellent type narrowing and IDE autocomplete. Without discriminators, generators produce index signatures or massive union types with poor type safety.

  **Migration:**
  Request format:

  ```json
  // Before
  { "format_id": {...}, "creative_manifest": {...} }

  // After (single)
  { "request_type": "single", "format_id": {...}, "creative_manifest": {...} }

  // Before
  { "requests": [...] }

  // After (batch)
  { "request_type": "batch", "requests": [...] }
  ```

  Response format:

  ```json
  // Before
  { "previews": [...], "expires_at": "..." }

  // After (single)
  { "response_type": "single", "previews": [...], "expires_at": "..." }

  // Before
  { "results": [...] }

  // After (batch)
  { "response_type": "batch", "results": [...] }
  ```

- 435a624: Add output_format discriminator to preview render schema for improved validation performance.

  Replaces oneOf constraint on render objects with an explicit output_format field ("url", "html", or "both") that indicates which preview fields are present. This eliminates the need for validators to try all three combinations when validating preview responses, significantly improving validation speed for responses with multiple renders (companion ads, multi-placement formats).

  **Schema change:**

  - Added required `output_format` field to render objects in preview-creative-response.json
  - Replaced `oneOf` validation with conditional `allOf` based on discriminator value
  - Updated field descriptions to reference the discriminator

  **Backward compatibility:**

  - Breaking change: Existing preview responses must add the output_format field
  - Creative agents implementing preview_creative task must update responses

- dfaeece: Refactor publisher property selector schemas to eliminate duplication. Created shared `publisher-property-selector.json` core schema that is now referenced by both `product.json` and `adagents.json` via `$ref`, replacing duplicated inline definitions.

  **Technical improvement**: No API or behavior changes. This is a pure schema refactoring that maintains identical validation semantics while improving maintainability and TypeScript code generation.

- 10cc797: Refactor signals schemas to use reusable core destination and deployment schemas.

  **Changes:**

  - Created `/schemas/v1/core/destination.json` - reusable schema for signal activation destinations (DSPs, sales agents, etc.)
  - Created `/schemas/v1/core/deployment.json` - reusable schema for signal deployment status and activation keys
  - Updated all signals task schemas to reference the new core schemas instead of duplicating definitions
  - Added destination and deployment to schema registry index

  **Benefits:**

  - Eliminates schema duplication across 4 signal task schemas
  - Ensures consistent validation of destination and deployment objects
  - Improves type safety - single source of truth for these data structures
  - Simplifies maintenance - changes to destination/deployment structure only need updates in one place

  **Affected schemas:**

  - `get-signals-request.json` - destinations array now uses `$ref` to core destination schema
  - `get-signals-response.json` - deployments array now uses `$ref` to core deployment schema
  - `activate-signal-request.json` - destinations array now uses `$ref` to core destination schema
  - `activate-signal-response.json` - deployments array now uses `$ref` to core deployment schema

  This is a non-breaking change - the validation behavior remains identical, only the schema structure is improved.

- 4c76776: Restore axe_include_segment and axe_exclude_segment targeting fields

  These fields were accidentally removed from the targeting schema and have been restored to enable AXE segment targeting functionality.

  **Restored fields:**

  - `axe_include_segment` - AXE segment ID to include for targeting
  - `axe_exclude_segment` - AXE segment ID to exclude from targeting

  **Updated documentation:**

  - Added AXE segment fields to create_media_buy task reference
  - Added detailed parameter descriptions in targeting advanced topics

- ead19fa: Restore Offline File Delivery (Batch) section and update pre-push validation to use Mintlify.

  Restored the "Offline File Delivery (Batch)" section that was removed in PR #203 due to MDX parsing errors. The section now uses regular markdown sections instead of tabs to avoid MDX parsing issues.

  **Changes:**

  - Restored comprehensive format examples for JSONL, CSV, and Parquet formats
  - Fixed empty space issue at `#offline-file-delivery-batch` anchor
  - Reordered the Delivery Methods section to make the structure more reasonable - Delivery Methods is now the parent section with Webhook-Based Reporting and Offline-File-Delivery-Based Reporting as subsections
  - Updated pre-push hook to validate with Mintlify (broken links and accessibility checks) instead of Docusaurus build
  - Aligned validation with production system (Mintlify)
  - Added missing fields (notification_type, sequence_number, next_expected_at) to all offline file format examples
  - Updated CSV format to use dot notation (by_package.pricing_model, totals.impressions)

  This ensures the documentation section works correctly in production and prevents future removals due to syntax conflicts between Docusaurus and Mintlify.

- b32275d: Fix: Rename `destinations` field to `deployments` in all signal request schemas for terminology consistency.

  This change standardizes the field name to use "deployments" throughout both requests and responses, creating a simpler mental model where everything uses consistent "deployment" terminology.

  **What changed:**

  - `get_signals` request: `deliver_to.destinations` → `deliver_to.deployments`
  - `activate_signal` request: `destinations` → `deployments`

  **Migration guide:**

  **Before:**

  ```json
  {
    "signal_spec": "High-income households",
    "deliver_to": {
      "destinations": [
        {
          "type": "platform",
          "platform": "the-trade-desk"
        }
      ],
      "countries": ["US"]
    }
  }
  ```

  **After:**

  ```json
  {
    "signal_spec": "High-income households",
    "deliver_to": {
      "deployments": [
        {
          "type": "platform",
          "platform": "the-trade-desk"
        }
      ],
      "countries": ["US"]
    }
  }
  ```

  The `Destination` schema itself remains unchanged - only the field name in requests has been renamed to match the response field name (`deployments`).

## 2.3.0

### Minor Changes

- da956ff: Restructure property references across the protocol to use `publisher_properties` pattern. Publishers are the single source of truth for property definitions.

  **Architecture Change: Publishers Own Property Definitions**

  `list_authorized_properties` now works like IAB Tech Lab's sellers.json - it lists which publishers an agent represents. Buyers fetch each publisher's adagents.json to see property definitions and verify authorization scope.

  **Key Changes:**

  1. **list_authorized_properties response** - Simplified to just domains:

  ```json
  // Before (v2.x)
  {"properties": [{...}], "tags": {...}}

  // After (v2.3)
  {"publisher_domains": ["cnn.com", "espn.com"]}
  ```

  2. **Product property references** - Changed to publisher_properties:

  ```json
  // Before (v2.x)
  {
    "properties": [{...full objects...}]
    // OR
    "property_tags": ["premium"]
  }

  // After (v2.3)
  {
    "publisher_properties": [
      {
        "publisher_domain": "cnn.com",
        "property_tags": ["ctv"]
      }
    ]
  }
  ```

  Buyers fetch `https://cnn.com/.well-known/adagents.json` for:

  - Property definitions (cnn.com is source of truth)
  - Agent authorization verification
  - Property tag definitions

  **New Fields:**

  1. **`contact`** _(optional)_ - Identifies who manages this file (publisher or third-party):

     - `name` - Entity managing the file (e.g., "Meta Advertising Operations")
     - `email` - Contact email for questions/issues
     - `domain` - Primary domain of managing entity
     - `seller_id` - Seller ID from IAB Tech Lab sellers.json
     - `tag_id` - TAG Certified Against Fraud ID

  2. **`properties`** _(optional)_ - Top-level property list (same structure as `list_authorized_properties`):

     - Array of Property objects with identifiers and tags
     - Defines all properties covered by this file

  3. **`tags`** _(optional)_ - Property tag metadata (same structure as `list_authorized_properties`):

     - Human-readable names and descriptions for each tag

  4. **Agent Authorization** - Four patterns for scoping:

     - `property_ids` - Direct property ID references within this file
     - `property_tags` - Tag-based authorization within this file
     - `properties` - Explicit property lists (inline definitions)
     - `publisher_properties` - **Recommended for third-party agents**: Reference properties from publisher's canonical adagents.json files
     - If all omitted, agent is authorized for all properties in file

  5. **Property IDs** - Optional `property_id` field on Property objects:

     - Enables direct referencing (`"property_ids": ["cnn_ctv_app"]`)
     - Recommended format: lowercase with underscores
     - More efficient than repeating full property objects

  6. **publisher_domain Optional** - Now optional in adagents.json:
     - Required in `list_authorized_properties` (multi-domain responses)
     - Optional in adagents.json (file location implies domain)

  **Benefits:**

  - **Single source of truth**: Publishers define properties once in their own adagents.json
  - **No duplication**: Agents don't copy property data, they reference it
  - **Automatic updates**: Agent authorization reflects publisher property changes without manual sync
  - **Simpler agents**: Agents return authorization list, not property details
  - **Buyer validation**: Buyers verify authorization by checking publisher's adagents.json
  - **Scalability**: Works for agents representing 1 or 1000 publishers

  **Use Cases:**

  - **Third-Party Sales Networks**: CTV specialist represents multiple publishers without duplicating property data
  - **Publisher Direct**: Publisher's own agent references their domain, buyers fetch properties from publisher file
  - **Meta Multi-Brand**: Single agent for Instagram, Facebook, WhatsApp using property tags
  - **Tumblr Subdomain Control**: Authorize root domain only, NOT user subdomains
  - **Authorization Validation**: Buyers verify agent is in publisher's authorized_agents list

  **Domain Matching Rules:**

  Follows web conventions while requiring explicit authorization for non-standard subdomains:

  - `"example.com"` → Matches base domain + www + m (standard web/mobile subdomains)
  - `"edition.example.com"` → Matches only that specific subdomain
  - `"*.example.com"` → Matches ALL subdomains but NOT base domain

  **Rationale**: www and m are conventionally the same site. Other subdomains require explicit listing.

  **Migration Guide:**

  Sales agents need to update `list_authorized_properties` implementation:

  **Old approach (v2.x)**:

  1. Fetch/maintain full property definitions
  2. Return complete property objects in response
  3. Keep property data synchronized with publishers

  **New approach (v2.3+)**:

  1. Read `publisher_properties` from own adagents.json
  2. Extract unique publisher domains
  3. Return just the list of publisher domains
  4. No need to maintain property data - buyers fetch from publishers

  Buyer agents need to update workflow:

  1. Call `list_authorized_properties` to get publisher domain list
  2. Fetch each publisher's adagents.json
  3. Find agent in publisher's authorized_agents array
  4. Resolve authorization scope from publisher's file (property_ids, property_tags, or all)
  5. Cache publisher properties for product validation

  **Backward Compatibility:** Response structure changed but this is pre-1.0, so treated as minor version. `adagents.json` changes are additive (new optional fields).

- bf0987c: Make brand_manifest optional in get_products and remove promoted_offering.

  Sales agents can now decide whether brand context is necessary for product recommendations. This allows for more flexible product discovery workflows where brand information may not always be available or required upfront.

  **Schema changes:**

  - `get-products-request.json`: Removed `brand_manifest` from required fields array

  **Documentation changes:**

  - Removed all references to `promoted_offering` field (which never existed in schema)
  - Updated all request examples to remove `promoted_offering`
  - Updated usage notes and implementation guide to focus on `brief` and `brand_manifest`
  - Removed policy checking guidance that was tied to `promoted_offering`
  - Fixed schema-documentation mismatch where docs showed `promoted_offering` but schema had `brand_manifest`

- ff4af78: Add placement targeting for creative assignments. Enables products to define multiple placements (e.g., homepage banner, article sidebar) and buyers to assign different creatives to each placement while purchasing the entire product.

  **New schemas:**

  - `placement.json` - Placement definition with placement_id, name, description, format_ids
  - Added optional `placements` array to Product schema
  - Added optional `placement_ids` array to CreativeAssignment schema

  **Design:**

  - Packages always buy entire products (no package-level placement targeting)
  - Placement targeting only via `create_media_buy`/`update_media_buy` creative assignments
  - `sync_creatives` does NOT support placement targeting (keeps bulk operations simple)
  - Creatives without `placement_ids` run on all placements in the product

- 04cc3b9: Remove media buy level budget field. Budget is now only specified at the package level, with each package's pricing_option_id determining the currency. This simplifies the protocol by eliminating redundant budget aggregation and allows mixed-currency campaigns when sellers support it.

  **Breaking changes:**

  - Removed `budget` field from create_media_buy request (at media buy level)
  - Removed `budget` field from update_media_buy request (at media buy level)

  **Migration:**

  - Move budget amounts to individual packages
  - Each package specifies budget as a number in the currency of its pricing_option_id
  - Sellers can enforce single-currency rules if needed by validating pricing options

- 7c194f7: Add tracker_script type to URL assets for measurement SDKs. Split the `url_type` enum to distinguish between HTTP request tracking (tracker_pixel) and script tag loading (tracker_script) for OMID verification scripts and native event trackers.

### Patch Changes

- 279ded1: Clarify webhook payload structure with explicit required fields documentation.

  **Changes:**

  - Added new `webhook-payload.json` schema documenting the complete structure of webhook POST payloads
  - Added new `task-type.json` enum schema with all valid AdCP task types
  - Refactored task schemas to use `$ref` to task-type enum (eliminates duplication across 4 schemas)
  - Updated task management documentation to explicitly list required webhook fields: `task_id`, `task_type`, `domain`, `status`, `created_at`, `updated_at`
  - Enhanced webhook examples to show all required protocol-level fields
  - Added schema reference link for webhook payload structure

  **Context:**
  This clarifies an ambiguity in the spec that was causing confusion in implementations. The `task_type` field is required in webhook payloads (along with other protocol-level task metadata) but this wasn't explicitly documented before. Webhooks receive the complete task response object which includes both protocol-level fields AND domain-specific response data merged at the top level.

  **Impact:**

  - Documentation-only change, no breaking changes to existing implementations
  - Helps implementers understand the exact structure of webhook POST payloads
  - Resolves confusion about whether `task_type` is required (it is)

- 21848aa: Switch llms.txt plugin so that we get proper URLs
- 69179a2: Updated LICENSE to Apache2 and introducing CONTRIBUTING.md and IPR_POLICY.md
- cc3b86b: Add comprehensive security documentation including SECURITY.md with vulnerability disclosure policy and enhanced security guidelines covering financial transaction safety, multi-party trust model, authentication/authorization, data protection, compliance considerations, and role-specific security checklists.
- 86d9e9c: Fix URL asset field naming and simplify URL type classification.

  **Schema changes:**

  - Added `url_type` field to URL asset schema (`/schemas/v1/core/assets/url-asset.json`)
  - Simplified `url_type` to two values:
    - `clickthrough` - URL for human interaction (may redirect through ad tech)
    - `tracker` - URL that fires in background (returns pixel/204)

  **Documentation updates:**

  - Replaced all instances of `url_purpose` with `url_type` across all documentation
  - Simplified all tracking URL types (impression_tracker, click_tracker, video_start, video_complete, etc.) to just `tracker`
  - Clarified that `url_type` is only used in format requirements, not in creative manifest payloads
  - The `asset_id` field already indicates the specific purpose (e.g., `impression_tracker`, `video_start_tracker`, `landing_url`)

  **Rationale:**
  The distinction between impression_tracker, click_tracker, video_start, etc. was overly prescriptive. The `asset_id` in format definitions already tells you what the URL is semantically for. The `url_type` field distinguishes between URLs intended for human interaction (clickthrough) versus background tracking (tracker). A clickthrough may redirect through ad tech platforms before reaching the final destination, while a tracker fires in the background and returns a pixel or 204 response.

- 97ec201: Added min_width, min_height and aspect_ratio to ImageAsset type

## 2.2.0

### Minor Changes

- 727463a: Align build_creative with transformation model and consistent naming

  **Breaking changes:**

  - `build_creative` now uses `creative_manifest` instead of `source_manifest` parameter
  - `build_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
  - `preview_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
  - `build_creative` response simplified to return just `creative_manifest` (removed complex nested structure)

  **Improvements:**

  - Clear transformation model: manifest-in → manifest-out
  - Format definitions drive requirements (e.g., promoted_offerings is a format asset requirement)
  - Consistent naming across build_creative and preview_creative
  - Self-contained manifests that flow through build → preview → sync
  - Eliminated redundancy and ambiguity about where to provide inputs

  This change makes the creative generation workflow much clearer and more consistent. Generative formats that require `promoted_offerings` should specify it as a required asset in their format definition, and it should be included in the `creative_manifest.assets` object.

### Patch Changes

- eeb9967: Automate schema version synchronization with package.json

  Implemented three-layer protection to ensure schema registry version stays in sync with package.json:

  1. **Auto-staging**: update-schema-versions.js now automatically stages changes to git
  2. **Verification gate**: New verify-version-sync.js script prevents releases when versions don't match
  3. **Pre-push validation**: Git hook checks version sync before any push

  Also fixed v2.1.0 schema registry version (was incorrectly showing 2.0.0) and removed duplicate creative-manifest entry.

- 7d0c8c8: Improve documentation visibility and navigation

  **Documentation Improvements:**

  1. **Added Changelog Page**

     - Created comprehensive `/docs/reference/changelog` with v2.1.0 and v2.0.0 release notes
     - Includes developer migration guide with code examples
     - Documents breaking changes and versioning policy
     - Added to sidebar navigation in Reference section

  2. **Improved Pricing Documentation Visibility**

     - Added Pricing Models to sidebar navigation (Media Buy Protocol > Advanced Topics)
     - Added pricing information callouts to key task documentation
     - Enhanced `get_products` with pricing_options field description
     - Added missing `pricing_option_id` field to `create_media_buy` Package Object
     - Added prominent tip box linking to pricing guide in media-products.md

  3. **Added Release Banner**
     - Homepage now displays v2.1.0 release announcement with link to changelog
     - Makes new releases immediately visible to documentation readers

  **Why These Changes:**

  - Users reported difficulty finding changelog and version history
  - Pricing documentation was comprehensive but hidden from navigation
  - Critical fields like `pricing_option_id` were not documented in API reference
  - Release announcements need better visibility on homepage

  These are documentation-only changes with no code or schema modifications.

## 2.1.0

### Minor Changes

- ae091dc: Simplify asset schema architecture by separating payload from requirements

  **Breaking Changes:**

  1. **Removed `asset_type` field from creative manifest wire format**

     - Asset payloads no longer include redundant type information
     - Asset types are determined by format specification, not declared in manifest
     - Validation is format-aware using `asset_id` lookup

  2. **Deleted `/creative/asset-types/*.json` individual schemas**

     - 11 duplicate schema files removed (image, video, audio, vast, daast, text, url, html, css, javascript, webhook)
     - Asset type registry now references `/core/assets/` schemas directly
     - Schema path changed: `/creative/asset-types/image.json` → `/core/assets/image-asset.json`

  3. **Removed constraint fields from core asset payloads**
     - `vast-asset.json`: Removed `max_wrapper_depth` (format constraint, not payload data)
     - `text-asset.json`: Removed `max_length` (format constraint, not payload data)
     - `webhook-asset.json`: Removed `fallback_required` (format requirement, not asset property)
     - Constraint fields belong in format specification `requirements`, not asset schemas

  **Why These Changes:**

  - **Format-aware validation**: Creative manifests are always validated in the context of their format specification. The format already defines what type each `asset_id` should be, making `asset_type` in the payload redundant.
  - **Single source of truth**: Each asset type now defined once in `/core/assets/`, eliminating 1,797 lines of duplicate code.
  - **Clear separation of concerns**: Payload schemas describe data structure; format specifications describe constraints and requirements.
  - **Reduced confusion**: No more wondering which schema to reference or where to put constraints.

  **Migration Guide:**

  ### Code Changes

  ```diff
  // Schema references
  - const schema = await fetch('/schemas/v1/creative/asset-types/image.json')
  + const schema = await fetch('/schemas/v1/core/assets/image-asset.json')

  // Creative manifest structure (removed asset_type)
  {
    "assets": {
      "banner_image": {
  -     "asset_type": "image",
        "url": "https://cdn.example.com/banner.jpg",
        "width": 300,
        "height": 250
      }
    }
  }

  // Validation changes - now format-aware
  - // Old: Standalone asset validation
  - validate(assetPayload, imageAssetSchema)

  + // New: Format-aware validation
  + const format = await fetchFormat(manifest.format_id)
  + const assetRequirement = format.assets_required.find(a => a.asset_id === assetId)
  + const assetSchema = await fetchAssetSchema(assetRequirement.asset_type)
  + validate(assetPayload, assetSchema)
  ```

  ### Validation Flow

  1. Read `format_id` from creative manifest
  2. Fetch format specification from format registry
  3. For each asset in manifest:
     - Look up `asset_id` in format's `assets_required`
     - If not found → error "unknown asset_id"
     - Get `asset_type` from format specification
     - Validate asset payload against that asset type's schema
  4. Check all required assets are present
  5. Validate type-specific constraints from format `requirements`

  ### Constraint Migration

  Constraints moved from asset schemas to format specification `requirements` field:

  ```diff
  // Format specification assets_required
  {
    "asset_id": "video_file",
    "asset_type": "video",
    "required": true,
    "requirements": {
      "width": 1920,
      "height": 1080,
      "duration_ms": 15000,
  +   "max_file_size_bytes": 10485760,
  +   "acceptable_codecs": ["h264", "h265"]
    }
  }
  ```

  These constraints are validated against asset payloads but are not part of the payload schema itself.

### Patch Changes

- 4be4140: Add Ebiquity as founding member
- f99a4a7: Clarify asset_id usage in creative manifests

  Previously ambiguous: The relationship between `asset_id` in format definitions and the keys used in creative manifest `assets` objects was unclear.

  Now explicit:

  - Creative manifest keys MUST exactly match `asset_id` values from the format's `assets_required` array
  - `asset_role` is optional/documentary—not used for manifest construction
  - Added validation guidance: what creative agents should do with mismatched keys

  Example: If a format defines `asset_id: "banner_image"`, your manifest must use:

  ```json
  {
    "assets": {
      "banner_image": { ... }  // ← Must match asset_id
    }
  }
  ```

  Changes: Updated creative-manifest.json, format.json schemas and creative-manifests.md documentation.

- 67d7994: Fix format_id documentation to match schema specification

All notable changes to the AdCP specification will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-10-15

### Added

- **Production Release**: AdCP v2.0.0 is the first production-ready release of the Advertising Context Protocol
- **Media Buy Tasks**: Core tasks for advertising workflow
  - `get_products` - Discover advertising inventory
  - `list_creative_formats` - Discover supported creative formats
  - `create_media_buy` - Create advertising campaigns
  - `sync_creatives` - Synchronize creative assets
  - `list_creatives` - Query creative library
  - `update_media_buy` - Update campaign settings
  - `get_media_buy_delivery` - Retrieve delivery metrics
  - `list_authorized_properties` - Discover authorized properties
  - `provide_performance_feedback` - Share performance data
- **Creative Tasks**: AI-powered creative generation
  - `build_creative` - Generate creatives from briefs
  - `preview_creative` - Generate creative previews
  - `list_creative_formats` - Discover format specifications
- **Signals Tasks**: First-party data integration
  - `get_signals` - Discover available signals
  - `activate_signal` - Activate signals for campaigns
- **Standard Formats**: Industry-standard creative formats
  - Display formats (banner, mobile, interstitial)
  - Video formats (standard, skippable, stories)
  - Native formats (responsive native)
  - Standard asset types for multi-asset creatives
- **Protocol Infrastructure**:
  - JSON Schema validation for all tasks
  - MCP (Model Context Protocol) support
  - A2A (Agent-to-Agent) protocol support
  - Task management with async workflows
  - Human-in-the-loop approval system
- **Documentation**: Comprehensive documentation
  - Protocol specification
  - Task reference guides
  - Integration guides for MCP and A2A
  - Standard formats documentation
  - Error handling documentation
- **Version Management**:
  - Changesets for automated version management
  - Single source of truth for version (schema registry only)
  - Simplified versioning: version indicated by schema path (`/schemas/v1/`)

### Changed

- Initial release, no changes from previous versions

### Design Decisions

- **Simplified Versioning**: Version is maintained only in the schema registry (`/schemas/v1/index.json`) and indicated by schema path. Individual request/response schemas and documentation do not contain version fields, reducing maintenance burden while maintaining clear version semantics.

### Technical Details

- **Schema Version**: 2.0.0
- **Standard Formats Version**: 1.0.0
- **Protocol Support**: MCP, A2A
- **Node Version**: >=18.0

### Notes

This is the first production-ready release of AdCP. Future releases will follow semantic versioning:

- **Patch versions** (2.0.x): Bug fixes and clarifications
- **Minor versions** (2.x.0): New features and enhancements (backward compatible)
- **Major versions** (x.0.0): Breaking changes

We use [Changesets](https://github.com/changesets/changesets) for version management. All changes should include a changeset file.

[2.0.0]: https://github.com/adcontextprotocol/adcp/releases/tag/v2.0.0
