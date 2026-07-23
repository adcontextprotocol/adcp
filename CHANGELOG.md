# Changelog

## 3.2.0

### Minor Changes

- 4cdebb9: Allow `null` for video-only delivery metrics (`quartile_data`, `completion_rate`). Sellers running non-video inventory (display, audio-only, DOOH-without-video) legitimately have no value for these metrics, and returning `null` is the correct "not applicable" signal. The schema previously required `type: "number"` / `type: "object"` and rejected `null`, causing receivers to fail validation on every valid display-inventory delivery report.

  `delivery-metrics.json` (`totals` / `by_package[]`) now accepts `["number", "null"]` for `completion_rate` and `["object", "null"]` for `quartile_data`; `get-media-buy-delivery-response.json` `aggregated_totals.completion_rate` gets the same loosening so the aggregate path can't re-trigger the failure. The `minimum`/`maximum` constraints on `completion_rate` still apply to non-null values, and the type stays narrowed to null (no strings/arrays). Every other delivery metric continues to signal "not applicable" by omission, not `null` — this exception is scoped to the two video-only fields. Spec-loosening for the receiver contract: producers already sending numbers/objects remain valid.

  The separate inline `completion_rate` in `report-plan-outcome-request.json` (a governance self-report block, not on the `get_media_buy_delivery` path) is intentionally left unchanged.

- e75f12f: Add `property_list_exclude` to the targeting overlay: a reference to a property list whose properties must not carry the buyer's ads, for brand-safety do-not-run lists (apps and sites). Mirrors `collection_list_exclude` and reuses `property-list-ref.json`. Exclude wins on overlap with `property_list` and applies regardless of the product's `property_targeting_allowed` flag. Sellers declare support via the property/collection list entries in the `get_adcp_capabilities` targeting table.
- 81cf467: Withdraw the incorrectly specified `publisher_domain` filter from `get_products` before the next minor release. The filter was not patch-eligible for the stable 3.1.x line, and its implementation incorrectly accepted the plural `publisher_domains[]` form that product schemas reject.

### Patch Changes

- 0fe5101: compliance(media-buy): the `available_actions` scenario uses a non-guaranteed product fixture so `sales-non-guaranteed`-only sellers can run it.

  `available_actions.yaml` seeded a guaranteed-only product, so its `create_buy_from_product` step (and the whole available-actions enforcement flow that follows) failed with a terminal `DELIVERY_MODE_NOT_SUPPORTED` for sellers that declare only `specialisms: ["sales-non-guaranteed"]`. The `allowed_actions` behavior the scenario actually grades is delivery-type-agnostic, so the fixture is switched to `non_guaranteed` (floor-priced) — the same fix applied to the base `media_buy_seller` flow. The packaged `dist/compliance/` cache is generated from this source.

- 918c073: Runner output contract: document the branch-set `any_of` peer cascade exemption. `cascade_rules` now names a `branch_set_cascade_exemption` (parallel to `sole_stateful_step_exemption`) stating that a stateful peer's genuine failure or `peer_branch_taken` skip MUST NOT cascade `prerequisite_failed` onto a sibling phase sharing the same `branch_set.id` under `any_of` semantics — the peers are mutually-exclusive alternatives, not a dependency chain. The exemption is scoped to `any_of`, is N-ary-safe (any number of peers), leaves cross-set and within-phase cascade unchanged, and is explicitly `depends_on`-agnostic (it fires whether the sibling's dependency is the implicit default or an explicit `depends_on` naming the peer). `storyboard-schema.yaml`'s `depends_on` section gains a cross-reference. Documents-only; codifies the runner behavior shipped in adcp-client#2306 (closing adcp-client#2305), root-caused in adcp#5337. No schema or wire change.
- 5a7668c: Enforce `cancellation_fee.rate` / `.amount` by fee `type` in `cancellation-policy.json`. Both fields are documented as conditionally required — `rate` "Required when type is 'percent_remaining'", `amount` "Required when type is 'fixed_fee'" — and the requirement is restated in the pricing-models reference, but `cancellation_fee` listed only `["type"]` in `required[]`. A validator therefore accepted `{ "type": "percent_remaining" }` (or `{ "type": "fixed_fee" }`) with no fee value at all, leaving a money-path term that declares nothing computable for a buyer accepting the product's cancellation terms.

  Adds `if/then` conditionals: `percent_remaining` requires `rate`, `fixed_fee` requires `amount`; `full_commitment` and `none` are unaffected. No prose change — this aligns the schema with the already-documented contract, and no existing example regresses (both doc examples already carry `rate`). Regression coverage added to `tests/composed-schema-validation.test.cjs`.

- 4eda22a: Clarify the boundary between `validate_input` manifest preflight and `sync_creatives` dry-run trafficking rehearsal.
- 19a6447: Move stale active-window dates in compliance fixtures and 3.0 compatibility bundles forward so storyboard runs continue to exercise protocol behavior instead of calendar drift.
- f38101a: Replace phantom error codes in creative and campaign-governance task docs with canonical enum members. `sync_creatives`, `build_creative`, the Creative Protocol specification, `check_governance`, and `sync_plans` documented 13 `errors[].code` values that do not exist in `enums/error-code.json` (`INVALID_FORMAT`, `ASSET_PROCESSING_FAILED`, `BRAND_SAFETY_VIOLATION`, `FORMAT_MISMATCH`, `CREATIVE_IN_ACTIVE_DELIVERY`, `ASSET_MISSING`, `ASSET_INVALID`, `GENERATION_FAILED`, `INVALID_MANIFEST`, `AMBIGUOUS_CHECK_TYPE`, `SELLER_NOT_RECOGNIZED`, `INVALID_PLAN`, `BUDGET_BELOW_COMMITTED`). SDKs that validate `errors[].code` against the published enum reject responses built from the docs literally, the same failure mode as #4852 and #5307. Each phantom is remapped to the existing code with matching semantics (`UNSUPPORTED_FEATURE`, `VALIDATION_ERROR`, `CREATIVE_REJECTED`, `INVALID_STATE`, `INVALID_REQUEST`, `PERMISSION_DENIED`); `GENERATION_FAILED` is replaced with guidance that generation-pipeline failures surface as task-level failure with the most specific applicable canonical code, per the open-vocabulary rule on `error-code.json`. Also fixes the one live `INVALID_FORMAT` emission in the training-agent reference implementation. Docs and reference implementation only; no wire change.
- c8f3ba5: Fix false failures in creative compliance storyboards (canonical_supported_formats, evaluator_auth).

  `canonical_supported_formats`: removes the hardcoded `capability_id: "training_image_generation"` assertion (capability_id is agent-local; any valid value must pass) and the `field_absent` check on `supported_formats[1]` (agents may advertise multiple canonical formats). Fixes `context_outputs` field name from `key:` to `name:`.

  `evaluator_auth`: adds `requires_capability` guards to all five optional phases so agents that correctly declare `creative.supports_evaluator: false` receive `not_applicable` instead of failing the evaluator track. Guards evaluate against the raw capabilities response, bypassing a runner-side boolean-false accumulator bug. Fixes `context_outputs` field name from `key:` to `name:`.

- c68d545: Fix a misleading `get_media_buy_delivery` example that implied buyers can look up delivery by their own reference. `media_buy_ids` are seller-assigned; the top-level `buyer_ref` field was removed in 3.0.0. The example is retitled "Correlating Your Own Reference", uses seller-assigned `mb_...` IDs, and adds a note pointing buyers to reconcile their own reference via `context` echoed on `create_media_buy` / `get_media_buys`.
- 0a51bac: Align idempotency and rate-limit guidance with the canonical top-level `error.retry_after` field across schemas, documentation, and compliance storyboards.
- a335070: Clarify and enforce governed signal activation: `activate_signal` now documents `governance_context`, signal agents fail closed on governed accounts without a valid approval context, and signal governance compliance checks no longer require the signals tenant to own `sync_plans`.
- 24a83c5: Allow governance checks to accept human approval from `ext.human_approval` and use that approval to clear reallocation-threshold human review.
- 348ae53: Preserve withdrawn and unpublished release status when generating file-based schema discovery so exact artifacts remain available without becoming stable alias targets.
- a81067a: Remove an incidental video-only constraint from the inventory list targeting storyboards so single-channel sellers can exercise the channel-agnostic scenarios.

## 3.1.4

### Patch Changes

- ce93f1f: Publish 3.1.4 as the corrective successor to withdrawn 3.1.3. This restores the supported 3.1 schema and training-agent behavior to the 3.1.2 contract by removing the patch-ineligible `get_products.filters.publisher_domain` field and its incorrect plural-selector implementation. Exact 3.1.3 artifacts remain available as an immutable withdrawn release record.

## 3.1.3

### Patch Changes

- 0bfeb6a: Add `publisher_domain` filter to `get_products`: buyers can now filter products by publisher domain, returning only products whose `publisher_properties` include an exact match for the specified domain. The training agent enforces this filter at runtime, and the schema documents the expected matching semantics (exact match, no subdomain expansion).

## 3.1.2

### Patch Changes

- 49825ba: Allow `null` for video-only delivery metrics (`quartile_data`, `completion_rate`). Sellers running non-video inventory (display, audio-only, DOOH-without-video) legitimately have no value for these metrics, and returning `null` is the correct "not applicable" signal. The schema previously required `type: "number"` / `type: "object"` and rejected `null`, causing receivers to fail validation on every valid display-inventory delivery report.

  `delivery-metrics.json` (`totals` / `by_package[]`) now accepts `["number", "null"]` for `completion_rate` and `["object", "null"]` for `quartile_data`; `get-media-buy-delivery-response.json` `aggregated_totals.completion_rate` gets the same loosening so the aggregate path can't re-trigger the failure. The `minimum`/`maximum` constraints on `completion_rate` still apply to non-null values, and the type stays narrowed to null (no strings/arrays). Every other delivery metric continues to signal "not applicable" by omission, not `null` — this exception is scoped to the two video-only fields. Spec-loosening for the receiver contract: producers already sending numbers/objects remain valid.

  The separate inline `completion_rate` in `report-plan-outcome-request.json` (a governance self-report block, not on the `get_media_buy_delivery` path) is intentionally left unchanged.

- 420d1e8: Move stale active-window dates in compliance fixtures and 3.0 compatibility bundles forward so storyboard runs continue to exercise protocol behavior instead of calendar drift.
- da636b4: Clarify and enforce governed signal activation: `activate_signal` now documents `governance_context`, signal agents fail closed on governed accounts without a valid approval context, and signal governance compliance checks no longer require the signals tenant to own `sync_plans`.
- 420d1e8: Allow governance checks to accept human approval from `ext.human_approval` and use that approval to clear reallocation-threshold human review.

## 3.1.1

### Patch Changes

- 1a18bbe: Add `media_buy.governance_aware` capability to `get-adcp-capabilities-response` and gate the `governance_denied` / `governance_denied_recovery` storyboards on it, so sellers without outbound governance consultation grade `not_applicable` instead of false-failing on a `GOVERNANCE_DENIED` they cannot produce. Addresses #5665 (Option A).
- 1a18bbe: Clarify broadcast product/reporting ownership, correct the broadcast compliance channel fixture to `linear_tv`, and document that scheduled broadcast buys should not be modeled as `non_guaranteed` solely because third-party audience measurement settles later.
- 1a18bbe: Fix hosted compliance auth defaults so static fixture API keys are only inferred for fixture-backed runs, align the async media-buy submitted-state fixture account with the create request, and mark governance-denial storyboards as multi-agent scenarios routed through seller and governance agents.
- 1a18bbe: Clarify that `get_products` pagination is valid in all buying modes, with `brief` and `refine` pagination bounding returned `products[]` in curated results while `wholesale` pagination walks the product feed. Add conformance coverage for the deterministic wholesale cursor walk without treating brief/refine as exhaustive catalog enumeration.
- 1a18bbe: Add stable schema discovery pointers at `/schemas/index.json` and `/schemas/latest.json`, mark prerelease schema directories in root discovery metadata, and keep major/minor schema aliases pointed at stable releases.
- 1a18bbe: Apply residual prose cleanups to the `sponsored_context_accountability` storyboard: the `prerequisites.description` second paragraph and the `si_send_message_presentation_accepted` step narrative both still implied dynamic host-echo / different-identity substitution, contradicting the fixed Acme literal fixture the storyboard actually uses. Reword both spots to scope the prose to the static Acme fixture per @bokelley's #5551 review (2026-06-17 13:15 UTC).
- 1a18bbe: TMP: provider-scoped TMPX macro trafficking with declared macro names + multi-chunk support. Builds on the `tmpx_providers` map shipped in #5689; reframes the contract to communicate exact macro/value pairs (not provider_id→token strings) and supports values that exceed a single ad-server macro slot.

  Provider registrations declare a stable, provider-namespaced list of ad-server macro names in `tmpx_macros` (e.g. `["PIN_TMPX_1", "PIN_TMPX_2"]`) — the names the publisher actually trafficks in GAM / VAST URLs / DOOH play logs. The identity-agent response emits `tmpx_macros[]` as ordered `{name, value}` pairs filling those slots. The router merges per-provider into `tmpx_providers: { provider_id: { macros: [{name, value}] } }` on the response so the publisher walks each provider's pairs and substitutes each `value` verbatim into the slot named by `name`. Multi-chunk values are capped at 2 per provider in v1; the cap MAY rise without a shape change. Macro names MUST NOT be derived from `provider_id` at runtime — trafficking is configured against the registered names ahead of time.

  **Breaking change to an experimental surface (sanctioned by `x-status: experimental`)**: `tmpx_providers` was introduced in #5689 as `Map<provider_id, string>` (opaque token per provider). It is reshaped here to `Map<provider_id, {macros: [TmpxMacro]}>`. Consumers that adopted the v1 shape between #5689 and this change MUST migrate to read each provider's `macros[*].value` rather than a single string. The legacy singular `tmpx` field remains supported through 3.x (removed in 4.0).

  **Experimental notice window.** `docs/reference/experimental-status.mdx` recommends ~6 weeks of published notice before a breaking change to an experimental surface. `tmpx_providers` shipped in #5689 days ago, so the literal 6-week window can't apply here; in practice nobody could have adopted a field that didn't exist 6 weeks ago, so the risk is bounded. Adopters of the v1 shape (if any) should consult this changeset's migration sketch and pin to the latest schema release before deploying.

  **Dual-shape alias waiver.** The experimental policy asks for an alias accepting both the old (`Map<provider_id, string>`) and new (`Map<provider_id, {macros: [TmpxMacro]}>`) forms "where feasible" — typically via a `oneOf` on `additionalProperties` during transition. Skipped here because the v1 shape is hours old and the surface is `x-status: experimental`; the dual-shape carrying cost (validator complexity, ambiguous consumer code paths, perpetual deprecation tail) outweighs the migration cost for a window where the field had no realistic adopters. Routers that want belt-and-suspenders compatibility for any caller that did read the v1 shape MAY mirror one provider's first-slot `value` into the deprecated singular `tmpx` field; that path is already specified.

  Schema updates: `tmp/provider-registration.json` adds `tmpx_macros`; `tmp/identity-match-response.json` adds `tmpx_macros` (provider-side) and reshapes `tmpx_providers` (router-merged), plus a shared `TmpxMacro` definition. Spec narrative: IdentityMatchResponse and Provider Registration field tables surface the new fields and the reshape; `§Inventory-specific behavior` walks the per-macro substitution flow; `§Identity Match fan-out` in router-architecture.mdx gets a rewritten normative TMPX-collection paragraph.

- 1a18bbe: Rename the canonical Trusted Match schema source directory from `tmp` to `trusted-match`, update registry references and examples to the self-describing path, and add schema discovery metadata for protocol layers plus prerelease supersession. Hosted schema routing keeps legacy `/schemas/{version}/tmp/...` URLs working by falling back to the canonical `trusted-match` files when a historical `tmp` artifact is not present.

## 3.1.0

### Minor Changes

- e6cd62c: Creative retention contract (#2260): creatives outlast campaigns, with mandatory state-change signalling.

  Resolves the 3.0 ambiguity in `docs/creative/creative-libraries.mdx` ("Retention of unassigned creatives is seller-defined") without mandating a numeric retention floor that no industry platform publishes uniformly (GAM is indefinite; Meta ~37 months; FreeWheel 25 months; most others publish nothing). The protocol surface buyers actually need is observability of state changes, not a fixed number.

  **Library lifecycle is independent of buy lifecycle.** A creative MUST persist in the library regardless of the status of the buys that referenced it. Buy rejection, cancellation, or completion releases assignments only. This holds for `sync_creatives`, inline creatives on `create_media_buy`, and platform-native uploads — no carve-out by submission path, and no carve-out by creative composition (assets, brief, brand+catalog pointers, or any combination).

  **State changes are observable.** When a seller archives an unassigned creative, expires it for inactivity, or revokes a previously-approved creative, the seller MUST make the new state observable. For creatives with active assignments the signal is an `impairment` on the buy (existing mechanism from the dependency-impact cluster). For creatives with no active assignments the conformant signal today is the `status` value visible on the next `list_creatives` read — consistent with the [snapshot-and-log contract](docs/protocol/snapshot-and-log.mdx) which already names `list_creatives` as the reliable signal for resource-state changes outside an active buy. A push channel for account-scoped creative state changes is being defined under #2261; once that channel ships, sellers SHOULD additionally fire on it.

  **Library can be a view, not a separate store.** Sellers whose underlying ad server has no library object distinct from per-buy attachment (some CTV/podcast stacks) satisfy "creatives outlast campaigns" by exposing the buyer-synced creative through `list_creatives` for the buy's lifetime and continuing to expose its terminal state after teardown.

  **`creative/specification.mdx` state machine** updated to add an `approved → archived` (seller-initiated) edge, scoped to creatives without active package assignments. Sellers MUST NOT seller-archive a creative with active assignments — the existing `approved → rejected` (revocation) path with an `impairment` on the affected buy is the only conformant route when active serving is involved. The state-machine diagram and rule list both reflect the new edge.

  **`creative-status.json` `archived` enumDescription** widened to acknowledge that archive can be buyer- or seller-initiated, to constrain seller-initiated archive to creatives without active assignments, and to pin the conformant signal to `list_creatives` until the push channel ships. No new enum values; no new fields. Additive description-only change.

  Variant addressability — whether a format's rendered outputs (PMax-style fan-out, `responsive_creative`, `agent_placement`) carry per-variant IDs — is a format-level concern, handled in RFC #3305 / #3307, not a library-retention concern.

  Closes #2260. Refs #2261 (webhook mechanics), #2254 (parent media-buy lifecycle issue, already closed), #3305 / #3307 (format-level variant addressability).

- c54c0d5: Creative-lifecycle webhooks (#2261) lands **#4582 track 3** (per-account subscription model) by making `sync_accounts` the universal account-state write surface — no new tool. Governance and notifications are separate concerns: `sync_governance` remains governance-only; `sync_accounts` carries `notification_configs[]` for webhook subscribers.

  **Events**

  - `creative.status_changed` — fires on every seller- or system-initiated status transition: `processing → rejected`, `pending_review → approved`/`rejected`, `approved → pending_review` (re-review), `approved → rejected` (post-approval revocation), `approved → archived` (seller-initiated). Buyer-initiated transitions do NOT fire — acknowledged on the `sync_creatives` response path. Payload: `creative/creative-status-changed-webhook.json`. `transition.from` is narrowed to `{processing, pending_review, approved}` — post-terminal states never appear there.
  - `creative.purged` — fires when a creative is destroyed (retention, takedown, advertiser request, legal erasure, account closure). Soft purges retain a tombstone on `list_creatives` for 30 days; hard purges leave no record (sanctioned Rule 4 carve-out for legal erasure). No coalescence permitted. Payload: `creative/creative-purged-webhook.json`.

  **Subscription model — `sync_accounts` polymorphic key**

  `sync_accounts` now supports two modes via `oneOf` on each per-account entry:

  - **Provisioning mode** — flat `brand` + `operator` + `billing` (today's shape, unchanged). Implicit-account sellers provision/upsert.
  - **Settings-update mode** — `account` (AccountRef) keyed by `account_id` (explicit) or natural key (implicit). No provisioning side effects. Sellers that don't implement either mode reject with `UNSUPPORTED_PROVISIONING`. Explicit-account sellers (DV360-class) gain a single focused write surface for account-level settings.

  Both modes accept `notification_configs[]` (replace semantics — omit to leave unchanged, `[]` to remove all). Each entry has:

  - `subscriber_id` (required, unique per account — no conditional required-when-multiple rules)
  - `url`, `event_types[]`, optional legacy `authentication`, `active`
  - Sellers MUST reject `event_types[]` containing media-buy-anchored types (forward rule: "any type whose contract anchors at a media buy or below")

  `list_accounts` echoes `notification_configs[]` per account with credentials redacted (write-only).

  **Governance unchanged**

  `sync_governance` keeps its original surface and scope. Governance agents are **not** implicitly subscribed to webhooks. A governance team that wants creative-lifecycle fires registers its URL as a separate `notification_configs[]` entry on `sync_accounts` — explicit, auditable, filterable via `event_types[]`. No foot-gun where governance endpoints get force-fed signals they aren't built to ingest.

  **Self-serve buyers**

  A buyer who wants webhooks but no governance: just `sync_accounts`. Never touches `sync_governance`. The two surfaces are independent.

  **New schemas**

  - `core/notification-config.json` — per-subscriber config. `subscriber_id` always required, `additionalProperties: false`, `ext` for extensions.
  - `core/account.notification_configs[]` — read-side echo on the account record.
  - `enums/creative-event-reason-code.json` — 13 categorical values distinct from `impairment-reason-code`: `review_passed`, `review_failure`, `processing_failure`, `seller_rereview`, `policy_revocation`, `content_drift`, `takedown_request`, `advertiser_request`, `seller_archive` (folds prior `inactivity_archive` + `storage_policy`), `account_closed`, `account_suspended`, `retention_expired` (soft only), `legal_erasure` (hard only). Each value's enumDescription documents buyer remediation; `policy_revocation` vs `content_drift` carries an explicit "when in doubt" rule.
  - `notification-type.json` extended with `creative.status_changed` and `creative.purged`, plus a "media-buy-anchored vs account-anchored" framing for future additions.

  **Read surface (#4701 track 4 adoption)**

  `list_creatives` adopts the 7-item `webhook_activity[]` checklist:

  - `include_purged: true` returns soft-purged tombstones as a wrapped `purge: { kind, at, reason_code }` block — co-presence enforced by schema, not prose. `status` is frozen pre-purge.
  - `include_webhook_activity: true` + `webhook_activity_limit` (1–200) return per-creative `webhook_activity[]` records. Items `$ref` the canonical `webhook-activity-record` shape from #4701; `notification_type` discriminates status changes vs purges.

  **Pairing with #4588 impairments**

  When a creative transition breaks active serving (`approved → rejected`), the seller already MUST surface a corresponding `impairment` on every media buy referencing the creative (per #4588's `impairment.coherence`). The two signals are paired but distinct — buyers correlate by `creative_id`. **No ordering guarantee between the two fires** — explicitly documented; reconcile via the snapshot.

  **Retroactive contract**

  When a seller declares support via `get_adcp_capabilities`, the obligation covers all creatives in the library — no grace period.

  **Docs**

  - `docs/accounts/tasks/sync_accounts.mdx` — new § "Two modes: provisioning vs. settings-update" and § "Account-level webhook subscriptions"
  - `docs/accounts/tasks/list_accounts.mdx` — `notification_configs` response field documented
  - `docs/creative/specification.mdx § Lifecycle webhooks` — state machine + events; supersedes previous SHOULD language; no-ordering note
  - `docs/creative/task-reference/list_creatives.mdx` — § Purged tombstones (with `purge` wrapper), § Webhook activity, § Buyer handler (end-to-end example: verify → dedupe → re-read)
  - `docs/protocol/snapshot-and-log.mdx` — account-level adopters section + Rule 4 carve-out for hard purges

  Closes #2261. Lands #4582 track 3.

- a8aa0ab: spec(media-buy): billing authority + finality flags on both reporting surfaces (closes #2391 for 3.1; dispute task deferred to 3.2).

  Closes part 1 of #2391 — the prerequisite to a structured dispute task. A buyer reading the 3.1 spec can now answer "where do I look for the billing-grade number, and has it stopped moving?" without any new tasks: existing `measurement_terms.billing_measurement` already names the authoritative party; new finality flags on both reporting surfaces mark when numbers are closed for invoicing.

  Changes:

  - `static/schemas/source/media-buy/get-media-buy-delivery-response.json` — add row-level `is_final` and `finalized_at` on `media_buy_deliveries[*]` (alongside existing per-package `is_final`); add `finalized_at` on each `by_package[*]` entry next to existing `is_final`. Row-level finality is equivalent to all packages being final for the same `measurement_window`.
  - `static/schemas/source/account/report-usage-request.json` — add `final` (default true on absence), `finalized_at` (present iff `final: true`), and `measurement_window` to each usage record. Symmetric with seller-side delivery rows. Description updated to acknowledge sales-agent receivers for buyer-attested / vendor-attested reconciliation.
  - `static/schemas/source/core/measurement-terms.json` — add optional `finalization_deadline_hours` on `billing_measurement`. When the authoritative party misses the deadline, the seller MAY fall back to seller-attested numbers and the breach is handled under `makegood_policy`.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — replace the "AdCP 3.0 does not specify a structured dispute task" paragraph with normative "Final vs provisional" + "Who is authoritative for billing" sections; point at the new advanced-topics page; flag dispute task for 3.2.
  - `docs/media-buy/advanced-topics/billing-authority.mdx` — new normative page tying the pieces together with worked examples (seller-attested, buyer-3PAS, vendor-attested Nielsen).
  - `docs.json` — register the new page under media-buy → Concepts.

  Strictly additive — no existing fields change shape, no required-field additions. Agents that don't emit `is_final`/`final`/`finalized_at` remain spec-valid; the absent semantics match the 3.0 baseline.

  A 3.2 issue tracks the structured dispute task that builds on this foundation.

- f8b51e4: spec(media-buy): extend three-shape submitted envelope to `sync_audiences`.

  PR #2434 established the three-shape (`success | error | submitted`) response pattern on `sync_creatives` for operations whose ingestion may be queued before per-item results can be returned. `sync_audiences` is the next natural fit — audience matching is classically asynchronous (`capabilities.audience_targeting.matching_latency_hours` already declares it), and sellers whose pipeline batches ingestion, gates the upload behind governance review, or routes through an upstream clean-room cannot return the per-audience `audiences` array before the response is emitted.

  `SyncAudiencesSubmitted` mirrors `SyncCreativesSubmitted` exactly: top-level `status: "submitted"` + `task_id`, optional `message`, optional advisory `errors[]`, no `audiences` array on the envelope. The synchronous success branch is tightened with the same triple-`not` guard (`errors`, `task_id`, `status: submitted`) so the three shapes are unambiguously mutually exclusive — preserving the structural parser invariant from adcp-client#649 across all three-shape `sync_*` responses.

  This is purely additive on the success/error arms — per-audience asynchronous matching (an audience reported with `status: "processing"` while the rest of the sync resolves synchronously) continues to belong on the synchronous success branch via the existing `audience-status` enum; the submitted envelope is the less-common operation-level async case.

  Files:

  - `static/schemas/source/media-buy/sync-audiences-response.json` — third `SyncAudiencesSubmitted` arm; success/error arms tightened to forbid `task_id` / `status: submitted` so the discriminated union is mutually exclusive.
  - `docs/media-buy/task-reference/sync_audiences.mdx` — `## Response shapes` documents the three branches; quick-start examples updated to discriminate `submitted` before reading `audiences`; new `## Async patterns` section names the per-audience-async vs operation-level-async distinction.
  - `scripts/oneof-discriminators.baseline.json` — variant count bumped to 3.

  `sync_accounts` and `sync_event_sources` were considered for the same treatment and deliberately left synchronous:

  - `sync_accounts` — per-item `action` + `status` already cover the realistic async-of-records cases; no operation-level async pattern needed.
  - `sync_event_sources` — deferred pending implementer input on whether seller-side validation of stream endpoints is a real latency source (filed as a follow-up RFC).

  Closes #2435.

- cb21c9d: feat(training-agent): emit compact JWS governance_context with required plan_hash

  The training agent now signs the `governance_context` it returns from `check_governance` per the [AdCP JWS profile](/docs/building/by-layer/L1/security#adcp-jws-profile), replacing the opaque UUID it previously emitted. Closes #2475.

  **What's signed**

  - Compact JWS with `alg: EdDSA`, `typ: adcp-gov+jws`, and a `kid` published on the aggregated `/.well-known/brand.json` alongside per-tenant transport keys (distinct `kid`, `adcp_use: "governance-signing"`, `use: "sig"`, `key_ops: ["verify"]`).
  - All 13 spec claims emitted: `iss`, `sub`, `aud`, `iat`, `exp`, `jti` (UUID v7), `phase`, `caller`, `check_id`, `media_buy_id` (conditional), `policy_decisions`, `audit_log_pointer`, and the required audit-layer `plan_hash`.
  - Intent tokens expire in 15 minutes; execution-phase (`purchase`/`modification`/`delivery`) in 30 days. Fresh signature on every check — no caching across plan revisions.

  **`plan_hash` canonicalization**

  - `base64url_no_pad(SHA-256(JCS(plan_payload)))` with the closed bookkeeping exclusion list applied in code.
  - Validated bit-exactly against all 11 reference test vectors under `static/compliance/source/test-vectors/plan-hash/`.
  - Per-revision `planAsSupplied` is retained in `revisionHistory` so historical tokens remain auditable after a subsequent `sync_plans` mutates state.

  **Discovery surfaces**

  - `/.well-known/brand.json` now includes the governance-signing JWK.
  - New `/.well-known/governance-revocations.json` — signed (`typ: adcp-gov-revocation+jws`) flattened-JSON, empty by design, memoized on a 60-second cadence to prevent unbounded sign work under DoS.

  **Sandbox-only behavior the spec calls out**

  - `aud` defaults to the training agent's own sales tenant URL when `payload.target_seller` is omitted — every storyboard's downstream `create_media_buy` targets that URL, so the binding is honest for the test loop. Production governance agents MUST require buyer-supplied `target_seller` and refuse to issue without one.
  - When the buyer requests a non-intent phase but omits `media_buy_id`, the token is issued at `phase: intent` rather than emit a structurally-valid-but-step-12-rejected token.
  - Ephemeral Ed25519 keypair per process (same model as webhook-signing). KMS provisioning is the production answer; sandbox cert-track work is unblocked by the ephemeral pair.

  Cert-track learners can now decode the JWS header, inspect the 13 claims, and verify the signature against the published JWKS — the training agent is a usable test-vector source for the JWS profile.

- c382ec0: Dependency-impact cluster (3.1): media-buy `health` + `impairments[]` surface, resource-level offline states across audience/creative/catalog-item/event-source, `impairment` notification_type, and the foundational snapshot/log protocol contract + persistent webhook contract that ties it together. Two expert review cycles incorporated.

  **Media buy health surface** (#2853, #2855, #2856)

  - New `enums/media-buy-health.json` (`ok` | `impaired`, `default: "ok"`) — orthogonal to `media-buy-status`. A paused/pending/active buy can each be impaired without affecting `status`.
  - New `core/impairment.json` — package-scoped dependency state change. Materiality: `package_ids` minItems: 1; MUST-strength for audience/event_source/property (cheap 1:N joins), SHOULD for creative/catalog_item (expensive pool joins). Sellers MAY report conservatively when uncertain; MUST NOT report when serving is provably unaffected.
  - New `enums/impairment-offline-state.json` — canonical offline values (`suspended | rejected | withdrawn | insufficient | depublished`) referenced by `impairment.transition.to`. The `resource_type` ↔ `offline_state` pairing is enforced by `impairment.coherence` (#2859), not at field validation.
  - New `enums/impairment-reason-code.json` — flat shared enum with per-resource-type valid subset documented in enumDescriptions.
  - `core/media-buy.json` adds `health` (with `default: "ok"`) and `impairments[]`. Sellers MUST add/remove entries on next sync after the underlying resource transitions, and the snapshot MUST reflect transitions within 5 minutes of `observed_at` regardless of poll cadence.
  - `enums/notification-type.json` adds `impairment` plus minimal factual enumDescriptions for the four pre-existing values. Webhook payload reuses the `impairment` shape plus the buy's updated `health`.

  **Resource-level offline states** (#2838, #2857, #2858)

  - `enums/audience-status.json` adds `suspended` for seller-initiated offline transitions.
  - `enums/creative-status.json` enumDescriptions clarify `approved → rejected` is a valid post-approval transition.
  - `enums/catalog-item-status.json` adds `withdrawn` for seller-initiated removal — distinct from `rejected` (no buyer-side resubmit path).
  - `core/event-source-health.json` clarifies `insufficient` covers source-offline; disambiguate via `events_received_24h: 0`.
  - Property depublication verified via brand.json / adagents.json; no per-property status field.

  **Webhook foundation** (#4582 tracks 1–2)

  - New `docs/protocol/snapshot-and-log.mdx` — five-rule contract:
    - **Two distinct ids** (idempotency_key per-fire; notification_id per-state-event). Same notification_id under different idempotency_keys = re-emission signal.
    - **Snapshot delta** per push event; no webhook-only state.
    - **At-least-once delivery**; snapshot is authoritative.
    - **Either path is complete** — buyers using webhooks reliably and buyers using only GET get the same data. Holds today for state events; partial for data events (#4590 closes the gap for delivery reporting).
    - **Shared id space** between push and log.
  - `docs/building/by-layer/L3/webhooks.mdx` "Persistent channel contract" — at-least-once, no-ordering, per-event-type coalescence (5min for general impairment, sub-minute for latency-sensitive fraud/brand-safety subclasses), replay-via-snapshot, mutability, auth renewal, termination.
  - `docs/media-buy/media-buys/lifecycle.mdx` documents the `health` surface, materiality coverage, reverse-direction rule, `impairment.coherence` invariant, the operational-vs-commercial non-goal, and a remediation-by-reason_code table.

  Additive across the board: new fields, new enum values, new docs. No breaking changes; safe in a minor release. Buyers that exhaustively switch on `media-buy-status` see no change (no new status value); buyers that read `media-buy.health` see the new dependency-health signal alongside their existing `status` handling.

  Refs #2838, #2853, #2855, #2856, #2857, #2858, #4582. Spin-outs: #4586 (defect signals), #4587 (advisory signals). Follow-ups: #4590 (windowed reporting pulls), #4594 (type notification_id on webhook envelope), #2859 (coherence assertion tooling), #2860 (storyboard).

- c9ca76d: `impairment.coherence` — cross-resource invariant tying `media_buy.impairments[]` to the underlying resource state.

  **Rule (lifecycle.mdx § Compliance — expanded)**

  - **Forward.** Every entry in a buy's `impairments[]` MUST reference a resource whose current status is an offline state (`audience: suspended`, `creative: rejected`, `catalog_item: withdrawn`, `event_source: insufficient`, depublished property). Stale impairments on the buy fail the check.
  - **Inverse.** Any resource in an offline state referenced by a non-terminal buy MUST appear in that buy's `impairments[]`, and the buy's `health` MUST be `impaired` whenever `impairments[]` is non-empty (and `ok` when empty). Stale resources off the buy fail the check.
  - **Out of scope.** Terminal-status buys (`completed`, `canceled`, `rejected`) MAY remain unreported; materiality is schema-enforced via `impairment.json#/properties/package_ids` `minItems: 1` (#2855) and is not re-checked here.

  **Wiring** (`static/compliance/source/specialisms/*/index.yaml`)

  - Added `impairment.coherence` alongside the existing `status.monotonic` invariant on the five specialisms whose storyboards exercise resource transitions that can drive impairments:
    - `audience-sync` — audience `suspended`
    - `sales-catalog-driven` — catalog_item `withdrawn`
    - `creative-ad-server`, `creative-template`, `creative-generative` — creative `rejected`
  - Each specialism's invariants block now carries an inline comment describing the cross-resource rule and the not-applicable grading path until #2860 lands the storyboard exercise.

  **Docs**

  - `docs/media-buy/media-buys/lifecycle.mdx § Compliance` — replaces the two-bullet sketch with the precise forward/inverse rules, out-of-scope carve-outs, and the relationship to `status.monotonic`.
  - `docs/building/verification/compliance-catalog.mdx` — new **Cross-resource invariants** section catalogs `status.monotonic` and `impairment.coherence` with scope and per-specialism applicability.

  Complements `status.monotonic` (single-resource lifecycle observation). Grades `not_applicable` until [#2860](https://github.com/adcontextprotocol/adcp/issues/2860) wires the cross-resource exercise into the relevant specialism storyboards.

  Additive — new invariant on existing specialisms, no breaking changes. Runner support for the `impairment.coherence` invariant ID is the adcp-client follow-up (mirrors the `status.monotonic` rollout pattern from #2664).

  Closes #2859.

- f2364d9: Dependency-impact end-to-end storyboard (`media_buy_seller/dependency_impairment`) — the cross-resource exercise that drives non-NA grading of the `impairment.coherence` invariant ([adcp#2859](https://github.com/adcontextprotocol/adcp/issues/2859)).

  Five phases against the compliance test controller's sandbox:

  1. **setup** — discover a product, create an active media buy, sync a creative with an inline assignment, and force the creative to `approved` for a clean baseline.
  2. **baseline_healthy** — `get_media_buys` MUST report `health: ok` with empty/absent `impairments[]`.
  3. **transition_offline** — `comply_test_controller force_creative_status` flips the creative to `rejected` with a rejection reason.
  4. **verify_impaired** — `get_media_buys` MUST report `health: impaired` with an `impairments[]` entry whose `resource_type: creative`, `resource_id` matches, `package_ids` includes the buy's package, and `transition.to: rejected`. Closes the forward + inverse rules for this transition.
  5. **recover_and_verify** — flips the creative back to `approved` and reads the buy again; `health` MUST return to `ok` and `impairments[]` MUST be empty. Exercises the biconditional both directions — a seller that leaves stale impairments behind fails this phase and the runner invariant.

  Wired into `protocols/media-buy/index.yaml#requires_scenarios` so every media-buy seller storyboard run grades it. Sellers that don't expose `comply_test_controller force_creative_status` grade `not_applicable` rather than fail.

  Creative-track only today. Audience-track and catalog-track variants are follow-ups pending `force_audience_status` / `force_catalog_item_status` support in the compliance test controller.

  Closes #2860.

- 55bf2fa: spec(creative): add `bills_through_adcp` capability + `BILLING_OUT_OF_BAND` error.

  PR #2879 softened the creative-ad-server conformance so ad servers that bill out of band (flat license, SaaS contract, bundled enterprise — CM360 is the canonical case) stay spec-valid without returning `pricing_options`. Two follow-ups close that loop on the wire:

  - `capabilities.creative.bills_through_adcp` (boolean, default false/absent) on the `get_adcp_capabilities` response — a pre-call discriminator so buyer agents can pre-filter creative agents across a portfolio before establishing an account just to probe pricing. When `true`, buyers can expect `pricing_options` on `list_creatives`, `pricing_option_id`/`vendor_cost` on `build_creative`, and `report_usage` that accepts records against the rate card.
  - `BILLING_OUT_OF_BAND` (recovery: terminal) on the error-code enum — the standard code for a per-record `report_usage` rejection where the record is well-formed but the account bills via a non-AdCP channel. Distinct from `BILLING_NOT_SUPPORTED` (media-buy `billing`-value rejection) and `BILLING_NOT_PERMITTED_FOR_AGENT` (per-buyer-agent commercial gate) — signals that the entire billing surface is offline for this account, not that a specific value or caller is rejected. The code itself is the discriminator; no `error.details` shape is defined (mirroring `CONFIGURATION_ERROR`).

  Strictly additive — no existing agents break. Agents that don't declare `bills_through_adcp` remain in the probe-to-discover mode buyers already tolerate. Both follow `held-for-next-minor` / 3.1 on the drift registry.

  Closes #2881, #2882. Builds on #2879.

  Files:

  - `static/schemas/source/protocol/get-adcp-capabilities-response.json` — `bills_through_adcp` added to the `creative` block alongside `has_creative_library` / `supports_generation` / `supports_transformation` / `supports_compliance`.
  - `static/schemas/source/enums/error-code.json` — `BILLING_OUT_OF_BAND` in enum, `enumDescriptions`, and `enumMetadata`.
  - `scripts/error-code-drift-dispositions.json` — `held-for-next-minor` / `3.1` entry.
  - `specs/creative-agent-pricing.md` — pre-account-discovery and capabilities-change sections updated.
  - `static/compliance/source/specialisms/creative-ad-server/index.yaml` — `report_usage` narrative references the standard code (replaces "vendor codes are fine today" placeholder).
  - `docs/protocol/get_adcp_capabilities.mdx` — capability table row + example.

- 4c12454: spec(envelope): normalize MCP envelope serialization (flat root, drop `payload.required`, `context` joins envelope).

  `core/protocol-envelope.json` declared `required: [status, payload]` with `payload` as a nested object, but every shipping SDK (`@adcp/client`) emits the flat MCP shape — envelope fields and body fields as siblings at the root, no nested `payload:` key. Task response schemas like `media-buy/get-products-response.json` declared body fields at the root, not under `payload`. The schema's literal reading contradicted the deployed reality. Two prior triage rounds (2026-04-23, two separate sessions) converged on the same call: ratify the flat-on-the-wire behavior, add `context` as a first-class envelope field distinct from `context_id`, and drop the `payload.required` constraint.

  Going with that resolution:

  - **`payload.required` dropped.** `payload` becomes a documentary grouping construct, NOT a required wire key. The schema's `required:` is now empty (the `not` block rejecting legacy `task_status` / `response_status` stays). Per-transport serialization is normative in `notes`:
    - **MCP**: envelope fields and body fields are siblings at the root of the tool response. No nested `payload:` key. Matches MCP's `structuredContent` convention.
    - **A2A**: envelope fields map to transport-native task metadata (`task.status.state`, `task.contextId`, `task.id`); body fields appear inside `task.artifacts[0].parts[].DataPart` (final) or `task.status.message.parts[].DataPart` (interim).
    - **REST**: envelope fields MAY ride headers or body siblings; body fields appear at the JSON body root.
  - **`context` joins the envelope as a first-class field**, `$ref` to `core/context.json`. Semantically orthogonal to `context_id`:
    - `context_id` — server-managed session identifier.
    - `context` — caller-supplied opaque echo, preserved byte-for-byte by the agent.
    - Both MAY appear on the same response; they are NOT aliases.
  - **`description` rewritten** to lead with the canonical-field-set framing rather than the "wraps the payload" mental model the old text used (which encouraged the nested-`payload` misreading).

  Producer and receiver rules added to `docs/building/by-layer/L0/mcp-guide.mdx` so the wire shape is normative from both ends:

  - MCP tool implementations MUST emit envelope and body fields as flat siblings at root.
  - MCP tool consumers MUST parse from the flat root; receivers MUST NOT require a nested `payload:` key.
  - `context_id` vs `context` distinction surfaced with one-line definitions and the "both may appear" clause.

  Why this resolution over "make nested canonical and migrate `@adcp/client`":

  - The flat shape is what every shipping integrator has parsed against since 3.0 GA. Declaring it non-conformant before any peer SDK ships inverts the codify-deployed-behavior precedent the ecosystem already follows (OpenRTB, prebid, GAM).
  - MCP's native conventions favor flat — `structuredContent` is itself a flat field; nesting `payload:` inside it is ceremonial boilerplate.
  - A2A's transport-native task metadata already carries the envelope fields; nesting `payload:` would force redundant double-wrapping.

  Why `context` joins as a peer of `context_id` rather than a convention:

  - `get-products-response.json:147` already `$ref`s `core/context.json` for per-request echo. The convention is in use; it just never made it into the envelope doc.
  - Splitting on `_id` (session identifier) vs `context` (per-request echo) is the same split A2A makes between `task.contextId` and `task.metadata`; not codifying it leaves the spec less expressive than the transports it runs over.

  Files:

  - `static/schemas/source/core/protocol-envelope.json` — description rewritten; `context` added; `payload` description clarified as documentary grouping; `required: [status, payload]` removed; `notes` array rewritten with normative per-transport serialization.
  - `docs/building/by-layer/L0/mcp-guide.mdx` — `## MCP Response Format` section rewritten with normative producer + receiver rules and the `context_id` / `context` distinction.

  Validation: `composed-schema-validation.test.cjs` (43 tests) passes against the changed envelope. Existing SDKs (`@adcp/client`) remain conformant.

  Closes #2911. Unblocks adcp-client#832 (per-field envelope validation).

- 037e21b: spec(3.1): pre-GA clarifications batch #2 — five spec/docs items.

  Five issues from the 3.1.0 milestone Cluster B + C work, plus four closed as already-shipped on inspection.

  **Shipped in this batch:**

  - **#4453 — `expires_at` optional on `preview-creative-response.json`.** Removed from `required` on all three branches (top-level + nested batch entries + variant branch); description updated to document the non-expiring case. Buyers MUST treat URLs as invalid after `expires_at` when present, MAY assume valid until out-of-band revocation when omitted. Note: AdCP 3.x has no protocol-level revocation signal — buyers requiring expiry guarantees SHOULD require sellers that publish `expires_at`.

  - **#4567 — `account.account_financials` description sharpened as pre-call discriminator.** The field already existed at `protocol/get-adcp-capabilities-response.json:166`; description rewritten to make the buyer's pre-call-discriminator purpose explicit and to surface the companion-pattern relationship with `creative.bills_through_adcp`. No schema change; closing the issue with the rewrite as the answer.

  - **#4578 — Version inference when `get_adcp_capabilities` is absent.** New paragraph in `versioning.mdx` § Bidirectional negotiation: buyers SHOULD infer v2 when the tool itself isn't on the seller's tool list, route through the v2 wire-shape adapter, emit a one-time advisory warning that retry-safety guarantees are unknown. Fail-open by design — failing closed blocks the most common adoption path (sellers that shipped v2 and never implemented v3 discovery). Buyers MUST NOT use absence as a positive v2 conformance signal; idempotency / signed-requests / other v3 trust primitives MUST be treated as unknown and gated at the application layer.

  - **#4584 — `get_creative_delivery` pagination field-name normalization.** Added `total_count` (canonical, matches `PaginationResponse.total_count`) to the inline pagination block; marked `total` as deprecated alias with `deprecated: true`, removed in AdCP 4.0. Sellers populate both identically through 3.x; buyers SHOULD prefer `total_count`. Page-based pagination shape (`limit`/`offset`) retained — full migration to cursor-based `PaginationResponse` is a 4.0 candidate, not a 3.1 minor change. Description on the `pagination` block calls out the divergence and the migration timeline.

  - **#3049 — Canonical rejection-set shape on `errors[].details`.** New SHOULD-level guidance under `core/error.json` `details` description: when reporting a rejected value against a closed accepted set, sellers SHOULD use `details.accepted_values` (array) + optional `details.rejected_value` rather than seller-specific variants observed in the wild (`available`, `allowed`, `accepted_values` at the error root). `details` remains `additionalProperties: true` — pre-3.1 sellers using legacy keys remain conformant. Safety carve-out: sellers MUST NOT enumerate ecosystem-wide accepted sets on a per-caller rejection (turns the error into an enumeration oracle). SDKs SHOULD accept any of the legacy variants and normalize on read; the canonical shape is what 3.1+ adopters should emit.

  - **#4592 — Sponsored Placement adapter-contract docs.** New doc page at `docs/creative/sponsored-placement-adapter-contracts.mdx` documenting the four runtime contract families that ship under the single `sponsored_placement` canonical (Amazon SP buyer-uploaded, Criteo/CitrusAd network-composed, Pinterest/Snap Collection layout-per-impression, generative-per-SKU). Documents the catalog-asset contract, tracking vocabulary, adopter quirks, and experimental-readiness per family. Linked from `canonical-formats.mdx` experimental-canonicals table. Not a spec extension; documents the variability buyers and sellers encounter against the canonical so the evidence-based promotion gate is informed.

  **Closed as already-shipped (no commit needed, will be closed via PR comments):**

  - **#4400** — `start_time`/`end_time` asymmetry. The asymmetry is intentional at the spec level (you can `start` asap; you can't `end` asap — "end asap" means "cancel"). The structured-object form (`{type: "asap"}`) the issue's seller adopted is a non-spec extension; the spec is and remains string-only at `core/start-timing.json`. If WG wants to canonicalize the structured form for forward-extensibility, file an RFC; not a clarification.
  - **#3555** — `pushNotificationConfig.url` port semantics. Already shipped: `core/push-notification-config.json:9-11` description plus `security.mdx:113-119` "Destination port: permissive by default" both exist with the unconstrained-by-default guidance.
  - **#4466** — adagents.json `authorization_type` doc. Already shipped: `docs/governance/property/adagents.mdx:166` reads `*(required)*`.
  - **#4574** — `list_authorized_properties` cleanup (and comment-expanded `list_audiences` / `list_targeting_categories`). Already shipped in main: `get_adcp_capabilities.mdx:957` has the migration section; `whats-new-in-v3.mdx` and `release-notes.mdx` carry the migration tables. The expanded-scope cleanup is implicit — `list_audiences` and `list_targeting_categories` have zero upstream references in `static/schemas/source/` or `static/compliance/source/`.
  - **#4713** — 3.1 version negotiation docs surface. Already shipped in main: `whats-new-in-v3.mdx:346-348` covers version negotiation; `a2a-guide.mdx:912` and `mcp-guide.mdx:825` both updated for the release-precision contract.

  Files:

  - `static/schemas/source/creative/preview-creative-response.json` — `expires_at` optional on three branches, description updated
  - `static/schemas/source/protocol/get-adcp-capabilities-response.json` — `account.account_financials` description sharpened
  - `static/schemas/source/creative/get-creative-delivery-response.json` — `total_count` canonical + `total` deprecated alias
  - `static/schemas/source/core/error.json` — `details` description gains canonical rejection-set shape SHOULD-guidance
  - `docs/reference/versioning.mdx` — new paragraph on absence-of-`get_adcp_capabilities` v2 inference
  - `docs/creative/sponsored-placement-adapter-contracts.mdx` — new doc page (four contract families)
  - `docs/creative/canonical-formats.mdx` — link to the new adapter-contracts page

  Closes #4453, #4567, #4578, #4584, #3049, #4592.
  Closes #4400, #3555, #4466, #4574, #4713 (no code change; see PR comments).

- b1a45e6: spec(3.1): pre-GA clarifications batch #3 — per-format error attribution on `build_creative` + sales-guaranteed submitted-vs-sync contract.

  Two real spec clarifications surfaced during the 3.1 cluster work.

  **#4556 — Per-format error attribution on `BuildCreativeError`.** The multi-format `build_creative` contract is **atomic** (already documented on `BuildCreativeMultiSuccess`: "all formats must succeed or the entire request fails") — so the issue's framing of "partial success with some manifests + some errors" is non-conformant. What the spec was missing is the per-format attribution convention on the error response, so buyers can identify _which_ format(s) caused the batch to fail and retry only the failing subset. Added normative guidance on `BuildCreativeError.errors[]`:

  - `error.field` carries `target_format_ids[N]` (zero-based index) — required when the error is format-scoped, mirrors the JSONPath-lite convention used elsewhere
  - `error.details.format_id` carries the resolved `format_id` value — required when the error is format-scoped, lets buyers dispatch on format identity without re-parsing `field`
  - Whole-batch errors (auth, governance denial, transport-level) MAY omit both
  - Sellers SHOULD emit one error per failing format rather than collapsing — keeps per-format recovery routing unambiguous
  - Per-format `correctable` errors are scoped to the named format only; buyers may retry just that format with corrected input

  This is the spec-level diagnostic surface for the agentic self-correction loop the issue identifies — the atomicity rule stays, but buyers no longer have to retry the whole batch to figure out which format failed.

  **#3822 — Sales-guaranteed submitted-vs-sync contract.** The skill ↔ storyboard contradiction surfaced during matrix-blind fixture runs: an SDK skill in adcp-client (`build-seller-agent`) instructed sales-guaranteed agents to return a task envelope for every `create_media_buy`. The `sales_guaranteed` compliance storyboard runs **multiple** create_media_buy paths and only one expects `submitted` — four shared scenarios (measurement_terms_rejected, pending_creatives_to_start, inventory_list_targeting, invalid_transitions) expect synchronous `media_buy_id` returns against the non-guaranteed fixture products listed first in the storyboard. A blind agent following the skill fails 5 of 5 grader steps.

  Resolution at the spec layer: added a `### When to return Submitted vs synchronous Success (normative)` section to `docs/media-buy/task-reference/create_media_buy.mdx` documenting that the choice is **per-call**, driven by per-product `delivery_type` + the seller's `requires_io_approval` capability — not a uniform per-seller rule. Conformant SDK skills MUST NOT instruct agents to return `submitted` for every `create_media_buy` regardless of input. Cross-references the `sales-guaranteed` specialism storyboard fixture pattern (non-guaranteed products listed first so open-brief `get_products` calls resolve to synchronous-create paths). Names the issue explicitly so future readers / future SDK skill audits land on the correct contract.

  The SDK skill itself lives in adcp-client and will need a follow-up fix there; this PR closes the spec-side ambiguity that allowed the bad skill to ship.

  Files:

  - `static/schemas/source/media-buy/build-creative-response.json` — `BuildCreativeError` description + `errors` field gain per-format attribution convention
  - `docs/media-buy/task-reference/create_media_buy.mdx` — new "When to return Submitted vs synchronous Success" section after the Submitted Response shape

  Closes #4556. Refs #3822 (spec-side resolution; SDK-side skill fix tracked in adcp-client).

- c2a8855: Grader: webhook-emission universal now fails agents that haven't published a 9421 webhook-signing JWKS at their `brand.json` `agents[].jwks_uri`. The `signature_validity` phase is required (no longer `optional` / `skip_if hmac_legacy`), and a new `signing_keys_published` precheck phase asserts the JWKS contains a key with `adcp_use: "webhook-signing"` before the signature phase runs. Closes the on-ramp loophole that previously let agents self-declare themselves out of webhook signing via `webhook_auth_mode == 'hmac_legacy'`. Operationalizes the "no new HMAC implementers after date X" enforcement from the RFC 9421 migration plan (#4205).

  New error codes on `signing_keys_published`: `webhook_signing_keys_unpublished` (no JWKS or empty), `webhook_signing_keys_wrong_purpose` (JWKS present but no key with `adcp_use: "webhook-signing"`), `webhook_signing_keys_all_revoked` (all webhook-signing keys revoked).

  Refs #3360, #4205.

- 64ca807: MCP webhook `operation_id` is now the canonical, normative correlation identifier; URL-path parsing is forbidden ([adcp#3554](https://github.com/adcontextprotocol/adcp/issues/3554)).

  Two ambiguities in 3.0 made cross-implementation interop fragile:

  1. The `mcp-webhook-payload.json` description told publishers to "echo" `operation_id` back from the URL but never specified the URL-extraction convention (path segment? query parameter? template?), and the field was not in `required` — so a conformant publisher could legally omit it.
  2. `docs/building/by-layer/L0/mcp-guide.mdx` marked `task_type` and `operation_id` as **deprecated** in favor of URL-path routing, directly contradicting `webhooks.mdx` (which correctly told receivers not to parse the URL) and the actual server implementation.

  Resolution — every comparable async-notification protocol in ad tech (OpenRTB `nurl`/`burl`, VAST tracking pixels, A2A `PushNotificationConfig`) makes the URL opaque to the entity firing the HTTP call; AdCP now matches that precedent.

  **Normative wire contract:**

  - `operation_id` is now **required** in `mcp-webhook-payload.json`.
  - `push-notification-config.json` gains an optional `operation_id` field as the canonical buyer→seller registration channel. Sellers MAY reject registrations without it via `INVALID_REQUEST`.
  - Buyers SHOULD supply `operation_id` via `push_notification_config.operation_id` and SHOULD generate a unique value per task invocation. Buyers MAY additionally embed the same value in the URL path or query as a routing aid for their own HTTP server.
  - Sellers MUST echo the buyer-supplied `operation_id` verbatim into every webhook payload. Sellers MUST NOT derive `operation_id` by parsing the URL; the URL structure is implementation-defined and opaque to the seller.
  - Receivers MUST correlate webhooks using the payload field, never URL-path inspection. Buyer-side URL conventions (path templates, query parameters, opaque tokens) are routing aids for the buyer's HTTP server only.

  Updated alongside:

  - `docs/building/by-layer/L3/webhooks.mdx#operation-ids-and-url-templates` carries the full normative wire contract.
  - `docs/building/by-layer/L0/mcp-guide.mdx` field-listing updated; broken `#best-practice-url-based-routing` anchor removed; deprecated-fields framing replaced with the canonical position.
  - `docs/building/by-layer/L0/a2a-guide.mdx` "URL-Based Routing" best-practice section rewritten — A2A receivers correlate the same way as MCP receivers (payload field, never URL parsing). Closes the cross-protocol consistency gap a contributor would otherwise hit when reading the two L0 guides side-by-side.
  - Training-agent webhook emitter (`server/src/training-agent/webhooks.ts`) extracts the buyer-supplied `operation_id` from `push_notification_config.operation_id` and echoes it on the wire, with `task_id` as a fallback when the buyer didn't supply one. The seller-side principal-scoped string (used to key the idempotency-key store) is renamed `deriveWebhookIdempotencyScope` and is never placed on the wire.
  - Test vectors at `static/test-vectors/webhook-payload-extraction.json` updated to satisfy the tightened payload schema.

  Closes #3554.

- 64ca807: `pushNotificationConfig.url` port semantics: declare unconstrained by default ([adcp#3555](https://github.com/adcontextprotocol/adcp/issues/3555)).

  The 3.0 spec was silent on whether publishers may restrict destination ports on buyer-supplied webhook URLs, leaving SDK authors to choose between two bad defaults: lock to `{443, 8443}` (silently rejects buyers on Tomcat `:9443`, Spring Boot `:4443`, path-routed multi-tenant gateways) or accept any port (weakens defense-in-depth).

  Resolution — the SSRF guard the protocol relies on is the **IP-range check + DNS-rebinding-resistant connect pin** already defined in `security.mdx#webhook-url-validation-ssrf`, not port filtering. Reserved-range checks cover the realistic threat (smuggling traffic to internal services on `10.0.0.0/8`, `127.0.0.0/8`, `169.254.169.254`); port filtering on top of a routable public IP is a marginal defense whose cost (rejecting conformant buyers) typically exceeds its benefit.

  **Normative position** (now stated in `docs/building/by-layer/L1/security.mdx#destination-port-permissive-by-default`):

  - Publishers SHOULD NOT enforce a destination-port allowlist on counterparty-supplied URLs by default. The URL contract is `format: "uri"` only; the protocol does not constrain ports.
  - Operators who want a hardened destination-port allowlist as defense-in-depth (locked-down enterprise egress) opt in explicitly via SDK or deployment configuration, with `{443, 8443}` as a reasonable hardened-mode starting point.
  - SDKs that ship a `DEFAULT_ALLOWED_PORTS` constant MUST default it to "no restriction" and surface `{443, 8443}` as an opt-in profile, never as a default.
  - Sellers that activate hardened mode MUST document the allowed-port set in their operator-facing documentation.

  Schema description in `push-notification-config.json` updated to point at the security-doc section; normative SHOULD NOT lives in `security.mdx` (the right home for SSRF-class guidance) rather than in the schema description field.

  Surfaced by Python SDK foundation audit on `adcp-client-python#297`, which exports `adcp.signing.DEFAULT_ALLOWED_PORTS = {443, 8443}` as opt-in hardening aligned with this recommendation.

  Closes #3555.

- 4c12454: spec(errors): add `PROPOSAL_NOT_FOUND` to the canonical error catalog.

  Counterpart to existing `PROPOSAL_EXPIRED` (known proposal whose `expires_at` window has passed) and `PROPOSAL_NOT_COMMITTED` (known proposal still in `draft`). `PROPOSAL_NOT_FOUND` covers the third proposal-lifecycle failure mode: the seller doesn't recognize the `proposal_id` at all — never finalized, belongs to a different tenant, or evicted from session cache before consumption.

  Without this code, sellers had to reuse `INVALID_REQUEST` (loses semantics, wrong recovery class) or invent local codes (no cross-SDK consistency). The Python SDK's v1.5 ProposalManager (adcp-client-python#538) was shipping `PROPOSAL_NOT_FOUND` via its `KNOWN_NON_SPEC_CODES` allowlist as a stopgap, same pattern as `CONFIGURATION_ERROR` from #3995.

  Recovery: `correctable` — buyer should re-issue `get_products` with `buying_mode: 'refine'` + `action: 'finalize'` to obtain a current `proposal_id`, then retry `create_media_buy`.

  Files:

  - `static/schemas/source/enums/error-code.json` — code added to `enum`, `enumDescriptions`, and `enumMetadata` (recovery + suggestion) per the three-parallel-structures convention.
  - `scripts/error-code-drift-dispositions.json` — `held-for-next-minor` for target_version `3.1` (PROPOSAL_EXPIRED / PROPOSAL_NOT_COMMITTED are already on 3.0.x; PROPOSAL_NOT_FOUND is the new AHEAD code).
  - `docs/media-buy/task-reference/get_products.mdx`, `docs/media-buy/product-discovery/refinement.mdx`, `docs/building/by-layer/L3/error-handling.mdx`, `docs/building/operating/transport-errors.mdx` — error-table rows alongside `PROPOSAL_EXPIRED`.

  Closes #4043.

- 4c12454: spec(media-buy): clarify finalize-exclusivity and multi-finalize atomicity in `get_products` `refine[]`.

  The 3.0.6 spec allows multiple `refine[]` entries and matches `refinement_applied[]` by position, but was silent on what a seller does when one entry has `action: 'finalize'` and others don't. Two adopting SDKs (`adcp-client`, `adcp-client-python`) settled on "process the first finalize; silently drop the rest" — undocumented, divergent across wrappers, and inconsistent with the existing `proposal_finalize` compliance scenario which keeps refine and finalize on separate steps. The conformance harness couldn't enforce a contract because the spec hadn't picked one.

  Picked **option (a) — finalize is exclusive within `refine[]`** with explicit multi-finalize atomicity:

  - If any entry has `action: 'finalize'`, **all** entries in the array MUST be proposal-scoped finalize entries. Mixing finalize with `include` / `omit` or with request- / product-scoped entries MUST be rejected with `INVALID_REQUEST`.
  - Multi-finalize against different `proposal_id`s in one call is allowed and MUST be **atomic** — all proposals commit or none do; partial commits are non-conformant. Sellers that cannot guarantee atomic multi-proposal commit MUST reject multi-finalize arrays with `INVALID_REQUEST` and name the constraint in `error.message`.
  - No capability flag for multi-finalize — the failure response is the discovery surface, so buyers MUST NOT assume support without a successful first attempt.

  Why (a) over (b) "finalize-with-ordered-refinement" or (c) "implementation-defined":

  - (a) matches the existing `proposal_finalize.yaml` compliance scenario, which already separates refine and finalize into distinct phases (`refine_proposal` has no finalize; `finalize_proposal` has only finalize).
  - (b) introduces ordering + partial-failure semantics across mixed entries, expanding the seller state machine for no buyer-side win (the buyer who wants both can sequence the calls trivially).
  - (c) leaves divergent SDK behavior in the field and is exactly the gap this issue asks to close.

  Files:

  - `static/schemas/source/media-buy/get-products-request.json` — `refine` field description gains the finalize-exclusivity and multi-finalize atomicity contract. `action.finalize` enum description cross-references the array-level rule.
  - `docs/media-buy/product-discovery/refinement.mdx` — new `## Finalize is exclusive within refine[]` section before `## Proposals in refine mode` with ✅/❌ examples and the multi-finalize atomicity contract.

  SDK alignment: `adcp-client`'s `detectFinalizeAction` and `adcp-client-python`'s `detect_finalize_action` should reject mixed arrays at the SDK layer rather than silently dropping non-finalize siblings; tracked separately in those repos.

  Closes #4107.

- 4c12454: spec(media-buy): disambiguate `pending_creatives` status description.

  Sharpens the enum description for `media-buy-status.pending_creatives` to remove the ambiguity raised in #4196 (readers interpreting the name as "waiting for publisher/governance approval" rather than the intended "buyer-side creative submission missing").

  Document, don't rename. The wire churn of renaming the enum value isn't worth the marginal clarity gain — the existing description already named the buyer action, and `pending_X` is a consistent naming convention across the enum (`pending_start` follows the same shape: "phase X is next required", not "X is pending approval"). Renaming would force every downstream SDK, dashboard, storyboard fixture, and seller-side state machine to migrate for what is fundamentally a documentation gap.

  The new description leads with **"Buyer-side action required"**, explicitly contrasts with publisher/governance approval flows ("the seller has already accepted the buy"), and names the convention so readers can apply the same parse to `pending_start` without filing a follow-up issue.

  Closes #4196.

- 4c12454: spec(errors): make `error.code` forward-compatible decoding normative.

  The drift lint shipped in #4221 enforces a strict policy: adding a new code to `error-code.json` is a wire change held to the next minor, because a 3.0.x receiver decoding a 3.1 sender's `error.code` has no contract that says it must accept the unknown value. The closed-enum hazard was prose-level in `error-code.json` ("agents MUST handle unknown codes gracefully by falling back to the recovery classification") but not surfaced as a normative receiver rule in the spec body — strict validators reading `core/error.json` would have rejected unknown codes anyway. `core/error.json` already types `error.code` as `string` (not as a closed enum reference), so the wire was already open at the envelope level; what was missing was the receiver contract that says so explicitly, and the sender contract that says `error.recovery` is the normative carrier across version skew.

  This change makes that explicit:

  - **Receivers MUST decode unknown codes**, recover the recovery class from `error.recovery`, and default to `transient` when `recovery` is absent (matches the manifest's `error_code_policy.default_unknown_recovery`).
  - **Senders MAY emit codes outside the receiver's pinned vocabulary** — newer codes, platform-specific codes — and MUST populate `error.recovery` on every error from 3.1 onward so receivers across version skew can classify reliably.
  - **`error.recovery` is the normative wire carrier**; `enumMetadata.recovery` in `error-code.json` is the documentary mirror for known codes.

    3.0.x policy unchanged — 3.0.x receivers predate this rule, so 3.0.x stays wire-stable for the rest of its support window. From 3.1 onward, future maintenance lines can ship new codes additively (3.1.5 adds a code; 3.1.0 receivers handle it via `error.recovery`) instead of every code being held to the next minor.

  Files:

  - `static/schemas/source/core/error.json` — `error.code` description elevated from "agents MUST handle unknown codes" prose to a wire-level rule pointing at `error-handling.mdx#forward-compatible-decoding-normative`. `error.recovery` description states it as the normative carrier across version skew.
  - `docs/building/by-layer/L3/error-handling.mdx` — new `### Forward-compatible decoding (normative)` section under `## Standard Error Codes` with the full receiver / sender / `error.recovery` contract and the "why this matters" / "3.0.x policy unchanged" carve-outs. Best-practice list item updated to point at the new section.

  Refs #4227. Pairs with #3725 / #3738 (`enumMetadata.recovery`) and #4221 (the drift lint).

- 9d056d3: Buyer-side webhook delivery visibility for AdCP 3.1, landing #4278 alongside #4582 track 4 (standardized log surface). Two new request fields, one new response field, two new shared core schemas, and the canonical pattern documentation that future resources will follow.

  ### Request additions (`get-media-buys-request.json`)

  - `include_webhook_activity` (boolean, default `false`) — when true, each returned media buy MAY include a `webhook_activity` array describing recent reporting and health webhook fires for the calling principal.
  - `webhook_activity_limit` (integer, 1–200, default 50) — per-buy cap on returned records, most-recent first.

  The two request-field names are now the **canonical opt-in convention** for any AdCP resource exposing `webhook_activity[]` (see snapshot-and-log.mdx § Webhook activity log pattern).

  ### Response addition (`get-media-buys-response.json#/properties/media_buys/items`)

  - `webhook_activity[]` — `$ref`s the new canonical record at `/schemas/core/webhook-activity-record.json`.

  ### New shared core schemas (#4582 track 4)

  - **`/schemas/core/webhook-activity-record.json`** — canonical record shape for a single webhook delivery attempt, intended to be `$ref`'d from any resource read that surfaces a `webhook_activity[]` log. Fields: `idempotency_key` (equals the payload's dedup key — no parallel `delivery_id`), `subscriber_id` (reserved for multi-subscriber configurations; precedent #3009), `fired_at`, `completed_at`, `notification_type` (refs the shared notification-type enum; adopters MUST add their types to that registry rather than minting a parallel enum), `sequence_number`, `attempt` (one record per attempt), `status` (`success` / `failed` / `timeout` / `connection_error` / `pending`), `url` (query+fragment stripped, secret-shaped path segments SHOULD be redacted), `http_status_code`, `response_time_ms`, `payload_size_bytes`, `error_message` (server-side classification only — never bodies or headers), and `ext` (resource-specific extension envelope per the standard AdCP pattern). Nullable fields use the draft-07 union-type idiom (`"type": ["string", "null"]` etc.); the spec's `nullable: true` OpenAPI shorthand is not part of draft-07 and is not used. Top-level `additionalProperties: false` — resource-specific extensions go on `ext`, not as ad-hoc top-level fields. This is a **deliberate departure** from the surrounding convention (every other core schema with an `ext` slot uses `additionalProperties: true`) and is the structural enforcement of the "uniform across resources" promise that justifies the hoist; future schema reviewers should not "fix" it back to `true`.
  - **`/schemas/core/truncation-sentinel.json`** — universal AdCP sentinel for fields whose content has been truncated due to a size cap. Shape: `{ "_truncation": { "original_size_bytes": N, "preview": "...", "preview_format": "<open string>" } }`. The leading-underscore `_truncation` key is the discriminator — receivers detect a sentinel by testing `'_truncation' in value`, no redundant boolean. `_truncation.additionalProperties: true` so future revisions can add classification fields without a forward-compat break. `preview_format` is an open string with `text` / `json` / `base64` / `xml` / `html` listed as common values; receivers SHOULD treat unknown values as `text`. The description carries the canonical `oneOf` usage example so the first real consumer doesn't reinvent the discriminator convention. Lands now so future RFCs (notably the `include_webhook_payloads` extension) plug into a shared shape; no field uses it today.

  ### Normative rules (#4582 track 4)

  - **Retention is MUST, not SHOULD.** Sellers that surface `webhook_activity[]` MUST retain records for at least 30 days from each record's `completed_at`. For records still in `pending` status the clock runs from `fired_at` until the attempt terminates and then resets to 30 days from `completed_at` — so retry trails do not age out mid-flight. Sellers that cannot honor the floor MUST omit the field entirely rather than return a shorter window. This gives buyers a single retention guarantee they can build debug tooling against, and gives sellers with thin storage a clean opt-out via the three-state presence semantics rather than per-seller-negotiated floors. Resolves #4278 open question.
  - **Scoping** MUST be calling-principal only even when multiple principals share visibility into the same resource via account-level access.
  - **One record per attempt.** Single-attempt successes appear as a single record with `attempt: 1`; retry trails appear as multiple records sharing `idempotency_key`.
  - **Three-state presence.** Field omitted = seller does not surface (no persistence, OR capability surface excludes the relevant webhook channel, OR no registered endpoint for the principal); `[]` = persists but no recent fires; non-empty = actual records. Sellers MUST NOT collapse states.
  - **URL privacy.** Query string and fragment MUST be stripped. Sellers SHOULD redact path segments matching obvious secret patterns (high-entropy random material, UUID / token shapes).
  - **`error_message` privacy.** Server-side classification string only — never request headers, response bodies, or buyer-endpoint stack traces.

  ### Documentation

  - New normative section **`docs/protocol/snapshot-and-log.mdx` § Webhook activity log pattern** — names the canonical record, the two request-field conventions, scoping, retention floor, three-state presence semantics, record cardinality, and privacy rules. Includes an explicit **8-item adoption checklist** so future resources have unambiguous MUST hooks. Item 1 is the **notification-channel prerequisite**: adoption requires a registered notification channel for the relevant fire types — per-buy `push_notification_config` (existing) for buy-scoped resources, or the per-account subscription model from #4582 track 3 for resources that outlive a buy. The two are different primitives that fulfill the same prerequisite. Without a channel there are no fires to log, so the rest of the checklist is gated on this item. The earlier media-buy-specific mention now cross-references the pattern. Buyers diagnosing an unexpected omission have two observable signals (`push_notification_config` registration state, seller capability declaration) to discriminate the cause without filing a ticket.
  - New "Diagnosing missing fires" subsection in `docs/building/by-layer/L3/webhooks.mdx` so buyers triaging missing fires from the transport contract page can find the debug surface.
  - `docs/media-buy/task-reference/get_media_buys.mdx` documents `include_webhook_activity` / `webhook_activity_limit` / `webhook_activity[]` with field table, status semantics, three-state presence, retention MUST, and a JS+Python "diagnose a webhook delivery problem" example that groups attempts by `idempotency_key` and selects the latest attempt by `attempt` number (robust against iteration order).

  ### Scope of this PR within #4582

  - **Track 1** (snapshot/log duality doc) — already shipped at `docs/protocol/snapshot-and-log.mdx`; this PR extends it with the Webhook activity log pattern section.
  - **Track 2** (persistent webhook contract) — already shipped at `docs/building/by-layer/L3/webhooks.mdx`; this PR adds the cross-link from the contract page back into the debug surface.
  - **Track 3** (per-account subscription model) — explicitly **not** in this PR; targeted for 3.2.0 because it introduces a new account-level surface that needs to compose carefully with #3009 (multi-subscriber, 4.0).
  - **Track 4** (standardized log surface) — **shipped here**: hoisted record schema, universal truncation sentinel, retention MUST resolution, canonical pattern documentation.
  - **Tracks 5–7** (auth/transport hygiene, dedup edge cases, conformance rendezvous) — separate cadence per the epic.

  ### Dependency chain (informational)

  Track 4's adoption checklist names a notification-channel prerequisite as item 1. The implication: media buys adopt today because their channel (per-buy `push_notification_config`) already exists. Resources that outlive a media buy — creative-lifecycle (#2261), audiences, properties, account-level governance (#1711) — are blocked on track 3 (3.2.0) for the per-account channel. Once track 3 ships, those consumers plug into this pattern's record shape, request fields, scoping, retention floor, and three-state presence — inheriting transport, subscription, and observability from #4582 rather than re-deriving any of them. The #2261 RFC itself scopes to creative-specific event payloads + state-machine transitions; everything else is inherited.

  ### Backwards compatibility

  Both request fields are optional with default `false` / `50`; the response field is optional and absent unless `include_webhook_activity: true` is set AND the seller surfaces fire history for the buy with the required retention floor. Old clients see no change.

  ### Out of scope (future work)

  - **`include_webhook_payloads`** — sensitive opt-in to surface request and response bodies. Carved out as a separate extension because request/response bodies warrant stricter access controls and would consume the new truncation sentinel for size-bounding.
  - **Operator-facing aggregate views** across principals.
  - **Cross-subscriber visibility** under #3009 — `subscriber_id` is reserved on the record shape now so #3009 can populate it without a schema break.
  - **Real-time push** of webhook-activity events.
  - **Replay tool** (re-fire a past delivery).

  Closes #4278. Lands #4582 track 4.

- a48d619: Add `allowed_values` to `text-asset-requirements.json` and the matching `CREATIVE_VALUE_NOT_ALLOWED` error code. Creative agents can now declare a closed set of permitted string values for a text input slot (e.g., legal- or brand-approved CTAs); conformant implementations MUST reject submissions outside the list with `CREATIVE_VALUE_NOT_ALLOWED`, echoing the offending field path in `error.field` and the allowed list in `error.details.allowed_values` so buyer agents can re-prompt deterministically. The field is optional and additive — existing producers and consumers are unaffected.

  Refs #4331.

- 95bc69c: spec: webhook token round-trip + storyboard `required_any_of_tools` (closes #4339, #4325)

  Two additive 3.1.0-beta.2 blockers bundled. Both are non-breaking — existing senders and receivers continue to interoperate.

  **#4339 — webhook authentication `token` round-trip (`static/schemas/source/core/`)**

  - `mcp-webhook-payload.json` — promote the echoed authentication `token` to a typed optional property (`minLength: 16`, `maxLength: 4096`). The field previously traveled on the wire under `additionalProperties: true`; this is purely a typed surface on an existing implicit contract. Schema-driven SDK clients can now access `payload.token` without falling through an extras path. Receivers that configured a token MUST compare it to this value to validate request authenticity, and SHOULD use a constant-time equality check to mitigate timing attacks. The length-check fast-path is forbidden — receivers MAY range-check token length only after subscription lookup and never as a short-circuit on equal-length inputs.
  - `push-notification-config.json` — add `maxLength: 4096` to the existing `token` field (was previously only `minLength: 16`); this is a constraint addition on the upper bound, not a tightening of the lower bound that would reject existing-conformant configs. Cross-reference the payload-side validation obligation. Add downgrade-defense sentence: receivers that registered both an RFC 9421 signing key and a `token` MUST NOT treat a valid token echo as authorization to skip signature verification. Clarify that `token` is NOT on the 4.0 removal track (only the legacy `authentication` block is being removed in favor of RFC 9421).

  **#4325 — storyboard `required_any_of_tools` declarative one-of-N gate (`static/compliance/source/universal/`)**

  - `storyboard-schema.yaml` — add `required_any_of_tools` as a top-level optional storyboard field. Each entry is an OR-family `{ tools: string[] (minItems: 2), rationale?: string }`. Multiple entries AND-combine. Distinct from `required_tools` (lenient any-of coverage skip) and `provides_state_for` (step-scope state substitution).
  - `runner-output-contract.yaml` — extend `requirement_unmet` with the canonical `detail` sub-reason prefix `missing_required_tool_family:` plus the literal wire shape for separators (`" or "` between family members, `"; "` between multi-gate aggregations). No new top-level `skip_result.reason` enum value — the contract version stays at 2.2.0. Aggregator guidance is human-display only; automated consumers SHOULD parse only the first sub-reason from aggregated `detail` and surface multi-gate state separately.
  - `scripts/build-compliance.cjs` — validate the field on specialism `index.yaml` files (filter+trim `tools[]` before `minItems:2` enforcement; reject non-string `rationale`; drop empty `rationale` after trim) and hoist into `compliance/<version>/index.json` for downstream SDK consumption.

  **Downstream pickups (tracked separately):**

  - `adcontextprotocol/adcp-client-python#638` — drops the `extra='allow'` token round-trip path once types regenerate against this schema.
  - `adcontextprotocol/adcp-client#1481` — drops `examples/hello_si_adapter_brand.ts` top-level `offering_id` mirror once the 3.1.0-beta.2 dist publishes (the SI capture-path fix shipped in #3937 / dist 3.1.0-beta.1).
  - `adcontextprotocol/adcp-client#1642` — migrates the runner-level account-discovery conformance gate (#1624) to per-storyboard `required_any_of_tools` consumption.

  **Known follow-ups (filed as issues, non-blocking on this beta):**

  - `minLength: 16` on both `token` fields permits ~96-bit base64url credentials, below the 128-bit entropy SHOULD in the description. Raising the floor to 22 would tighten an existing field; the gap is intentional for backward compatibility and re-evaluated in 4.0.
  - `docs/building/by-layer/L3/webhooks.mdx` token-echo subsection and `whats-new-in-3-1.mdx` / `migration/prerelease-upgrades.mdx` entries are pending. Schema descriptions carry normative weight; the docs page catches up in a follow-up PR.

- 4c12454: spec(security): clarify idempotency-replay semantics for state-tracking fields on stateful resources.

  The existing idempotency contract (security.mdx §Idempotency rule 2) made the immutable-cache invariant explicit for async (`submitted`) responses — even if the underlying task transitions to a terminal state, replay returns the originally-cached `submitted` payload, not the current state — but was silent on synchronous-success responses that carry state-tracking fields inline (`status` on `create_media_buy`, per-record arrays on `sync_*`, resource snapshots on `acquire_rights` / `activate_signal`). The gap surfaced in real storyboard runs: a media buy created with `status: pending_creatives`, then mutated to `canceled`, then replayed via the same `idempotency_key` returned the cached `pending_creatives` bytes. A buyer that trusted the response as current state hit `NOT_CANCELLABLE` on the next mutation and a state-machine bug. Three options surfaced:

  1. **Replay returns cached bytes verbatim** — what sellers do today; preserves byte-stable replay; buyers must re-read for current state.
  2. **Replay returns current state** — what buyers reading the bytes expected; breaks byte-stable replay and forces sellers to refresh the cache on every resource mutation.
  3. **Capability-declared** — sellers advertise their replay policy.

  Picked (1) and made it normative across both branches:

  - Seller rule 2 extended explicitly to synchronous-success responses. State-tracking fields in the cached payload MUST NOT refresh on replay. Partial refresh ("some fields current, others snapshot") is non-conformant — it would multiply the number of valid cache contents for a given key and break the canonical-replay invariant the rest of the rules build on.
  - New buyer-obligation paragraph: **Replay responses are historical snapshots.** Buyers requiring current state MUST consult the resource's read endpoint (`get_media_buys`, `list_accounts`, `list_creatives`, etc.). `replayed: true` is the explicit signal that a fresh read is required before any state-dependent decision. Agentic buyers MUST treat `replayed: true` as a stop signal for any planning step whose next action depends on resource state.
  - `Response-level replay indicator` gains a `State-machine routing` bullet pointing back at the seller rule and buyer obligation so the contract reads consistently from either entry point.

  Why (1) over (2) or (3): (2) forces every seller to thread the resource state machine through the idempotency cache (multiplying valid cache contents and breaking byte-stable replay). (3) adds capability surface for a question the spec should answer uniformly — heterogeneous replay semantics across sellers is exactly the kind of cross-seller inconsistency the idempotency contract exists to prevent. (1) is what existing sellers do; the gap was the contract being silent on sync-success, not divergent behavior.

  Files:

  - `docs/building/by-layer/L1/security.mdx` — seller rule 2 expanded (async + synchronous-success branches); new "Replay responses are historical snapshots" paragraph under "Buyer obligations"; `Response-level replay indicator` list gains the state-machine-routing bullet.

  Closes #4371.

- d3bdc28: `comply_test_controller`: `account.sandbox: true` is now **required** on every controller request. The follow-up to #4382 / #3755 — sample_request blocks across all 25 controller call-sites in the storyboard suite have been swept to include the field, and the request schema's `required` array now lists `account` alongside `scenario`. Schema examples updated to match.

  Lint coverage is automatic: the existing `lint-storyboard-sample-request-schema.cjs` runs ajv against every storyboard sample_request, so any new `comply_test_controller` step that omits `account.sandbox: true` fails CI with `required@/:account` and is blocked without an allowlist entry. No new lint code needed — the schema tightening is the gate.

  This operationalizes the (Sandbox) verdict's defense-in-depth: the seller-side persisted-record check is the load-bearing gate, and now the wire format enforces it too. Closes #4383.

- 4c12454: spec(mcp,security): require MCP tool wrappers to tolerate envelope-level fields.

  Buyer SDKs send envelope-level fields (`idempotency_key`, `context_id`, `context`, `governance_context`, `push_notification_config`) uniformly across all AdCP tool calls — including read-only tools that don't consume them. Buyers cannot know per-tool which envelope fields the seller's wrapper happens to declare, and the wire-level contract via `additionalProperties: true` on every published request schema permits them.

  Some MCP server implementations apply stricter validation than the schema declares — FastMCP / Pydantic with declared signatures raises `unexpected_keyword_argument`, Zod `.strict()` rejects unknown keys, OpenAPI codegen sometimes injects `additionalProperties: false` into input models. The result: read tools like `get_products` reject calls when `idempotency_key` arrives in params, breaking cross-seller portability the protocol promises.

  This is the server-side counterpart to the `additionalProperties: true` default — generalizing the principle already established for response validators in [`runner-output-contract.yaml` > `response_schema_validator_semantics`](https://github.com/adcontextprotocol/adcp/blob/main/static/compliance/source/universal/runner-output-contract.yaml) ("validator configuration MUST NOT contradict the schema's own `additionalProperties` declaration") to the request side.

  Files:

  - `docs/building/by-layer/L1/security.mdx` — new `#### Server-side tool wrapper conformance` subsection under §Idempotency (the most-affected envelope field). Concrete traps and fixes named for FastMCP/Pydantic, Zod/valibot, and OpenAPI codegen.
  - `docs/building/by-layer/L0/mcp-guide.mdx` — new `### Server-side tool wrappers MUST tolerate envelope fields` subsection under §MCP-Specific Considerations, cross-linking to the security.mdx normative rule. Concrete traps and one-line fixes for the three common stacks.

  Confirmed pre-existing in the wild — issue filer (#4399) hit it in production against a real seller, fixed in the seller's Wave 23.20 by adding `idempotency_key: str | None = None` to read-tool wrapper signatures.

  Closes #4399.

- 4c12454: spec(security): require `idempotency_key` on every AdCP task request — read and mutating alike.

  Follow-up to #4399 (MCP tool wrapper envelope tolerance) — the deeper question that surfaced once that fix landed: why does this category of bug exist at all? Sellers reject `idempotency_key` on `get_products` because the contract framed it as a "mutating-only" envelope field, but `get_products` is polymorphic:

  - `buying_mode: 'brief'` / `'wholesale'` resolves as a pure read most of the time.
  - The same tool MAY return a `Submitted` envelope when curation requires upstream queries or HITL — that's async-task creation, which is mutation territory.
  - `buying_mode: 'refine'` with `action: 'finalize'` is a commit that transitions a proposal to committed with an `expires_at` hold window (see #4107).

  Buyers cannot predict at call time which mode the seller will resolve. So the rule "send `idempotency_key` on mutating requests only" required classification the buyer can't do, and the rule "sellers reject mutating requests that omit it" left sellers tripping over reads that turned into mutations or carried the field uniformly.

  The simpler rule: `idempotency_key` is required on every AdCP task request, period. Read and mutating alike. The buyer no longer classifies; the seller no longer rejects on the read/write distinction; the polymorphism on `get_products` (and any future tool that gains hybrid read/write modes) stops being a wire-contract footgun.

  For calls that resolve as pure reads, the cache provides byte-stable replay-on-retry within the TTL — harmless and gives buyers a uniform retry-safe contract. For calls that resolve as async-task creation or commit, the cache provides the same at-most-once guarantees as on mutating tasks. The rate-limit ceiling in rule 8 already accounts for high-volume traffic; read traffic adds to insert rate but the ceiling is tunable per operator.

  Files (`docs/building/by-layer/L1/security.mdx`):

  - §Idempotency rule 1 lead — "required on every AdCP task request — read and mutating alike". Drops the long list of mutating task names (the list was always going to drift as new tools shipped).
  - New `**Why universal — including read tools.**` paragraph naming `get_products`'s polymorphism as the canonical case.
  - §Response-level replay indicator — "responses to any request that resolved via the idempotency cache" (was "responses to mutating requests").
  - §Buyer obligations / "When the seller's capability declaration is missing" — fail-closed now applies to every AdCP task request, with explicit reasoning about why pure-read calls aren't exempt under polymorphism.
  - §Server-side tool wrapper conformance (added in #4399) — `idempotency_key` line tightened from "MUST accept and ignore on read tools" to "MUST accept it; the idempotency layer routes it per rules 2-9".

  Why this over keeping the mutating-only rule and just fixing #4399's wrapper bug:

  - The wrapper bug was a symptom of the binary contract being wrong-shaped. Patching the symptom (sellers must accept envelope fields) without fixing the binary leaves future polymorphic tools (anything that can return Submitted) hitting the same class of failure.
  - "Cleaner and simpler" beats "send-on-mutating-only" once the polymorphism exists — the buyer's SDK doesn't need a read-vs-write classifier and the seller's wrapper doesn't need to know which mode a call resolved into before it sees the key.
  - Cache-growth concern bounded by rule 8 (per-agent insert ceiling); the recommended numbers were sized for realistic high-volume launch patterns and remain tunable.

  Refs #4399. Supersedes the "MUST tolerate on read tools" carve-out — `idempotency_key` is now required, not tolerated.

- 4c12454: spec(compliance): standardize `notices` advisory channel on runner-output-contract.

  `universal/signed-requests.yaml` already mandates an "informational notice (not a failure)" for agents that still advertise the deprecated `signed-requests` specialism — but the contract had no field for it. Runners had two bad options: bake the advisory into prose `skip.detail` strings (unparseable by dashboards), or stay silent and let sellers hit a wall at the 4.0 cut where `request_signing` becomes required and `legacy_hmac_fallback` is removed.

  Adds a structured advisory channel:

  - **`step_result.notices`** — per-step advisory array.
  - **`run_summary.notices`** — run-scoped advisories (e.g., one `request_signing_required_in_4_0` notice per run, not per storyboard).
  - Notices MUST NOT contribute to `steps_failed`, `validations_failed`, or change `step_result.passed`. They fill the gap between validation failures (agent did something wrong), skips (runner couldn't apply the storyboard), and advisory-severity validations (storyboard author marked a check non-blocking) — none of which fit "passing observation, but here's a forward-looking advisory."
  - Three severities: `info` (advisory context only), `deprecation` (allowed today, spec recommends migration), `future_required` (optional today, required at a named future version with `effective_version`).
  - Forward-compat: receivers MUST treat unknown `code` or `severity` values as well-formed and surface them verbatim — additive extensions ship without breaking older consumers, matching the same forward-compat rule the contract already applies to authored check kinds.

  Canonical first-day codes documented under `notice.canonical_codes`:

  - `signed_requests_specialism_deprecated` (deprecation, motivated by the existing SHOULD in `signed-requests.yaml:34`).
  - `request_signing_required_in_4_0` (future_required, `effective_version: 4.0`).
  - `legacy_hmac_fallback_removed_in_4_0` (deprecation, `effective_version: 4.0`).

  `signed-requests.yaml` updated to reference the canonical code instead of the prose-only SHOULD.

  Files:

  - `static/compliance/source/universal/runner-output-contract.yaml` — version bumped 2.1.0 → 2.2.0 (additive). New top-level `notice:` block defines required/optional fields and canonical codes. `step_result.optional_fields` and `run_summary.optional_fields` gain `notices`.
  - `static/compliance/source/universal/signed-requests.yaml` — points the existing SHOULD at the new canonical `signed_requests_specialism_deprecated` code.

  SDK side (`@adcp/sdk`, `@adcp/client`) implements emission; tracked separately at adcp-client#1704.

  Refs #4418.

- f23cefc: Add `get_creative_features.audit_observations[]` for non-blocking creative governance audit observations.

  The first standardized observation is `OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED`, emitted when provenance declares `human_oversight: edited` or `directed` while also declaring `disclosure.required: false`. This surfaces the editorial-responsibility carve-out claim for audit routing without treating it as `PROVENANCE_CLAIM_CONTRADICTED` or a rejection reason by itself.

  Docs now define the seller and governance-agent handling pattern, and a media-buy conformance storyboard exercises the observable flow where a seller calls an on-list verifier and accepts the creative instead of treating the audit observation as a rejection.

  Closes #4438.

- b5d64ea: feat(media-buy): allowed_actions on products, available_actions on buys, structured ACTION_NOT_ALLOWED rejection

  Adds a structured action vocabulary for `update_media_buy` capability discovery. Buyers can pre-flight which mutations are valid on a given buy in its current state instead of learning by mid-flight rejection. Composes with #4425's `requires` predicate grammar for caller-side requirement expression.

  **Schema additions**

  - `media-buy-valid-action` enum extended with finer-grained values: `extend_flight`, `shorten_flight`, `update_flight_dates`, `increase_budget`, `decrease_budget`, `reallocate_budget`, `update_targeting`, `update_pacing`, `update_frequency_caps`, `replace_creative`, `update_creative_assignments`, `remove_creative`, `remove_packages`. The coarse legacy values (`update_budget`, `update_dates`, `update_packages`, `sync_creatives`) are retained for 3.x backwards compatibility and removed in 4.0.
  - `media-buy-action-mode` enum (new): `self_serve`, `conditional_self_serve`, `requires_proposal`, `requires_approval`.
  - `action-not-allowed-reason` enum (new): `wrong_status`, `not_supported_on_product`, `not_supported_on_buy`, `mode_mismatch`.
  - `sla-window` core object (new): optional `response_max` + `completion_max` ISO 8601 durations.
  - `product-allowed-action` core object (new): `action` + `modes[]` + optional `allowed_statuses[]` + optional `sla` + optional `terms_ref`. Advisory template.
  - `media-buy-available-action` core object (new): `action` + singular `mode` + optional `sla` + optional `terms_ref`. Authoritative per-buy resolution.
  - `allowed_actions[]` on `product`: array of `product-allowed-action`.
  - `available_actions[]` on `get_media_buys`, `create_media_buy`, and `update_media_buy` responses: array of `media-buy-available-action`. The existing `valid_actions[]` field is deprecated in favor of `available_actions[]`; sellers SHOULD populate both during the 3.x deprecation window, consumers MUST prefer `available_actions[]` when both are present, and `valid_actions[]` is removed in 4.0.
  - `ACTION_NOT_ALLOWED` error code: populated with `attempted_action`, `reason`, and `currently_available_actions` in `error.details` so buyer SDKs can offer recovery without a separate `get_media_buys` round-trip. Typed details schema at `error-details/action-not-allowed.json`.
  - `enumMetadata` on `media-buy-valid-action`: each entry carries `update_fields` (dotted paths into `update_media_buy` body) so SDKs and codegen can dispatch from schema metadata rather than parsing the field-mapping table. Legacy coarse values additionally carry `deprecated: true` and `rollup` (the finer-grained values that supersede them) so SDKs can hide deprecated values when rollup targets are present in the same payload.
  - `allowed_actions[]` and `available_actions[]` arrays are uniquely keyed by `action`; sellers MUST NOT emit two entries with the same `action` value. Predicate evaluators consuming dotted paths like `available_actions.extend_flight.sla.response_max` MUST index by `action`.

  **Documentation**

  `docs/media-buy/task-reference/update_media_buy.mdx` adds the normative action → field mapping table (each action's exact `update_media_buy` fields), the mode table, and the relationship between flat `valid_actions[]` and structured `available_actions[]`.

  **Composition with #4425**

  The `requires` predicate grammar in #4425 queries `available_actions[]` as a first-class field. Field-level constraint metadata (bounds, max deltas) is out of scope for v1 and the natural home is `requires` rather than a parallel grammar. Duration predicates (e.g. `lte` on SLA `response_max`) extend the predicate vocabulary; tier-based SLA expression (`fast` / `standard` / `slow`) remains a possible alternative if the WG prefers to stay inside `equals`/`in`.

  Refs #4480, #4425.

- 057ddf6: compliance: require baseline `sync_governance` registration in money-moving sales specialisms

  Adds a `sync_governance` registration step to the 3.1 beta compliance flows that move or monitor spend: `sales-social`, `sales-catalog-driven`, `sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`, and the generative seller flow under `creative-generative`. The step stops at account-level governance-agent registration and does not add `check_governance` enforcement to these parent tracks.

  This remains a minor beta compliance fix under the conformance-suite policy in `docs/reference/versioning.mdx`: the wire contract and `sync_governance` task already exist, and this PR aligns the beta grader with that existing baseline rather than adding a new protocol surface. Existing beta sellers claiming these money-moving specialisms must now implement `sync_governance` registration and the one-governance-agent rejection rule to remain conformant in 3.1 grading.

  The `governance-aware-seller` specialism remains the opt-in claim for the full governance-check loop (`check_governance`, denial propagation, conditions, and recovery) after baseline registration.

- 0d7452e: feat(compliance): add `media_buy_seller/performance_buy_flow` capability-gated scenario (closes #4569)

  A non-guaranteed seller that advertises `media_buy.conversion_tracking` now has its performance-buy path certified end-to-end. The new scenario gates on the conversion_tracking capability via `requires_capability: present: true` (runner support landed in `@adcp/client` 7.6.0) — sellers without the capability grade `not_applicable`.

  The scenario verifies the dots actually connect when a seller claims conversion tracking:

  - `sync_event_sources` returns a usable `event_source_id`.
  - `create_media_buy` with an event-kind `optimization_goal` (CPA target) referencing the registered source is accepted.
  - `create_media_buy` with a goal referencing an unregistered `event_source_id` is rejected with `INVALID_REQUEST` and `error.field` set to the offending path — silent acceptance is a façade.
  - `log_event` against the bound source is forwarded upstream (anti-façade `upstream_traffic` assertion).
  - `get_media_buy_delivery` returns first-class conversion metrics: `conversions` and `cost_per_acquisition` at the buy level. Per-creative attribution is intentionally deferred to a follow-up scenario because real adopters report at differing granularities (per-line for retail-media, per-campaign for MMP-mediated mobile, per-placement for CTV); requiring per-creative here would fail honest implementations.

  ROAS (`target.kind: per_ad_spend`) and value-max (`target.kind: maximize_value`) are deliberately out of scope here — many honest conversion-tracking sellers (broadcast TV, upper-funnel video, signal-only) don't compute return-on-ad-spend. ROAS gets its own scenario gated on a separate `supported_target_kinds` capability bit ([#4639](https://github.com/adcontextprotocol/adcp/issues/4639)).

  This is the first scenario in a broader capability-claim contract pattern tracked under [#4637](https://github.com/adcontextprotocol/adcp/issues/4637): every non-trivial capability a seller declares should have a `requires_capability`-gated scenario proving the claim is honest end-to-end.

  **Added to `sales-non-guaranteed.requires_scenarios`.**

- c9ca76d: Windowed pull recovery on `get_media_buy_delivery` — closes [snapshot-and-log](docs/protocol/snapshot-and-log.mdx) Rule 4 for data-bearing events.

  **Capability** (`core/reporting-capabilities.json`)

  - New `windowed_pull_granularities` (array of `reporting-frequency` enum values). Capability-scoped MUST: sellers MUST honor `time_granularity` pulls at any granularity declared here. Sellers MAY emit higher-frequency webhooks than they pull (e.g., stream-tap webhook with warehouse pulls only at daily); buyers see the gap up front via the capability.

  **Request** (`media-buy/get-media-buy-delivery-request.json`)

  - New `time_granularity` (reporting-frequency enum: `hourly` | `daily` | `monthly`) and `include_window_breakdown` (boolean). When both are set, the response returns per-window delivery slices shape-aligned with `reporting_webhook` payloads at the same granularity.

  **Response** (`media-buy/get-media-buy-delivery-response.json`)

  - New `media_buy_deliveries[].windows[]` array. Each slice carries `window_start`, `window_end`, `totals` (delivery-metrics), optional `by_package`, `is_final`, and `measurement_window`. Slices are ordered ascending and contiguous over the requested date range. Buyers reconcile missed webhooks by joining on `(media_buy_id, window_start)`.

  **Error code** (`enums/error-code.json`)

  - New `UNSUPPORTED_GRANULARITY` for pulls outside the declared `windowed_pull_granularities`. Sellers SHOULD echo the supported set in `error.details.supported_granularities`. Recovery: correctable.

  **Spec** (`docs/protocol/snapshot-and-log.mdx`)

  - Rule 4 promoted from SHOULD to MUST for capability-declared granularities. The contract holds within the seller's declared parity set; honest declaration of asymmetric webhook-vs-pull frequencies is in scope.

  Additive across the board: new request fields are optional, new response array is opt-in via `include_window_breakdown`, new capability defaults to empty (preserves current behavior — cumulative date-range pulls only). No breaking changes; safe in a minor release.

  Closes #4590. Anchors snapshot-and-log Rule 4 alongside the existing transport-layer log surface ([#4278](https://github.com/adcontextprotocol/adcp/issues/4278)).

- 4af7213: Add creative-agent canonical `supported_formats` storyboard coverage for 3.1.

  The training agent now advertises implemented canonical creative build
  capabilities with agent-local `capability_id` values, accepts those IDs as
  `build_creative` targets for implemented canonical outputs, rejects unsupported
  targets with `FORMAT_NOT_SUPPORTED`, and keeps 3.0 compatibility mode from
  accepting 3.1-only capability selectors.

- fba3451: Add the canonical-format `validate_input` conformance storyboard for 3.1.

  The training agent now exposes `validate_input` on sales, creative, and
  creative-builder tenants, returns the three 3.1 result discriminators for
  canonical/product targets, and the storyboard matrix requires the new coverage
  to stay clean on each surface that advertises the tool.

- c9ca76d: Type `notification_id` as a first-class envelope field — closes a Rule 1 ambiguity on the webhook envelope contract.

  **Schema** (`core/mcp-webhook-payload.json`)

  - New optional top-level `notification_id` (string, 1–255 chars). Description anchored on snapshot-and-log Rule 1: stable across re-emissions, distinct from the per-fire `idempotency_key`. Population is event-shape-dependent — present on state-shaped events (equals the resource's stable id, e.g., `impairment_id`); absent on point-in-time data events (e.g., delivery report fires) per Rule 1.

  **Cross-references** (`enums/notification-type.json`)

  - Each enumDescription now declares its per-type `notification_id` population:
    - `impairment` → `impairment.impairment_id` (stable across re-emissions and the closing fire)
    - `scheduled` / `final` / `delayed` / `adjusted` → absent (point-in-time data events; dedupe by `idempotency_key` only)
  - Future notification types declare per-type population the same way.

  **Spec**

  - `docs/building/by-layer/L3/webhooks.mdx` — removes the "or the equivalent event-scoped id surfaced in the payload" hedge in the persistent-channel delivery-semantics block; receivers MUST track `notification_id` for state-shaped events.
  - `docs/protocol/snapshot-and-log.mdx` — Rule 1 forward-reference replaced with a direct anchor to the envelope schema and the per-type enumDescriptions.

  Additive — new field is optional and existing senders/receivers continue to validate. Receivers consuming the envelope from a strictly-typed SDK gain `notification_id` at the type level instead of having to read prose.

  Closes #4594. Follow-up to #4588 (snapshot-and-log Rule 1 prose) and the impairment cluster.

- 67aaaac: feat(compliance): audience_buy_flow + event_dedup_flow capability-gated scenarios; training-agent audience_id validation

  Two new scenarios in the capability-claim contract pattern (#4637), both added to `sales-non-guaranteed.requires_scenarios`:

  - `media_buy_seller/audience_buy_flow` — gated on `media_buy.audience_targeting` presence. Certifies `sync_audiences` → bound `audience_id` in targeting → unbound id rejected → delivery against an audience-targeted buy. Sibling to `performance_buy_flow` on the audience side; the unbound-id rejection is the discriminating assertion.

  - `media_buy_seller/event_dedup_flow` — gated on `media_buy.conversion_tracking.multi_source_event_dedup` equals true. Certifies that the same `event_id` from two registered event sources attributes to one conversion, not two. Sellers without `multi_source_event_dedup` grade `not_applicable` — the bit gates the scenario; the cumulative-count check is the assertion.

  Training-agent fix: `create_media_buy` now rejects `targeting_overlay.audience_include` / `audience_exclude` entries whose `audience_id` was never registered via `sync_audiences`, with `INVALID_REQUEST` and `error.field` set to the literal JSONPath-lite path of the offending entry. Mirrors the `event_source_id` validation pattern from #4654. `sync_audiences` itself is now wired through the training agent (legacy `/mcp` and v6 `/sales/mcp` via `AudiencePlatform`) so adopters can run the audience scenario against the reference implementation.

  Three sibling product-level scenarios (reach, clicks, completed_views) remain blocked on #4651 product-level capability gating RFC.

- fff0e2a: feat(compliance): metric-mode (reach/clicks/completed_views) + ROAS capability-gated scenarios using contains: matcher

  Four new scenarios in the capability-claim contract pattern (#4637), all gated via the `contains:` matcher (shipped in @adcp/client 7.70 — adcp-client#1817), all added to `sales-non-guaranteed.requires_scenarios`:

  - `media_buy_seller/performance_buy_flow_roas` — gated on `media_buy.conversion_tracking.supported_targets` containing `per_ad_spend` (#4639). Certifies that sellers advertising ROAS optimization accept event-kind goals with `target.kind: per_ad_spend` and `value_field` populated, reject ROAS goals that omit `value_field` on every event source entry, and report `conversion_value` and `roas` on delivery alongside `conversions` and `cost_per_acquisition`. Sibling to `performance_buy_flow` on the value side.

  - `media_buy_seller/reach_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `reach` (#4669). Certifies that sellers advertising reach optimization accept metric-kind goals with `metric: reach`, a `reach_unit` from the product's `metric_optimization.supported_reach_units`, and an optional `target_frequency` band; reject unsupported `reach_unit` values; and report `reach` and `frequency` on delivery.

  - `media_buy_seller/clicks_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `clicks` (#4669). Certifies that sellers advertising click optimization accept metric-kind goals with `metric: clicks` and a `cost_per` target, and report `clicks` and `cost_per_click` on delivery. No rejection arm — clicks is universal in semantics with no obvious unbound-id surface.

  - `media_buy_seller/completed_views_buy_flow` — gated on `media_buy.supported_optimization_metrics` containing `completed_views` (#4669). Certifies that sellers advertising completion optimization accept metric-kind goals with `metric: completed_views` and a `view_duration_seconds` in the product's `metric_optimization.supported_view_durations`; reject unsupported `view_duration_seconds` values (per `optimization-goal.json:50-53`, silent rounding creates measurement discrepancies); and report `completed_views` and `completion_rate` on delivery.

  All four scenarios grade `not_applicable` against the embedded training agent today — the training agent doesn't declare `supported_targets` or `supported_optimization_metrics` and therefore cannot claim these optimization kinds. This is the correct anti-façade hygiene per the `event_dedup_flow` precedent (#4664): an agent that doesn't claim a capability is not held to its scenario. The training agent stays honest by NOT claiming what it can't do; production adopters opt in by declaring the capability bits.

  Refs: #4637 (meta), #4639 (`supported_targets`), #4669 (`supported_optimization_metrics`), #4642 (CPA scenario precedent), #4664 (`event_dedup_flow` precedent), #4651 (product-level capability gating), adcp-client#1817 (`contains:` matcher).

- e4587be: feat(schemas): add `supported_targets` to `conversion_tracking` capability.

  The seller-level `conversion_tracking` capability object on `get_adcp_capabilities` has no way to declare which event-goal `target.kind` values it can compute against. Today the spec requires sellers to reject `target.kind: per_ad_spend` event goals when no `event_sources[]` entry carries `value_field` (`static/schemas/source/core/optimization-goal.json`), but buyers have no pre-submission signal — they discover the constraint only at `create_media_buy` rejection time.

  `supported_targets` is an optional array on the existing `conversion_tracking` object, enum-constrained to `cost_per | per_ad_spend | maximize_value`. Named to parallel the product-level `metric_optimization.supported_targets` — same concept (which target kinds are supported), one at seller-capability granularity and one at product granularity. Buyers filter their event-goal shape against this list before submission; sellers MUST reject goals whose `target.kind` is not listed. When omitted, only target-less event goals (maximize conversion count within budget) are guaranteed.

  Purely additive and backward-compatible — no existing field changes, no requireds. Unblocks a future `performance_buy_flow_roas` storyboard scenario (capability-gated) without coupling that scenario to this schema PR.

  Files:

  - `static/schemas/source/protocol/get-adcp-capabilities-response.json` — new optional `supported_targets` property on the `conversion_tracking` object.

  Refs #4569, #4637. Closes #4639.

- 93e570b: feat(compliance): frequency_cap_enforcement capability-gated scenario

  New scenario in the capability-claim contract pattern (#4637), added to `sales-non-guaranteed.requires_scenarios`:

  - `media_buy_seller/frequency_cap_enforcement` — gated on `media_buy.frequency_capping` presence (#4640 / #4670). Certifies that a seller advertising frequency_capping accepts a package-level `frequency_cap` (cap-form: `max_impressions` + `per` + `window`) on `create_media_buy` and, after simulated delivery, reports `totals.reach` + `totals.frequency` on `get_media_buy_delivery` with the observed frequency at-or-below the requested cap. Cap-form is the assertion target because it declares the numeric ceiling whose enforcement this scenario verifies; cooldown-form `suppress` is a separate semantic and not exercised here.

  Runtime-enforcement scenario — structurally simpler than the goal-mode scenarios (audience_buy_flow, performance_buy_flow). No rejection arm: `frequency_cap` is a numeric constraint, not a pointer to a registered resource, so there is no unbound-id analogue to reject against. The discriminating assertion is the observed frequency in delivery totals — a seller that silently drops the cap would deliver to its natural frequency distribution and overshoot.

  The observed-frequency-within-cap assertion uses `field_less_than` with a literal `value: 3.01` against a `max_impressions: 3` cap. The storyboard-schema check enum exposes `field_less_than` (strict less-than) as the only single-step numeric-comparison matcher today; a native `<=` / `field_at_most` matcher does not exist. The 0.01 epsilon lets the assertion target the cap literal without rejecting honest sellers that report frequency at exactly 3.0. A runner extension adding `field_at_most` (storyboard schema + runner update) would let this drop to `value: 3` without the epsilon — captured here as a soft follow-up; the cap-enforcement signal is already discriminating without it.

  No training-agent changes — the training agent does not declare `frequency_capping` today, so the scenario grades `not_applicable` against the reference implementation and CI passes. Same anti-façade pattern as the other capability-gated scenarios: the bit gates the scenario, the assertion targets the runtime behavior that the bit commits to.

  Refs: #4637 (capability-claim meta), #4640 (capability bit), #4670 (frequency_capping shipping PR).

- 72dc776: feat(schemas): add media_buy.frequency_capping capability declaration (closes #4640)

  Sellers can now declare frequency-capping support in get_adcp_capabilities. Presence of the object means the seller honors `targeting.frequency_cap` and MUST reject caps they cannot enforce rather than silently dropping them.

  Two optional sub-fields let buyers pre-flight validate before submitting:

  - `supported_per_units` — entity granularities (devices, individuals, etc.) from reach-unit.json
  - `supported_window_units` — duration units (hours, days, campaign) from duration.json

  `enforces_within` from the original RFC was dropped — no SSP can back that attestation cleanly. Per-product overrides for mixed addressable/non-addressable inventory are a likely follow-up.

  A capability-gated `frequency_cap_enforcement` storyboard scenario lands separately under the capability-claim contract pattern (#4637).

- 7b5734e: feat(schemas): add media_buy.supported_optimization_metrics seller-level summary (closes #4651)

  Sellers can now declare which optimization metrics they support at the seller level, mirroring the product-level `metric_optimization.supported_metrics` enum. Buyer agents get a single discoverable rollup for pre-flight metric filtering; storyboard scenarios get a gate path they can use with `requires_capability` to skip sellers that don't support a metric (e.g., reach_buy_flow, clicks_buy_flow, completed_views_buy_flow).

  Sellers MUST keep this in sync with their product catalog — values appear here only if at least one product supports them. Per-product inspection via `metric_optimization.supported_metrics` remains the source of truth for buy-time targeting; this is a seller-level discoverability convenience.

  Unblocks the metric-buy-mode storyboards under the capability-claim contract pattern (#4637). Those scenarios additionally require a `contains:` matcher on `requires_capability` (filed against adcp-client).

- 8650fb0: New `media_buy_seller/dependency_impairment_cardinality` scenario — pressure-tests the `impairment.coherence` inverse rule under cardinality. The base scenario tests forward + inverse + health-iff with one creative on one package, which a buggy seller can pass by emitting any impairment entry whose `resource_id` matches a known-rejected creative. This scenario asserts the seller emits the **right number** of entries, each pointing at the **right resource**.

  Five phases, two creatives (A, B) on two packages (package_a, package_b):

  1. **setup** — create buy with two packages, sync both creatives, assign each to its own package, baseline both at `approved`. Cardinality 0.
  2. **reject_first_cardinality_one** — force A to rejected. Assert exactly one impairment, `resource_id: A`, `package_ids` contains `package_a` only. Catches sellers that emit `package_ids: [package_a, package_b]` (over-scoping) or duplicate entries.
  3. **reject_second_cardinality_two** — force B to rejected. Assert two impairment entries. Catches sellers that merge entries.
  4. **recover_first_via_swap** — swap `package_a` binding from A to fresh creative C. Cardinality back to 1. Catches sellers that don't decrement on swap recovery.
  5. **recover_second_via_swap** — swap `package_b` binding from B to fresh creative D. Cardinality back to 0.

  Failure modes caught beyond the base scenario:

  - Wrong resource_id on an impairment (right cardinality, wrong target).
  - Single impairment with `package_ids` inflated to both packages when only one creative is rejected.
  - Failure to decrement `impairments[]` when an impairment clears partially via swap recovery.

  Wired into `protocols/media-buy/index.yaml#requires_scenarios`. Sellers without `comply_test_controller force_creative_status` or without multi-package support grade `not_applicable`. Same capability gating as the base scenario (`capabilities.media_buy.impairment_propagation: "snapshot"` required for grading).

  Closes #4681.

- 8650fb0: Rewrite `media_buy_seller/dependency_impairment` phase 5 to use **swap-assignment** as the canonical recovery vector instead of same-ID re-approval. In production, buyers rarely re-approve a rejected creative on the same ID — they ship a corrected asset under a new ID and update the package's `creative_assignments`. The previous scenario modeled an uncommon flow and would have failed sellers whose review pipeline treats `rejected` as a hard wall (a legitimate design).

  New phase 5 sequence:

  1. Sync a second creative (B, approved) into the library — not yet assigned.
  2. Force B to `approved` baseline via `comply_test_controller`.
  3. Call `update_media_buy` with `packages[].creative_assignments` (replacement semantics per `package-update.json`) to swap the package's binding from A (rejected) to B (approved).
  4. Read the buy — `health: ok`, `impairments[] empty`. Creative A's library status stays `rejected` but A is no longer a dependency of any package on this buy, so the impairment clears.

  Scenario `version` bumped 1.0.0 → 2.0.0 to mark the recovery semantics change. `required_tools` adds `update_media_buy`. Narrative explicitly notes that same-ID re-approval is covered by a future opt-in sibling scenario (`media_buy_seller/dependency_impairment_reapprove_recovery`) for sellers whose review flow supports the reinstatement path.

  Closes #4682.

- 8650fb0: New capability `capabilities.media_buy.impairment_propagation` on `get_adcp_capabilities` — sellers declare how they propagate dependency-resource impairments (creative rejection, audience suspension, catalog withdrawal, event source insufficient, property depublication) to buyers.

  Three postures, each a real-world pattern:

  - **`snapshot`** (default) — seller populates `media_buy.health` and `media_buy.impairments[]` on `get_media_buys` reads. The `impairment.coherence` compliance assertion grades the propagation. Premium guaranteed sellers tend toward this.
  - **`webhook_only`** — seller fires `notification-type: impairment` webhooks but does NOT mirror the impairments on the buy snapshot. Buyers reconcile state from the push channel alone. High-throughput SSPs / DSPs tend toward this when state lives in the event stream.
  - **`out_of_band`** — seller propagates outside the AdCP protocol surface entirely (email to trafficker, dashboard, partner-specific notification feed). Long-tail and enterprise-bundled platforms tend toward this.

  Sellers declaring `webhook_only` or `out_of_band` are not graded by the `impairment.coherence` storyboard scenarios (`dependency_impairment`, `dependency_impairment_cardinality`) — those grade `not_applicable` for those postures. Their compliance bar is the webhook contract or the offline agreement, not snapshot coherence.

  Docs: `lifecycle.mdx § Compliance` extended with a paragraph describing the capability and how it gates the snapshot-coherence rules. Each posture documented as a legitimate operational pattern, not a workaround.

  Runtime gating in the compliance runner is the adcp-client follow-up — once the runner reads the capability and grades `not_applicable` accordingly, the storyboard scenarios will skip cleanly on `webhook_only` / `out_of_band` sellers. Spec-side declaration ships in this PR; runner-side `not_applicable` enforcement tracked in the adcp-client follow-up.

  Closes #4683.

- 4d4c9a0: Restructure `capabilities.media_buy.impairment_propagation` from a single-value enum to `capabilities.media_buy.propagation_surfaces` (non-exclusive array). The enum couldn't express the common case where a seller propagates impairments on both the buy snapshot AND fires webhooks (GAM, FreeWheel, CM360) — the previous shape forced a choice between `snapshot` and `webhook_only`, which created an incentive to declare `webhook_only` and dodge the snapshot-coherence bar even when the seller actually does both. The array shape lets sellers declare `["snapshot", "webhook"]` honestly.

  Surface values:

  - **`snapshot`** — `media_buy.health` + `media_buy.impairments[]` mirror impairments on `get_media_buys` reads. Graded by `impairment.coherence` storyboards when declared.
  - **`webhook`** — `notification-type: impairment` webhooks fire via `push_notification_config`. Graded by the persistent-channel webhook contract.
  - **`out_of_band`** — propagation via channels outside the AdCP protocol surface (email, dashboard, partner-specific feeds). Compliance bar is the offline agreement, not a protocol assertion. Sellers with a non-AdCP-field mapping gap (e.g., `media_buy.delivery_status_detail` instead of `media_buy.health`) SHOULD document the mapping rather than declare `out_of_band` — the spec's gap is what this value legitimately covers.

  Default when absent: `["snapshot"]` (preserves current snapshot-coherence contract for sellers that don't declare).

  Storyboard gating: `impairment.coherence` scenarios (`dependency_impairment`, `dependency_impairment_cardinality`) grade `not_applicable` when `propagation_surfaces` does not include `"snapshot"`. Sellers declaring `["snapshot", "webhook"]` are graded on the snapshot surface here and on the webhook contract separately.

  Pre-release breaking change to the freshly-shipped `impairment_propagation` enum (landed in PR #4685 but unreleased — 3.1.0 GA is 2026-05-29). No deprecation cycle needed; sellers migrating from a pre-release adoption translate single values to one-element arrays.

  Closes #4686.

- 0988b54: Add `field_pattern` / `envelope_field_pattern` compliance check kinds and use the envelope-scoped form to validate `adcp_version` shape in the version-negotiation storyboard.

  Tighten media-buy storyboards that reuse a discovered `pricing_option_id` so auction-priced flows send `bid_price` and fixed-price flows validate the captured option before downstream package creation.

- 56b9b63: feat(compliance): per_creative_attribution capability bit + scenario

  New capability bit and scenario in the capability-claim contract pattern (#4637), landing the deferred per-creative conversion attribution work from #4642 / #4725.

  - `media_buy.conversion_tracking.per_creative_attribution` (boolean, defaults to false) — `static/schemas/source/protocol/get-adcp-capabilities-response.json`. Declares whether the seller can attribute conversions to specific creatives within a package and surface that breakdown via `media_buy_deliveries[].by_package[].by_creative[].conversions` in `get_media_buy_delivery`. Optional; omission means `false` and is backward-compatible.
  - `media_buy_seller/per_creative_conversion_attribution` — new scenario gated on `media_buy.conversion_tracking.per_creative_attribution: true`, added to `sales-non-guaranteed.requires_scenarios`. Registers two distinct display creatives via `sync_creatives`, creates a media buy whose single package's `creative_assignments` references both, logs two purchase events against the bound event source, simulates delivery, and asserts `by_package[0].by_creative[0..1].{creative_id,conversions}` are populated. The second-row assertion is the asymmetry check that separates honest per-creative attribution from a single-row façade collapsing attribution to whichever creative the seller tracked first.

  Closes the gap deliberately left by `performance_buy_flow` (#4642), whose narrative explicitly defers per-creative attribution: honest adopters report at differing granularities — social platforms per-ad, retail-media networks (Criteo, Amazon Ads) per-line, MMP-mediated mobile (post-iOS-14) per-campaign / per-ad-set, broadcast and CTV performance products per-placement. Requiring per-creative in the base CPA scenario would have failed those honest implementations. The bit gates the scenario; sellers that don't advertise it grade `not_applicable`.

  `log_event`'s payload (`core/event.json`) does NOT carry `creative_id` — attributing each event back to a specific creative is the seller's internal click / view-through correlation, not the buyer's. The scenario logs two events with distinct `event_ids` and relies on the seller's correlation to spread `simulate_delivery`'s `conversions` count across the two assigned creatives in the `by_creative[]` breakdown.

  No training-agent changes — the training agent does not declare `per_creative_attribution`, so the scenario grades `not_applicable` against the reference implementation and CI passes. Same anti-façade pattern as `event_dedup_flow` (#4664) and `frequency_cap_enforcement` (#4640): the bit gates the scenario, the assertion targets the runtime behavior the bit commits to.

  Refs: #4725 (capability bit + scenario), #4637 (capability-claim meta), #4642 (performance_buy_flow that deferred this), #4639 (supported_targets bit for the sibling ROAS gate).

- 9357289: Catalog sync cluster (3.1): three companion proposals for catalog mirroring between AdCP agents and consumers (storefronts, federated marketplaces, registries). Independent and complementary — agents MAY adopt any subset.

  **#4762 — `get_signals` wholesale discovery mode**

  - `signals/get-signals-request.json` adds `discovery_mode` enum (`brief` default, `wholesale`). Wholesale mode bans `signal_spec` / `signal_ids` and returns the agent's full priced catalog, paginated. Symmetric with `get_products buying_mode: "wholesale"`.
  - `signals/get-signals-response.json` adds `incomplete[]` (scopes: `signals`, `pricing`, `catalog`) so partial completion is signalled inline rather than via async/Submitted handoff. `signals` becomes conditionally required (omitted when `unchanged: true`).
  - `protocol/get-adcp-capabilities-response.json` adds `signals.discovery_modes`. Agents not declaring `"wholesale"` MAY return `INVALID_REQUEST` for wholesale calls.
  - `docs/signals/tasks/get_signals.mdx` documents wholesale enumeration, authorization/provenance preservation for marketplace signals, pricing scope, and capability probing.

  **#4761 — `catalog_version` conditional fetch (ETag-style)**

  - `media-buy/get-products-request.json` and `signals/get-signals-request.json` add `if_catalog_version` and `if_pricing_version` opaque tokens.
  - `media-buy/get-products-response.json` and `signals/get-signals-response.json` add `catalog_version`, `pricing_version`, and `unchanged`. When `unchanged: true`, `products` / `signals` MUST be omitted and `catalog_version` MUST be echoed — encoded as an explicit `oneOf` so the unchanged response is schema-valid without breaking the standard required-payload contract.
  - Tokens are opaque and scoped to the request-parameter tuple that produced them. Pre-v3.1 agents that ignore the conditional fields simply return the full payload — semantically correct, just inefficient.
  - Pagination interaction: if the catalog mutates mid-pagination, sellers SHOULD return the new `catalog_version` on each page; consumers SHOULD restart from `cursor: null` on a mid-pagination version change.

  **#4763 — Per-agent catalog change feed**

  - New `specs/catalog-change-feed.md` modeled on `specs/registry-change-feed.md`. UUID-v7 cursor-based event log, one feed per agent, denormalized payloads, optional webhook subscriptions.
  - Event types: `product.{created,updated,priced,removed}`, `signal.{created,updated,priced,removed}`, `catalog.bulk_change` (fast-forward for rate-card sweeps).
  - `protocol/get-adcp-capabilities-response.json` adds top-level `catalog_change_feed` declaration (`supported`, `retention_window_days` ≥7, `webhooks_supported`, `event_types[]`).
  - Endpoints (`GET /catalog/events`, `POST /catalog/subscriptions`) live on the agent itself, not the registry. Authorization scope mirrors wholesale enumeration.

  Additive across the board for 3.0-conformant agents: new optional fields, new conditional schemas, new capability stanzas, new spec doc. Agents MAY implement any combination: conditional-fetch alone for cheap probes against stable catalogs, the full feed for high-frequency mirroring, wholesale-only as a transitional step. Reference implementations land in the prebid salesagent as part of v3.1 conformance prep.

  **Validator obligation for 3.1 SDKs (read carefully):** the 3.1 `get_products` / `get_signals` response schema makes `cache_scope` required to enforce the two-layer cache safety invariant — a seller that silently omits `cache_scope` on an account-scoped response would cause buyers to mis-key the cache and serve account-overlay payloads to other accounts. Pre-3.1 sellers correctly omit `cache_scope` and remain conformant to their declared version. SDKs that validate strictly against the 3.1 schema MUST select the validator based on the server-declared `adcp_version` (release-precision version negotiation, 3.1): for responses with `adcp_version` starting `3.0`, the 3.1 cache_scope-required constraint MUST be relaxed. This is a tightening within 3.1, not a 3.0 break — but adopter SDKs that hardcode the 3.1 schema without version-pinned validation will reject correct 3.0 traffic, so the obligation is normative.

  Refs #4761, #4762, #4763.

- 8fcf7f9: Add published registry change-feed schemas for `/api/registry/feed`.

  The new `core/registry-feed-response.json` wrapper references `core/registry-event.json`, which now validates the current registry event vocabulary across property, agent, publisher, and authorization changes. Registry docs and specs now cite the schemas and align examples with the implemented cursor and filter contract.

- 4c12454: spec: PR #4796 review follow-ups — close 7 footguns surfaced by detailed review.

  Consolidated fixes from a careful review of the 10-commit WG-review batch. None change the underlying decisions — they close gaps in the contract surface that careful adopters would have hit in production.

  **Polling / state re-read MUST mint a fresh `idempotency_key`.** The original §Idempotency guidance covered network-retry (reuse key) and agent-replan (new key) but was silent on polling reads and state re-reads. Under universal idempotency from 3.1, reusing a prior poll's key returns the cached snapshot for up to `replay_ttl_seconds` — the dashboard polling `get_products(brief)` or buyer agent reading `get_media_buys` after a mutation gets stale data, silently. Added a third case to the retry-vs-replan classification: **polling / state re-read** intent is "give me current state at time T," and MUST mint a fresh key per call. The same rule now governs the re-read step in the [Replay responses are historical snapshots] pattern — the re-read key MUST be fresh, never the mutation's key (which would return `IDEMPOTENCY_CONFLICT` or, worse, the cached mutation response).

  **Bootstrap carve-out for `get_adcp_capabilities`.** The fail-closed-on-missing-TTL rule deadlocked the bootstrap — the discovery call is _how_ the buyer learns whether the seller declares `replay_ttl_seconds`. Made explicit: `get_adcp_capabilities` is exempt from rules 1–9; buyers MAY omit `idempotency_key` on the discovery call; sellers MUST accept the call without it. Fail-closed applies to every subsequent task request after the capability fetch.

  **Rate-limit ceilings flipped from "operators SHOULD revisit" to concrete read/write split.** A 3.1 agentic dashboard polling `get_products(brief)` + `list_creatives` + `list_accounts` across 5 accounts at 1Hz is ~15 inserts/sec on reads alone, before any write traffic. The original 60/sec sustained ceiling would silently rate-limit legitimate read polls. New recommended ceilings: **Reads 300/sec sustained / 1,500/sec burst, Writes 60/sec sustained / 300/sec burst, Combined cap 350/sec sustained / 1,700/sec burst**. The split-budget shape (separate counters) MUST be implemented from 3.1 onward even when operators tighten the magnitudes — a shared single-budget cap is the failure mode this rule prevents (a buyer's dashboard polling can't starve write capacity that protects `create_media_buy` / `sync_creatives` / `activate_signal`).

  **Multi-finalize atomicity contract clarified — observation point, not rollback.** "Atomic" was ambiguous: was the seller obligated to roll back if proposal A finalized but proposal B failed mid-commit? There's no `unfinalize` operation, so rollback was an unspecified obligation. Made explicit: atomicity runs on the pre-commit validation gate — sellers MUST NOT return success unless every named proposal has both completed and persisted; if any proposal fails validation, the seller MUST reject the entire call without committing any. Mid-commit failure (post-validation, pre-persist) MUST return `INTERNAL_ERROR` with `refinement_applied[]` per-position outcomes; recovery is undefined at the protocol level and buyers SHOULD re-read state before retrying. Buyer-intent caveat added: buyers whose intent specifically required atomic commit (budget-shared proposals) MUST be prepared to abandon the intent if the seller returns `MULTI_FINALIZE_UNSUPPORTED` — there is no recovery for that loss of intent beyond accepting the looser sequential-commit guarantee.

  **`context` envelope/body relationship documented.** 147 task request/response schemas already declare body-level `context` `$ref`'ing `core/context.json`. With #2911 adding `context` to the envelope, the field exists in two places. Under flat MCP serialization the two declarations occupy the same wire key — they're the same field, not a collision. Made explicit: envelope declaration is **authoritative**; per-task body declarations are mirrors retained for tooling reasons (SDK codegen completeness, per-task validation in isolation). Future versions MAY drop the body-level declarations; conformance does not require either to be present, only that the wire value `$ref`s `core/context.json`.

  **Forward-compat decoding ↔ Retry Logic symmetric cross-link.** The original cross-link was Forward-compat → Retry Logic (one direction). A reader landing on Retry Logic didn't see that the `transient` default for unknown codes was bounded there. Added a back-link paragraph at the top of `## Retry Logic`: "The rules in this section bound every `transient`-classified error, including the `transient` default applied to unknown error codes under § Forward-compatible decoding."

  **`pending_creatives` sharpening landed in `media-buys/index.mdx`.** The original #4196 fix landed only in the enum description on `media-buy-status.json`. Readers landing on the lifecycle doc at `docs/media-buy/media-buys/index.mdx` saw only the old "Approved but no creatives assigned" framing. Mirrored the buyer-side-action-required + `pending_X` naming convention into the lifecycle doc.

  **Strict-validator adopter-action row added.** The 7-row adopter-action table in 3.1.0 release notes didn't call out adopters with strict-validator test fixtures or codegen against `core/protocol-envelope.json`. Dropping `required: [status, payload]` is a JSON-Schema-level relaxation — strict validators that asserted "envelope MUST reject responses missing payload" will start accepting envelopes they used to reject. Added an 8th row noting the fixture refresh and codegen audit (OpenAPI / quicktype / Pydantic consumers will see `status` and `payload` flip from required to optional in generated types).

  Files:

  - `docs/building/by-layer/L1/security.mdx` — polling/re-read paragraph (renamed "network retry vs. agent re-plan vs. polling / state re-read"), bootstrap carve-out for `get_adcp_capabilities`, split read/write ceilings in rule 8, fresh-key requirement in Replay responses section
  - `docs/building/by-layer/L3/error-handling.mdx` — back-link paragraph at top of `## Retry Logic`
  - `docs/media-buy/product-discovery/refinement.mdx` — atomicity-at-observation-point clarification, mid-commit failure paragraph, buyer-intent caveat
  - `docs/media-buy/media-buys/index.mdx` — `pending_creatives` description mirrors the buyer-side-action sharpening
  - `docs/reference/release-notes.mdx` — strict-validator adopter-action row (8th)
  - `static/schemas/source/core/protocol-envelope.json` — `context` envelope/body relationship explained on the envelope declaration
  - `static/schemas/source/media-buy/get-products-request.json` — refine[] description gains observation-point atomicity + mid-commit failure + buyer-intent caveat

  Refs PR #4796 review comments. No new behavior; closes gaps in the existing contract.

- 41fce13: spec(envelope): `status` is REQUIRED on every task response envelope.

  The protocol envelope (`core/protocol-envelope.json`) now declares `status` in its `required` array, formalizing the wire contract the docs and conformance storyboards already assume. Every task response — including synchronous read-only metadata calls like `get_adcp_capabilities` — MUST carry a top-level `status` field. Synchronous calls emit `status: "completed"`; async calls emit `submitted`, `working`, `input-required`, etc. per the task-status enum.

  **Why this is a wire-shape clarification, not a new requirement.** The docs (`sdk-stack.mdx`, `mcp-response-extraction.mdx`, `webhooks.mdx`, `error-handling.mdx`) already treat envelope `status` as a canonical protocol-layer field. The `v3_envelope_integrity` conformance storyboard already asserts presence via `envelope_field_present`. The schema design just left `status` declared but not required on the envelope, which let SDKs ship without emitting it on some sync responses. This change closes that ambiguity.

  **Resolves #4832** — adopter (`@adcp/sdk@7.7.0`, production seller) hit `v3_envelope_integrity/no_legacy_status_fields` failure because the SDK's auto-registered `get_adcp_capabilities` handler builds the response payload without setting `status`. The storyboard was correct; the envelope contract just wasn't formalized in schema.

  **Adopter impact.** Agents shipping responses without top-level envelope `status` are now non-conformant per the schema. The single broadly-distributed gap is `@adcp/client`'s auto-registered `get_adcp_capabilities` (tracked separately); other tools that go through the v6 handler pipeline already carry `status` because the SDK threads the envelope around typed platform returns. Adopters using raw-handler patterns (deprecated v5) should audit their responses and add `status: "completed"` to any sync response missing it.

  **Phased follow-ups (not in this PR):**

  - SDK companion in `adcp-client`: emit `status: "completed"` on the auto-registered `get_adcp_capabilities` handler (and audit any other sync helper that builds responses without the v6 pipeline).
  - Per-task schema fold: extend each of the 64+ task response schemas (`create-media-buy-response.json`, `sync-creatives-response.json`, etc.) to `$ref` `protocol-envelope.json` in addition to `version-envelope.json`. Mechanical cleanup that lets per-task `response_schema` validators catch envelope omissions directly, without relying on the separate `envelope_field_present` storyboard check. Targeted for the 3.1 cycle ahead of GA.

- ca60b16: spec/chore(envelope-fold): close 3 brand-schema body-`status` collisions surfaced by #4878, normalize schema-source UTF-8, harden pre-push hook.

  Follow-up bundle to PR #4896 (envelope-fold). Three brand response schemas had body-level `status` collisions with the envelope `status` (TaskStatus) that the fold didn't carve out; left unfixed they were jointly unsatisfiable on the per-task validator. Two non-spec improvements (UTF-8 normalization, pre-push hook trap) landed alongside since they were touching the same surface.

  ## Brand-schema body-`status` renames

  Same pattern as #4895 (media-buy) and #4897 (governance), applied to three brand-protocol response schemas:

  - **`brand/verify-brand-claim-response.json`** — `status` → `verification_status` ($ref unchanged: `brand/verification-status.json`). Updated `required[]` and the error branch's `not.anyOf` discriminator clause. Schema is NOT `x-status: experimental` but is pre-3.1-GA, so beta-cycle rename is acceptable.
  - **`brand/creative-approval-response.json`** — `status` → `approval_status` (const discriminator: `approved` | `rejected` | `pending_review`). Renamed across all four oneOf branches (3 success + 1 error), all `required[]` lists, and the error branch's `not.anyOf` clause. Not experimental.
  - **`brand/acquire-rights-response.json`** — `status` → `rights_status` (const discriminator: `acquired` | `pending_approval` | `rejected`). Renamed across all four oneOf branches, all `required[]` lists, and the error branch's `not.anyOf` clause. Schema is `x-status: experimental` so hard rename is sanctioned.

  Docs swept:

  - `docs/brand-protocol/tasks/verify_brand_claim.mdx` — 10 example bodies renamed `status` → `verification_status`.
  - `docs/brand-protocol/tasks/acquire_rights.mdx` — 4 example bodies renamed `status` → `rights_status`.
  - `docs/brand-protocol/walkthrough-rights-licensing.mdx` — 4 example bodies renamed `status` → `rights_status`.

  Why now (vs deferring to a separate PR): the doc-injector in #4878 correctly skipped these three files because the schema-level collision was detectable in advance. Closing them in the same PR keeps the envelope-fold contract whole — every per-task response schema admits at least one valid response with envelope `status: "completed"` post-merge.

  ## Training-agent envelope-status fixes (server, not spec)

  `server/src/training-agent/task-handlers.ts`:

  - **Idempotency replay path** (L4547-4561) now stamps `status: 'completed'` if the cached inner response lacks one. Older cache entries written pre-envelope-fold are auto-upgraded on replay. Without this, every cache hit on a folded schema fails its own per-task validator.
  - **`handleCreateMediaBuy` / `handleUpdateMediaBuy` cancel branch / `handleUpdateMediaBuy` non-cancel branch** now emit `media_buy_status: MediaBuyStatus` instead of body `status: MediaBuyStatus` (canonical 3.1 form per #4895). The envelope-stamp guard at L4622-4623 then sets envelope `status: 'completed'` cleanly. Without this, MediaBuyStatus values like `pending_creatives` / `active` would survive the guard and fail TaskStatus validation.

  Nested `media_buys[].status` and `media_buy_deliveries[].status` (get_media_buys and get_media_buy_delivery handlers) are intentionally left as `status` — the cascade is deferred to 4.0 (#4905) per #4895's Option-E-pure scope.

  ## Doc fix (signals/activate_signal)

  `docs/signals/tasks/activate_signal.mdx:466` — "Error Response (Failed)" example was mis-injected with `status: "completed"`. Corrected to `status: "failed"`. Aligns with the `error-handling.mdx` two-layer model: envelope `status: "failed"` + `errors[]` + optional `adcp_error`.

  ## Schema-source UTF-8 normalization (chore)

  48 schema source files re-encoded by some prior tooling using `\uXXXX` escape sequences for printable non-ASCII characters (em-dashes, en-dashes, smart quotes). Same character semantically, but inflates diffs and obscures real changes — was the dominant source of noise in #4896's review.

  - `scripts/normalize-schema-utf8.mjs` — targeted normalizer that only rewrites `\uXXXX` escapes for printable non-ASCII BMP characters. Does NOT touch JSON-required escapes, surrogates, control characters, whitespace, property order, or anything else. Round-trip sanity check via `JSON.parse`.
  - `npm run fix:schema-utf8` — apply normalization.
  - `npm run test:schema-utf8` — CI guard. Added to the master `test` chain so regressions are caught at PR time.

  ## Pre-push hook hardening (chore)

  `.husky/pre-push` — `dist/docs` / `dist/addie/rules` / `.addie-repos` / `.context` are moved to `/tmp/.prepush-<name>-<pid>` before the Mintlify broken-links check, then restored. If interrupted, the temp dir was orphaning into `dist/docs/.prepush-<name>-<pid>/`. Now:

  - Trap `EXIT / INT / TERM` to restore on any exit path.
  - Idempotent restore (only moves if source exists AND dest doesn't).
  - `.gitignore` entry `.prepush-*/` and `dist/docs/.prepush-*/` as belt-and-suspenders.

  ## Test verification

  - `npm run build:schemas` — clean
  - `npm run test:schemas` — 8/8
  - `npm run test:examples` — 36/36
  - `npm run test:composed` — 43/43
  - `npm run test:json-schema` — 270/270
  - `npm run test:schema-utf8` — passes
  - `npx vitest run server/tests/unit` — 3760/3760 pass (233 test files)

- ca60b16: spec: fold `protocol-envelope.json` into per-task response schemas

  Closes #4878. Companion to #4876 (envelope `status` REQUIRED) — that PR locked the contract on the envelope schema; this PR cascades it to every per-task response schema so per-task `response_schema` validators catch envelope omissions directly, without relying on the separate `envelope_field_present` storyboard check.

  **What changed.** 64 task response schemas now `$ref` `core/protocol-envelope.json` in their `allOf` chain alongside the existing `core/version-envelope.json` ref. Two schemas without an existing `allOf` (`brand/search-brands-response.json`, `creative/validate-input-response.json`) had `allOf` added with both envelope refs for consistency.

  **Carve-outs.**

  - `core/pagination-response.json`, `core/catalog-events-response.json` — nested helpers, not task responses. Excluded.
  - `governance/check-governance-response.json`, `governance/report-plan-outcome-response.json` — body-level `status` enum (`approved`/`denied`/`conditions` and `accepted`/`findings` respectively) collides with envelope `status` (task-status enum) on MCP flat serialization. Excluded; tracked as a separate spec issue.

  **What this catches in adopter shape.** Pre-3.1-GA, any response shape lacking top-level envelope `status` now fails its own per-task `response_schema` validator, not just the universal `envelope_field_present` storyboard step. Validators integrated against the per-task schema (typed-SDK codegen, request-replay tooling, schema-aware test fixtures) gain envelope coverage for free.

  **Cleanup also applied.** 25 schema examples in the affected response schemas were updated to include `status: "completed"`. 62 JSON blocks in the docs (across 27 `.mdx` files) were updated likewise. Test fixtures in `tests/composed-schema-validation.test.cjs` and `tests/example-validation-simple.test.cjs` were updated to include `status` on the relevant cases — surface-aligned with the schema fold so the test suite continues to assert what conformant adopters MUST send.

  **SDK companion (filed separately as #4877).** `@adcp/client`'s auto-registered `get_adcp_capabilities` handler needs to emit `status: "completed"` for adopter responses to remain conformant; that's the going-forward fix in the SDK repo.

  **Body-status conflict tracked as follow-up.** The two carve-outs (`check_governance`, `report_plan_outcome`) need their body discriminator field renamed (e.g. `verdict` / `decision`) ahead of 3.1 GA. Filing as a separate spec issue.

- 06abeab: spec(media-buy): add `media_buy_status` field on create_media_buy and update_media_buy success responses; deprecate top-level `status` (#4895).

  Under MCP flat-on-the-wire serialization, the envelope task-status (`status`, drawn from `task-status.json`) and the body-level `MediaBuyStatus` (`status`, drawn from `media-buy-status.json`) share the same root key on `CreateMediaBuySuccess` and `UpdateMediaBuySuccess`. The two enums overlap on `completed | canceled | rejected` and diverge elsewhere — a `MediaBuyStatus: 'active'` is silently destroyed when the envelope stamps a TaskStatus at the same path, and no validator catches it.

  WG-recommended Option E (additive-deprecate, 3.1 minor → 3.2 removal of legacy `status` (#4906) → 4.0 nested cascade (#4905)) per the issue triage. **Strictly additive in 3.1 — no schema is renamed and no `required[]` constraint changes.**

  - **`media-buy/create-media-buy-response.json`** (`CreateMediaBuySuccess` branch) — adds `media_buy_status: $ref media-buy-status.json` alongside the existing `status` field. The legacy `status` is marked `deprecated: true` (description) and slated for removal in 3.2 (#4906). Both fields are optional in 3.1; neither was in `required[]` before and neither becomes required now. The `CreateMediaBuySubmitted` branch is unchanged — its `status: { const: "submitted" }` is the TaskStatus discriminator, not a MediaBuyStatus.
  - **`media-buy/update-media-buy-response.json`** (`UpdateMediaBuySuccess` branch) — symmetric: adds `media_buy_status`, marks legacy `status` as deprecated. Both optional.

  **Not in scope** (deliberate — see below): `get-media-buys-response.json` `media_buys[].status`, `get-media-buy-delivery-response.json` `media_buy_deliveries[].status`, and `core/media-buy.json` `status`. These fields live nested inside arrays at depth ≥ 1, so the envelope `status` at the response root does not collide with them on the wire. The nested-vocabulary inconsistency in 3.1 (one buyer call returns `media_buy_status` at root, the next returns `status` inside an array) is mildly annoying but the price of keeping the change strictly additive — renaming a nested field that 3.0 sellers already emit would require either a `required[]` swap (breaking) or a double-fielded transition (schema churn for no wire-collision payoff). Resolve in 4.0 alongside the legacy-`status` removal, when a clean cascade rename is on the table.

  The synthetic `cancel_media_buy` response (issue body called this out as a separate scope question) is performed via `update_media_buy` with cancel intent — there is no dedicated `cancel_media_buy` tool. Inherits the rename from `UpdateMediaBuySuccess` for free. No separate schema change.

  Storyboards swept:

  - `protocols/media-buy/state-machine.yaml` — three `field_present path: "status"` assertions against `update-media-buy-response.json` updated to `path: "media_buy_status"`. Under additive-deprecate, 3.1-conformant sellers SHOULD emit `media_buy_status`; the assertion documents the canonical-field expectation.
  - `protocols/media-buy/scenarios/pending_creatives_to_start.yaml` — two `field_value` assertions checking MediaBuyStatus values against `create-media-buy-response.json` and `update-media-buy-response.json` updated to `path: "media_buy_status"`.
  - `protocols/media-buy/scenarios/create_media_buy_async.yaml` — left as `path: "status"`: this checks the `submitted`-arm TaskStatus discriminator, not a MediaBuyStatus.

  Docs:

  - `docs/media-buy/task-reference/update_media_buy.mdx` — the cancellation success-response example shows the canonical `media_buy_status` form.
  - `docs/reference/whats-new-in-3-1.mdx` — migration note in Final-spec clarifications batch.

  Adopter impact:

  - **Sellers (3.1+):** SHOULD emit `media_buy_status` on `create_media_buy` and `update_media_buy` success responses. MAY continue to emit the legacy top-level `status` during the deprecation window — both fields are valid in 3.1.
  - **Buyers (3.1+):** MUST prefer `media_buy_status` when present. MAY fall back to the legacy `status` during the deprecation window for compatibility with sellers still on the legacy form.
  - **3.0 sellers and buyers:** continue to work unchanged. The schema remains backward-compatible — no required-field swap, no rename, no breakage. The `get-media-buys-response`, `get-media-buy-delivery-response`, and `core/media-buy.json` surfaces are untouched, so the nested `status` field 3.0 emitters already produce continues to validate.
  - **3.2:** the deprecated top-level `status` on the success branches of `create-media-buy-response.json` and `update-media-buy-response.json` is removed (#4906). The deprecation window is intentionally short — storyboard certification already forces 3.1-conformant sellers off the legacy field, so carrying it longer would just mean SDK consumers hold two fields in generated types for no operational benefit. After 3.2, top-level `status` on these responses unambiguously carries envelope TaskStatus only.
  - **4.0:** the nested `status` cascade lands (#4905) — `media_buys[].status` on `get-media-buys-response`, `media_buy_deliveries[].status` on `get-media-buy-delivery-response`, and `status` on `core/media-buy.json` rename to `media_buy_status`. Genuinely breaking (a `required[]` swap), held to the major.
  - SDK regen required for `@adcp/client`, `adcp-go`, and the Python client. The `@adcp/client` transport precedence fix (adcontextprotocol/adcp-client#1898) already drafts the consumer-side logic.

  Related:

  - #4876 — envelope `status` REQUIRED (beta.2).
  - #4897 — companion governance schema rename (separate PR).
  - adcontextprotocol/adcp-client#1898 — SDK-side audit and transport precedence fix.

- 989da51: spec(governance): rename body-level `status` on `check_governance` and `report_plan_outcome` responses to free the envelope `status` key (#4897).

  Under MCP flat-on-the-wire serialization, the envelope task-status (`status`, drawn from `task-status.json`) and the body-level governance field share the same root key. The two enums overlap on `completed | canceled | rejected` and diverge elsewhere; whichever side wins on the wire, the other is silently destroyed and no validator catches it.

  Resolution (WG-recommended Option A per the issue triage):

  - **`governance/check-governance-response.json`** — `status` → `verdict`. Enum unchanged (`approved | denied | conditions`); `if/then` discriminator blocks now key on `verdict`. Renamed in `required[]`. Description threads (`findings`, `conditions`, `expires_at`) updated to reference the new name.
  - **`governance/report-plan-outcome-response.json`** — `status` → `outcome_state`. Enum unchanged (`accepted | findings`); renamed in `required[]`. Description thread on `findings` updated.
  - **`governance/get-plan-audit-logs-response.json`** — `entries[].status` → `entries[].verdict` (cascade for vocabulary consistency with check-governance-response). Other `status` fields (`plans[].status`, `governed_actions[].status`) are lifecycle states, not verdicts, and are left unchanged.

  Docs swept (~25 example bodies + table descriptions):

  - `docs/governance/overview.mdx`
  - `docs/governance/campaign/tasks/check_governance.mdx` (7 examples + response table + prose)
  - `docs/governance/campaign/tasks/report_plan_outcome.mdx` (5 examples + response table)
  - `docs/governance/campaign/tasks/get_plan_audit_logs.mdx` (2 nested check entries)
  - `docs/governance/campaign/audit-trail.mdx` (7 example bodies + field-tagging table)
  - `docs/governance/campaign/specification.mdx` (3 examples)

  Storyboards swept (the issue triage initially scoped this as "no yaml renames needed"; corrected during implementation):

  - `static/compliance/source/specialisms/governance-spend-authority/index.yaml` — `field_present path: "status"` → `path: "verdict"`
  - `static/compliance/source/specialisms/governance-spend-authority/denied.yaml` — both `field_present` and `field_value` assertions
  - `static/compliance/source/specialisms/governance-delivery-monitor/index.yaml` — two `field_present` assertions
  - `static/compliance/source/protocols/governance/index.yaml` — two `field_present` assertions plus a stale `outcome.expected` block referencing `status: recorded` (not in the enum) → corrected to `outcome_state: accepted`

  Adopter impact:

  - Wire-shape change on three experimental governance schemas (`x-status: experimental`).
  - Buyers and sellers rename one property name per emitter / consumer; enum values are unchanged.
  - SDK regen required for `@adcp/client`, `adcp-go`, and the Python client. Per the experimental-surface contract, this is a sanctioned 3.1 pre-GA adjustment.

  Related:

  - #4876 — envelope `status` REQUIRED (beta.2).
  - #4895 — companion media-buy collision (separate PR).
  - #4896 — per-task envelope fold. Once this PR lands, the carve-outs for `check-governance-response.json` and `report-plan-outcome-response.json` in #4896 can be removed; both schemas pick up the standard envelope fold cleanly.

- 4adb65a: spec(errors): register `STALE_RESPONSE` for cache-fallback served when an upstream is unreachable (#4899)

  The existing error vocabulary covered the binary "upstream unreachable, no response" case (via `SERVICE_UNAVAILABLE`) but had no registered code for the **degraded-but-functional** case: an upstream or sub-agent is unreachable now, but the seller has a cached prior response and serves that cache instead of returning empty. Without a standard code, every seller either invents a discriminator (`STALE_CACHE` / `CACHED_FALLBACK` / `DEGRADED_RESPONSE` / ...) or returns `SERVICE_UNAVAILABLE` with a populated payload — internally contradictory, since the call did succeed from the caller's POV.

  This change:

  - Adds `STALE_RESPONSE` to `static/schemas/source/enums/error-code.json`. Recovery: `transient`. Emitted **alongside** a populated success payload as a non-fatal advisory in `errors[]`; transport-level success markers stay flipped to success (HTTP 200, MCP `isError: false`, A2A `succeeded`). Sibling to the existing per-asset advisory family (`PIXEL_TRACKER_LOSSY_DOWNGRADE`, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE`).
  - Adds `error-details/stale-response.json` — required `served_from_cache: true` + `cache_age_seconds`, optional `freshness_target_seconds`, `upstream: {url, name}`, and `original_error: {code, message}`. Multi-upstream cases emit one `STALE_RESPONSE` entry per stale upstream (mirroring the per-asset advisory precedent), not one aggregated entry.
  - Adds the System-errors-table row in `docs/building/by-layer/L3/error-handling.mdx` with the distinction from `SERVICE_UNAVAILABLE` (empty payload + fatal).
  - Adds the disposition entry in `scripts/error-code-drift-dispositions.json` (`held-for-next-minor`, `target_version: 3.1`).

  **Normative wire rules.** Sellers MUST emit `STALE_RESPONSE` only when the response payload is non-empty AND derived from a cache entry past the surface's freshness target. When no cached entry exists or the cache hit is within freshness target, sellers MUST NOT emit this code. Buyers MUST treat as non-fatal and SHOULD surface staleness to operators or end users where relevant; `cache_age_seconds` is the informational knob for the buyer's retry policy.

  Closes #4899.

- d08dcea: Clarify durable `sync_accounts.accounts[].notification_configs[]` semantics:
  omitted means unchanged, `[]` clears the account's subscribers, and a non-empty
  array replaces the account-scoped set keyed by `subscriber_id`.

  The account-level subscription surface remains limited to account-anchored
  resource events already defined in `notification-type.json`; it does not define
  `account.*` lifecycle events. Account status changes remain observable through
  `list_accounts` polling or the one-shot `sync_accounts.push_notification_config`
  async-result channel.

  Standardize endpoint proof-of-control for active durable webhook configs,
  including the challenge payload and response schemas, auth-mode binding,
  paused-config behavior, retry guidance, and failure semantics.

- 2c5196b: spec(3.1): clarify publisher-scoped placements and product format-option selectors.

  Adds public placement catalog support in `adagents.json`, keeps seller-private routing fields out of public placement schemas, and introduces structured publisher-scoped `placement_refs` for creative assignment. Product placement IDs remain publisher-scoped; omitted `publisher_domain` is only a legacy single-publisher fallback.

  Renames the beta buy-side canonical-format selector from `capability_*` to `format_option_*`. `FormatOptionRef` now selects publisher-catalog-backed options by `{scope: "publisher", publisher_domain, format_option_id}` and product-local options by `{scope: "product", format_option_id}` in the package's target product context. Pre-GA `capability_ids` / `capability_id` request fields are rejected instead of silently accepted.

- 17a648c: Add account-level `notification_configs[]` lifecycle and semantic rejection storyboards for 3.1, plus an exact `list_accounts.account` filter so buyers can re-read one account by seller account ID or natural key. The training agent now supports the new account-level notification configuration contract and the release gates exercise both current 3.1 storyboards and 3.0 compatibility.
- 752d586: Add dimensional and measurement-aware fields to delivery forecast points.

  `ForecastPoint` now supports dimensional rows for geography, placement, device, platform, audience, and intersections such as placement x country via `dimensions`, letting sellers expose country and placement availability without splitting one sellable product into product-per-dimension variants. Forecast points also support `viewability` and `vendor_metric_values` using `ForecastRange` values so pre-buy forecasts can mirror delivery reporting while remaining independent of product `pricing_options`. Geo forecast dimensions reuse the existing metro/postal system enums, forecast viewability requires `standard` whenever forecast values are present, and proposal-level rows can carry `product_id` when a dimensional row maps back to an executable product allocation.

- 2a5f0f5: feat(compliance): add typed JCS non-finite controller error

  Adds `JCS_NON_FINITE_NUMBER` to the comply-test-controller `ControllerError.error`
  enum for digest-mode `query_upstream_traffic` responses that cannot be RFC
  8785/JCS-canonicalized because the parsed JSON-like value tree contains a
  non-finite numeric value (`NaN`, `+Infinity`, or `-Infinity`).
  Runner-output and storyboard contracts now state that this case grades the
  affected upstream_traffic digest validation as `not_applicable` and contributes
  to `validations_not_applicable`, not `steps_failed`.

  Closes #5069.

- dc806c3: Clarify media-buy and creative contract edge cases for the 3.1 beta.

  Adds normative guidance for canonical-format matching: legacy named formats are normalized before comparison, product capability checks are directional, under-specified requests do not satisfy fixed product constraints, and range constraints require containment rather than overlap.

  Documents the stored-creative adapter handoff boundary: buyers send only `creative_id` on the AdCP wire, while any generic `id` alias is seller-side adapter compatibility data copied from `creative_id`.

  Tightens media-buy lifecycle semantics by requiring `revision` on create/get/update success responses and requiring `confirmed_at` on created/read media buys while allowing `null` only for provisional buys that already have a `media_buy_id` and are retrievable before seller commitment.

  This is a 3.1 beta schema tightening that catches the schemas up to existing normative `MUST` text for `revision` and commitment timestamps, rather than a new post-GA contract. The nullable `confirmed_at` shape is buyer-observable (`string | null` instead of only `string`) so buyers can distinguish committed synchronous creates from provisional buys that exist but are not yet seller-committed.

- 47001d6: spec(brand): add machine-readable brand guideline constraints

  Adds optional `logos[].id`, `logos[].slots[]`, canonical format `logo_slots[]` and `required_logo_slots[]` hints, plus `visual_guidelines.color_constraints[]`, `logo_usage_rules[]`, and `mark_lockups[]` to make guideline rules enforceable: color pairing matrices, deterministic logo slot selection, logo usage contexts, and co-brand/secondary-mark lockups. Includes two schema-valid fictional fixtures that exercise the new surface without adding real-brand public examples.

- 4d632f7: Add optional `ext` fields to discovery filters for vendor-namespaced,
  seller-specific criteria.

  This closes the schema gap surfaced by adcp-go#277 and tracked for follow-up
  in adcp-go#279: `product-filters.json` already allowed extension keys via
  `additionalProperties: true`, but did not expose the protocol-standard `ext`
  slot. The same request-side filter pattern applied to creative and signal
  discovery filters. Existing wire payloads remain compatible, while generated
  SDKs can now surface discoverable extension objects.

- e5c2694: spec(creative): signal-driven creative fan-out (`signal_conditions[]`) + item-selection strategy (`selection_strategy`), folding #5262.

  Implements RFC #5240 (accepted 2026-06-03; ships `x-status: experimental`). Adds a keep-all PRODUCTION axis for signals to `build_creative`, sibling to the catalog fan-out axis (`max_creatives`, #5219) and distinct from the choose-among `variant_axis`. Rides #5280's advisory-pointer contract: signal pointers inform production but MUST NOT hard-block at the build layer; trafficking-compatibility is enforced reject-at-trafficking on the sales side.

  Strictly additive — no existing agents break. All new fields optional and gated by new capability flags; agents that don't advertise `supports_signal_fanout` behave exactly as today.

  **Experimental.** The whole signal-fanout surface ships `x-status: experimental` under feature id `creative.signal_fanout` (sellers implementing it MUST list it in `experimental_features`), mirroring `creative.evaluator` (#5305). It introduces a new, not-yet-field-tested cross-agent reject-at-trafficking MUST (`SIGNAL_TARGETING_INCOMPATIBLE`), and the numeric condition-compatibility comparison (range-overlap vs exact-match) plus the `proximity` geo-input binding stay WG-open — experimental status keeps both revisable per [experimental-status](/docs/reference/experimental-status).

  - `media-buy/build-creative-request.json` — optional `signal_conditions: SignalTargeting[]` (reuses `core/signal-targeting.json` via `allOf`, NOT a new minted signal-ref) plus an optional `signal_agent_segment_id` on each condition — the RESOLVED-segment identity (vs `signal_ref`'s definition identity) the buyer echoes verbatim from `get_signals` / product `signal_targeting_options`; it is the primary trafficking-compatibility key, with categorical `signal_ref`+value the weaker fallback. Also optional `selection_strategy` (new enum).
  - `enums/creative-selection-strategy.json` — NEW closed string enum `[audience_relevance, contextual_fit, performance, proximity, inventory_priority, random]` (folds #5262; mirrors the closed shape of `creative-quality.json`).
  - `protocol/get-adcp-capabilities-response.json` — `creative.multiplicity`: `supports_signal_fanout`, `max_signal_conditions_limit` (clamp like `max_creatives_limit`), `selection_strategies[]`.
  - `media-buy/build-creative-response.json` — `BuildCreativeVariantSuccess.creatives[].signal_condition` + top-level `selection_strategy_applied`; `BuildCreativeEstimate.estimate.conditions_total`.
  - `enums/error-code.json` — `SIGNAL_TARGETING_INCOMPATIBLE` (recovery: correctable) in enum + `enumDescriptions` + `enumMetadata`, with a drift disposition. The normative cross-agent trafficking-compat MUST that warrants the RFC. The compatibility algorithm is spelled out: exact `signal_agent_segment_id` match when both sides carry it; categorical `signal_ref`+value-set comparison otherwise; equal categorical labels from DIFFERENT providers are never compatible absent an explicit equivalence mechanism; mixed segment-handle/categorical only matches when the seller resolves both to the same provider-issued segment.
  - `core/package-signal-targeting.json`, `core/product-signal-targeting-option.json`, `signals/get-signals-response.json`, `docs/media-buy/advanced-topics/targeting.mdx` — clarify that `signal_agent_segment_id` is the opaque, provider-scoped RESOLVED-segment handle buyers echo verbatim (preferred over reconstructing identity from categorical values); providers MAY namespace handles so cross-provider identity stays legible without a shared taxonomy registry.
  - `docs/creative/buyer-attached-inputs.mdx`, `docs/creative/task-reference/build_creative.mdx`, `docs/signals/specification.mdx`, `docs/media-buy/task-reference/create_media_buy.mdx` — request/response field docs, the trafficking-compatibility contract narrative, and the reject-at-trafficking note.

  Consolidates the parallel exploration in #5315 (segment-handle identity, namespaced provider IDs, trafficking-compat rules) into this single RFC-impl PR rather than a second RFC for #5240.

  Closes #5240, #5262. Refs #5219, #5280, #5315.

- 5fc5283: feat(creative): advisory evaluator with gate-then-rank pipeline for build_creative (#5241, #5305)

  Adds an optional, advisory `evaluator` input to `build_creative` (a buyer-attached pointer, #5280) and a per-leaf `eval` block on `BuildCreativeVariantSuccess` variants that explains the `recommended`/`rank` the agent already sets on the `best_of_n` axis. The evaluator is the rank-side of the `get_creative_features` feature oracle and drives a **gate-then-rank pipeline** over the producing agent's best-of-N exploration, per leaf: evaluate (chosen source form) → optional hard **gate** (`feature_requirement[]`, drop fails) → **rank** the survivors (`rank_by`).

  - **Gate (#5305 Q1):** `evaluator.feature_requirement[]` reuses the `feature-requirement` predicate (its schema already names creative gates as an intended reuse) — a leaf that fails is dropped from the agent's recommended survivors. This is internal best-of-N pruning, not an AdCP-layer block of an already-produced billable leaf: what is produced and billed stays governed by `max_variants`/`max_creatives`/`max_spend`, preserving the advisory invariant. The buyer may attach a get_creative_features-capable agent (`evaluator.feature_agent`, or the `agent_url` source form) the producing agent calls to obtain the gate's feature values; that agent is subject to the seller's `creative_policy.accepted_verifiers[]` allowlist — the same buyer-represents → seller-calls mechanism #5280 established for provenance `verify_agent`, no new allowlist. An off-list agent is rejected with a new `EVALUATOR_AGENT_NOT_ACCEPTED` error (mirrors `PROVENANCE_VERIFIER_NOT_ACCEPTED`; added to the enum, enumDescriptions, and enumMetadata).
  - **Rank (#5305 Q2):** `rank_by` is an explicit ordered `[{feature_id, direction: maximize|minimize}]` (not the predicate shape, which has no sort direction) over the gate survivors.
  - **Exemplars (#5305 Q3):** the exemplars form calibrates a single agent-defined `predicted_performance` feature (value in [0,1]) the evaluator computes and returns in `eval.features[]`; `rank_by` orders on it. All three forms thus resolve to "produce a feature value, gate/rank on it."
  - **One contract (#5305 Q4):** the `agent_url`/`feature_agent` evaluator agent uses the same `get_creative_features` contract (returns `creative-feature-result[]`) used for gate, rank, and provenance.
  - **Verdict (Q6):** a pass/warn/fail check is a categorical string feature value gated via `feature_requirement.allowed_values`; the verdict is derived, never stored on `creative-feature-result` (which stays closed: value `oneOf bool|number|string`).
  - **Telemetry (Q7) / type (Q8):** `eval.calls_used`/`seconds_used` live on the open `eval` wrapper; `eval.features[]` is `creative-feature-result[]` (wrapper open, items closed). The `build_creative` Request parameters table gains an `evaluator` row.

  New schema: `core/evaluator-spec.json` (3-form oneOf: exemplars / evaluator_id / agent_url, an optional hard `feature_requirement[]` gate, an explicit `rank_by` ordering, an allowlisted `feature_agent` pointer, plus a soft `eval_budget`). Gated by a new `creative.supports_evaluator` capability flag. Targets 3.1 (the line where `get_creative_features` finalizes). Non-breaking, fully additive / optional.

  **Experimental.** The whole evaluator surface — the `evaluator` input, the `eval` response block, `creative.supports_evaluator`, and `core/evaluator-spec.json` — ships `x-status: experimental` under the feature id `creative.evaluator` (sellers that implement it MUST list it in `experimental_features`). It is a new, not-yet-field-tested gate-then-rank surface, and the `evaluator_id` form's discovery surface (`list_evaluators`) is a committed 3.x follow-on rather than shipping now — so per [experimental-status](/docs/reference/experimental-status) the surface MAY change between 3.x releases with notice, rather than being frozen under full 3.x stability guarantees before cross-party integration. Reserved follow-ons that may reshape these fields: `list_evaluators` discovery, a separate `supports_evaluator_gate` capability, and a hard MUST-enforce-gate semantic.

- af3e682: Add optional `last_updated` (date-time) to `signal-definition.json`, `signal-definition-enrichment.json`, and the `get_signals.fields` projection enum.

  Closes the signal-record freshness gap raised in #5248. `refresh_cadence` and `lookback_window` describe methodology freshness; `last_updated` tells buyer agents when the seller last published or updated this specific definition record — the one verifiable freshness signal that agents can compare across providers without trusting self-declared methodology claims.

  Description follows `signal-listing.json` precedent: "When this definition record was last updated. This indicates freshness of the definition record, not an attestation that the underlying data or model was refreshed at that time."

  Adding to `signal-definition-enrichment.json` means the field is also projectable through `get_signals.fields` for buyers that want it inline during discovery without fetching the full definition.

- f8c389d: spec(media-buy): add optional `publisher_domain` to `get_media_buy_delivery` `by_placement` rows (closes #5299).

  `by_placement` rows carried only `placement_id` and `placement_name`, so a buyer running across multiple publishers through one sales agent could not attribute delivered impressions to a publisher namespace without re-fetching `get_products` and cross-referencing the product's `placements[]` — a round-trip that requires retaining the buy-time catalog and breaks for inline placements.

  Changes:

  - `static/schemas/source/media-buy/get-media-buy-delivery-response.json` — add an optional `publisher_domain` (with the same domain regex as `core/placement.json`) to `by_placement` row items. It is a flat sibling of the existing `placement_id`/`placement_name` (not a nested PlacementRef — the row already ships those fields flat, so nesting would break consumers). Sellers SHOULD emit it whenever the resolving product placement carries a `publisher_domain` (always true for `kind: publisher_ref`); MAY omit only for `seller_inline` placements in a legacy single-publisher context. Single-valued because a placement resolves within exactly one publisher namespace. While in the block, add the missing `x-entity: "placement"` annotation to `placement_id` for parity with `core/placement.json` and `core/placement-ref.json`.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — note the optional `publisher_domain` field under "Available dimensions".

  Strictly additive — no existing field changes shape, no new required fields. `by_placement` rows are already `additionalProperties: true`, and the obligation is SHOULD-when-known (not a retroactive MUST), so pre-existing single- and multi-publisher reports remain spec-valid.

  Package-level publisher attribution on `get_media_buys` (the PackageStatus proposal in #5299's comments) is intentionally out of scope: an ad-network product can span multiple publishers, so a scalar there has an unresolved cardinality question (scalar-absent-when-multi vs. plural). This change covers only the placement grain, where the scalar is sound.

- 68039f7: schema: allow hosted audio/video duration ranges to omit one endpoint.

  Hosted `duration_ms_range` now supports one-sided ranges such as `[null, 60000]`
  for "up to 60 seconds" and `[15000, null]` for "at least 15 seconds", while
  rejecting `[null, null]`. This keeps duration constraints to two mechanisms:
  `duration_ms_exact` for fixed durations and `duration_ms_range` for bounded or
  one-sided ranges.

- 085fa58: Clarify async discovery webhook registration for `get_products` and `get_signals`.

  Adds optional `push_notification_config` to the `get_products` and `get_signals` request schemas for curated/semantic discovery modes, adds the `get_signals` working/submitted async envelopes to the webhook result union, allows failed discovery completions to omit success payload arrays, documents that `submitted` tasks remain pollable via `get_task_status` (legacy `tasks/get`) even when webhook notifications are configured, requires accepted webhook configs to receive at least terminal completion/failure notifications, and preserves the synchronous wholesale feed rule (`get_products` `buying_mode: "wholesale"` and `get_signals` `discovery_mode: "wholesale"` MUST NOT use the Submitted arm).

- 630599e: Clarify that `inline_creative_management` covers inline package creatives on
  `create_media_buy` and `update_media_buy` independently of Creative Protocol
  support, and add compliance coverage for sellers that accept inline creatives
  without `sync_creatives`.
- 3281278: Document the live community-mirror lifecycle endpoints in the registry OpenAPI
  spec so SDKs can generate typed request and response models instead of
  hand-rolling DTOs.
- 69cb5ca: schema(brand): raise brand.json `agents[]` maxItems 20 → 200 for multi-tenant operators, and reconcile the JWKS size budget

  The per-tenant JWKS pattern blessed in #5458 is one `agents[]` entry per tenant, but the `maxItems: 20` cap made a >20-tenant `brand.json` schema-invalid — below the scale the multi-tenant case is actually about. Raises the cap to 200 (additive and non-breaking — loosening a `maxItems` never invalidates an existing valid document).

  Also reconciles the two JWKS size figures in L1 security so a conservative verifier can't reject a conformant shard: the 64 KiB `MAX_JWKS_BYTES` is the JWKS-specific budget (deliberately tighter than the generic 5 MB SSRF body ceiling), and per-tenant `jwks_uri` sharding is the conformant path above it — for size as well as key isolation. Closes #5445.

- cb3b658: Define adagents.json discovery redirect policy and reconcile the reference implementation with it.

  The initial `/.well-known/adagents.json` fetch now follows **same-registrable-domain** redirects (apex↔www, HTTPS-preserving, ≤3 hops, SSRF re-validated per hop, anchored on the originally-requested domain) so that standard apex→www managed hosting resolves instead of being silently reported unauthorized. **Cross-registrable-domain** redirects are refused — declare delegation with `authoritative_location` instead — and the `authoritative_location` dereference continues to refuse all redirects. Docs: managed-networks "Why not HTTP redirects?" and L1 security SSRF/TLS-hardening sections; new conformance vectors in `static/test-vectors/adagents-discovery-redirects.json`.

- 85411b1: Add optional `status_as_of` freshness timestamp to `get_media_buys` media-buy objects.

  The field lets sellers identify when a returned media-buy-level `status` was last refreshed from the source of truth, covering cached or rolled-up list reads from curator/storefront aggregators. Sellers omit it or return `null` when status is live or freshness is unknown.

- e815fc8: Add brand-side sponsored_context_accountability storyboard under `compliance/source/protocols/sponsored-intelligence/sponsored-context-accountability.yaml`.

  Refs #5541 (bragent conformance testbed offer) and #5486 (RFC: sponsored context influence modes and disclosure obligations for SI). Exercises the PR #5501 surfaces against a brand-side SI agent in four phases inside a single yaml so the review surface stays small and the contract is visible together:

  - `presentation_only_happy_path` — agent emits a `sponsored_context` envelope with `paying_principal.brand.domain`, `context_use=presentation_only`, `disclosure_obligation`, and `declared_by.role=brand_agent`; host returns an accepted receipt with matching `accepted_context_use`; second brand turn lands cleanly.
  - `required_disclosure_commitment` — literal `sponsored_context` carries `disclosure_obligation.required=true`; host's receipt carries `disclosure_commitment.status=accepted`; agent accepts the well-formed receipt without error.
  - `rejected_receipt` — host returns `host_receipt.status=rejected` with a `rejection_reason`; agent accepts the rejection as a valid wire response (the audit trail records the decline).
  - `silent_downgrade_rejected` — host returns an accepted receipt whose `accepted_context_use` does not match the declared `context_use`; the agent MUST reject. Regression anchor is `error_code ∈ {VALIDATION_ERROR, INVALID_REQUEST}` (the canonical AdCP enum); the recommended "silent downgrade forbidden" message wording stays in the step's `expected:` text as a manual-review pointer, not a hard check (promoting it would require a new `error_message_contains` matcher in the runner).

  Uses only the existing storyboard matchers (`response_schema`, `field_present`, `field_value`, `error_code`). LLM-generated `response.message` is asserted as present/non-empty only, so language and provider are implementation choices.

  bragent (kapoost/bragent, v0.2.0+) serves as the empirical reference surface from which the assertions were derived; the storyboard itself is decoupled from any live service.

- 63e58c3: spec(conformance): AAO Verified — one brand mark, two qualifiers (Spec) and (Live)

  Adds **AAO Verified** as the public trust mark for AdCP agents, with two composable qualifiers in parens — **(Spec)** and **(Live)** — that an agent can hold either or both:

  - **AAO Verified (Spec)** — your AdCP wire format matches the spec. Storyboards run against your test-mode endpoint on AAO's compliance heartbeat. Issued automatically when storyboards pass for the agent's declared specialisms + active AAO membership.
  - **AAO Verified (Live)** — AAO has observed real production traffic flowing through your agent. The compliance engine continuously watches delivery against your live ad-server integration over a 7–14 day rolling window. Lights up in 3.1 once the canonical-campaign runner is operational; the eight-check observability machinery already ships.

  **(Spec) and (Live) are independent.** Each axis demonstrates conformance through different evidence — (Spec) via simulated interactions against a test endpoint, (Live) via observed real traffic that exercises wire format, filters, lifecycle, and scope through the eight checks. Sellers without a test-mode endpoint (SDK-built agents, production-only platforms) can earn (Live) directly. The two qualifiers share one brand mark — buyers learn one name, the qualifier in parens names which axis was earned.

  Earlier drafts used "AdCP Conformant" + "AAO Verified" as two distinct mark names (and earlier still, "Tier 1 / Tier 2"). The single-brand-with-qualifiers framing is cleaner: a test agent earning **Verified (Spec)** is a complete claim, not a "junior" tier.

  Seller obligation for (Live): designate a compliance account with real live campaigns (PSA / remnant / house / genuine revenue all qualify) and grant the `attestation_verifier` scope (#2964) to the AAO compliance engine. Eight observable checks run over the rolling window. Path B (brownfield) has two first-class forms — B1 polling-only, B2 webhook-attached. Mark lifecycle: continuous observation, auto-expiring on signal degradation, no one-shot pass.

  Closes #2965. Depends on #2964 (`attestation_verifier` scope + RBAC error codes) and the merged #2963 account-ownership tightening. Multi-subscriber webhooks (which relax the dedicated-tenant requirement on Path B2) tracked for 4.0 in #3009.

- 63e58c3: spec(accounts): caller-scope introspection via per-account `authorization` on sync/list + RBAC error codes

  Caller-scope authorization model for AdCP. Vendor agents (media-buy, signals, governance, creative, brand) attach an optional `authorization` object to each per-account entry in `sync_accounts` and `list_accounts` responses — describing `allowed_tasks`, per-task `field_scopes`, an optional standard `scope_name`, and an optional `read_only` flag. Absence means the vendor agent does not advertise introspectable scope; callers MUST NOT infer access from absence. Conceptually analogous to RFC 7662 OAuth 2.0 Token Introspection, specialized for AdCP's task-and-field authorization model and folded into existing account discovery rather than split into a new task.

  Standard named scope `attestation_verifier` is spec-mandated (binds to the AAO Verified (Live) qualifier; Media Buy Protocol). Other scope names are vendor-specific and MUST use the `custom:` prefix so a typo of the standard value fails schema validation. Three new error codes surface RBAC decisions that previously had no standard code: `SCOPE_INSUFFICIENT`, `READ_ONLY_SCOPE`, `FIELD_NOT_PERMITTED`. `FIELD_NOT_PERMITTED` MUST populate `error.field`; `SCOPE_INSUFFICIENT` SHOULD carry an `introspection_hint` pointing at where to re-read scope. All four authz codes classify as `correctable` but are NOT agent-autonomous (scope broadening requires operator intervention) — agents SHOULD surface rather than auto-retry.

  Identity binding, refresh cadence, and consistency are normative: the authorization object is scoped to `(caller identity, account_id)` at read time; vendor agents MUST resolve identity from the authenticated request (not client-supplied fields) and reflect operator-initiated scope changes within 300 seconds. Sequential reads within the refresh window MUST return identical authorization objects (modulo operator-initiated changes) — flicker from load-balanced or eventually-consistent backends is non-conformant.

  Closes #2964.

- 1e76c74: spec(brand): `account` on AcquireRights/UpdateRights + governance-bound CPM projection rule

  Coupled spec gaps surfaced while validating a multi-tenant + multi-specialism hello adapter (per #3918):

  1. **`acquire_rights` and `update_rights` accept `account: AccountReference`.** Governance-aware brand agents need brand+operator (or `account_id`) to look up any governance agent previously bound via `sync_governance`. The brand-rights compliance storyboard already sends `account: { brand, operator }` on the wire for `acquire_rights`, but the schema didn't define the field — adapters were falling back to `req.buyer.domain` (the brand, not the operator) for account resolution. `update_rights` had the same shape gap and is also a modification-phase governance trigger per the campaign-governance spec. Both fields are optional, follow the same shape `create_media_buy` uses.

  2. **CPM-projection MUST broadened to cover the bound path on `acquire_rights`.** `acquire-rights-request.json` previously required `campaign.estimated_impressions` only when the request carried an intent-phase `governance_context` token AND the pricing option was CPM. Brand agents that resolve their governance binding via `sync_governance` (no inline token) still project CPM commitment — and "implementer-chosen defaults are non-conformant" applies equally there. The MUST now covers both paths: the request is governance-aware whenever an inline `governance_context` is present OR `account` resolves to an account with a bound governance agent. Non-CPM pricing options remain unaffected. The equivalent commit-delta projection rule for `update_rights` is left for a follow-up — it requires designing the delta semantics (impression_cap delta vs. pricing_option-switch delta) and is not yet normative.

  3. **Inline-token-wins precedence.** When both an inline `governance_context` token and a bound governance agent are present on the same request, the inline token wins. The token is per-request, JWS-bound to a specific plan, and is the primary correlation key; the bound agent is the resolver fallback. Stated in the `account` field descriptions and in the `acquire_rights` task reference.

  4. **`sync_governance` doc-comment clarifies account-scoped binding.** Adopters were reading the existing description as ambiguous on whether the binding could vary per plan inside the same account. The wire offers no field for per-plan governance agents (and `maxItems: 1` plus the singular `governance_context` envelope foreclose it). Description now states explicitly: binding is account-scoped, not plan-scoped; a single bound agent owns the lifecycle for every plan on the account; `plan_id` is threaded through `check_governance` for per-plan routing inside the bound agent, not at the registration layer.

  Also fixes a stale anchor in the `acquire_rights` validation prose (`#buyer-side-governance-invocation` → `#spend-commit-invocation`).

  Closes the wire-schema items on #3918 (`account` on acquire_rights/update_rights, broadened MUST, `plan_id` ambiguity). The two items deliberately not included: `plan_id` as a sync_governance field (conflicts with the documented account-wide binding), and loosened HTTPS pattern (better solved in the storyboard runner than by relaxing the wire spec).

- 6d9646e: Activate public AAO Verified badge issuance for AdCP 3.1 while keeping AdCP 3.0 compatibility badges active.

  The badge-eligible default compliance target is now the 3.1 line, with explicit non-default targets such as `3.0`, exact 3.1 beta targets, or future exact 3.1 RC targets remaining diagnostic-only for public compliance state. Registry and Addie outputs now surface whether a compliance run can update public badges and which badge versions it can issue.

  Closes #5108.

- cf0857e: adagents.json: allow catalog-only community mirrors (empty `authorized_agents`).

  The inline `adagents.json` variant required `authorized_agents` with `minItems: 1`, which made the community-mirror use case the spec itself describes — catalog-only files (e.g. at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`) for platforms that haven't adopted AdCP — impossible to express, since such a mirror has no sales agent to authorize. It is also the exact `authorized_agents: []` shape the SDK's `buildCommunityMirrorAdagents()` emits, which `POST /api/adagents/create` rejected with a 400.

  - **Schema:** `authorized_agents` may now be empty (`[]`); `minItems: 1` is dropped. A new content guard requires a file to carry either sales authorization or a non-empty catalog array (`formats`/`properties`/`placements`/`collections`/`signals`), so a file with neither is still invalid. `catalog_etag` remains recommended-not-required at the schema layer (the mirror contract is enforced by the producer/SDK, consistent with "SDK is canon for wire contracts"); the schema only widens what was previously rejected, so every file valid today stays valid.
  - **Registry:** `POST /api/adagents/create` and the proposed-file validator accept an empty `authorized_agents` when catalog content is present.
  - **Consumer semantics:** an empty `authorized_agents` asserts _no sales authorization_ — validators MUST NOT read it as deny-all, authorize-all, or a revocation, MUST NOT treat it as an error, and MUST still consume the catalog arrays.
  - The Meta community-mirror example now uses `authorized_agents: []` instead of a fabricated advisory agent.

- 556edf3: Extend `check:platform-agnostic` lint to cover enum and const values; fix `brand.json` platform-agnosticism violation.

  **Lint extension (`tests/check-platform-agnostic.cjs`):** adds enum/const-value scanning alongside the existing property-name check. Uses a path-qualified `ENUM_VALUE_ALLOWLIST` so the same vendor token can be legitimate in one enum (e.g., `roku` in `enums/genre-taxonomy.json`) but a violation in another. Pre-compiles vendor-token regexes. Skips `examples` arrays (user-data samples, not normative definitions). Title/description text intentionally excluded — vendor names in prose are permitted per spec-guidelines.

  **Schema fix (`static/schemas/source/brand.json`):** removes the single-value enum `["openai_agentic_checkout_v1"]` from `product_catalog.agentic_checkout.spec` and replaces it with a free-form `string`. The enum encoded a specific vendor's checkout API version as a normative discriminator, violating the platform-agnosticism rule in `docs/spec-guidelines.md`. Non-breaking: existing data using `"openai_agentic_checkout_v1"` remains valid.

  **Note:** `openai_product_feed` in `brand.json`'s `feed_format` enum is contested (see #2439): one expert treats it as a violation; another treats it as a canonical feed-schema identifier parallel to `google_merchant_center`. It is allowlisted pending @bokelley's decision.

  Closes #2439.

- 806b7cf: feat(registry): add optional `tracks_silent` to `ComplianceRun` schema

  Adds an optional `tracks_silent: integer` field to `ComplianceRun` in
  `openapi/registry.yaml`, alongside the existing `tracks_passed`,
  `tracks_failed`, `tracks_skipped`, and `tracks_partial` fields.

  `tracks_silent` counts tracks where every observation-based invariant ran
  but received no lifecycle resource events during the run — configured but
  not exercised. Counting these separately from `tracks_passed` lets
  dashboards avoid over-crediting silent tracks as real protection.

  The field is **optional** (not in `required:`) for back-compat with runs
  persisted before SDK 6.4.0 (`adcp-client#1163`), which widened
  `TrackStatus` with `'silent'` and started emitting `tracks_silent` in
  `ComplianceSummary`. Without this schema addition, downstream services
  deserialize pre-existing runs with `tracks_silent: undefined` and cannot
  render silent rows distinctly.

  Non-breaking: adds an optional field; existing consumers unaffected.

  Closes #3752.

- 2a2e5c4: spec(errors): register `AGENT_SUSPENDED` / `AGENT_BLOCKED` codes + consolidate the 3.0.5 `details.status` placeholder.

  Two new error codes for the per-buyer-agent commercial-status axis (sibling to `ACCOUNT_SUSPENDED` / `CAMPAIGN_SUSPENDED`, scoped to the agent-relationship), both `recovery: terminal`. The code itself is the discriminator — no `error.details.scope` field, no `error.details` payload — mirroring `BILLING_NOT_PERMITTED_FOR_AGENT`'s discriminator-by-code precedent.

  3.0.5 shipped `error-details/agent-permission-denied.json` with a `details.status: ["suspended", "blocked"]` axis as a placeholder while the dedicated codes were being designed. 3.1 consolidates the placeholder: the `status` field is removed from the schema; sellers MUST emit `AGENT_SUSPENDED` / `AGENT_BLOCKED` directly. The schema's `agent-permission-denied.json` now carries only `scope: "agent"` + `reason: "sandbox_only"` for non-status per-agent provisioning gates. `oneOf` exclusivity drops out (single payload axis), `reason` becomes required.

  Migration: sellers that integrated against the 3.0.5 placeholder shape MUST switch to the dedicated codes. The known adopter (JS SDK BuyerAgentRegistry, [adcp-client#1269](https://github.com/adcontextprotocol/adcp-client/issues/1269)) is in Phase 1 placeholder mode, not production — the consolidation is intentional and is the reason 3.1 is the right release for it. The DX-expert "wire-level recovery field ambiguity" gap from #3887 review closes for the suspended/blocked paths — those paths now carry `recovery: terminal` directly at the wire level.

  Same cross-tenant onboarding oracle clamp + channel-coverage rules established in #3887 apply uniformly to the new codes.

  Closes #3871. Builds on #3887.

  Files:

  - `static/schemas/source/enums/error-code.json` — `AGENT_SUSPENDED` / `AGENT_BLOCKED` enum + descriptions + `enumMetadata.recovery: "terminal"`. `PERMISSION_DENIED` description points at the new codes for suspended/blocked.
  - `static/schemas/source/error-details/agent-permission-denied.json` — `status` field removed, `oneOf` removed, `reason` required.
  - `docs/building/implementation/error-handling.mdx` — Authorization (RBAC) table adds `AGENT_SUSPENDED` / `AGENT_BLOCKED` rows. Per-Agent Authorization Gate subsection rewritten to cover all three paths (`AGENT_SUSPENDED`, `AGENT_BLOCKED`, `PERMISSION_DENIED + scope:"agent" + reason:"sandbox_only"`) under a single uniform clamp + composition-pattern guidance + 3.0.5 → 3.1 migration note.

- d597efe: spec(compliance): pin endpoint_pattern wildcard grammar + downgrade non-JSON match modes to not_applicable (closes #3845)

  Two implementation-surfaced ambiguities from runner-side adoption of #3816 (the anti-façade + cascade-attribution contract). Both are minor-but-load-bearing pins that affect cross-runner determinism on the same storyboard.

  **1. `endpoint_pattern` wildcard grammar.** `comply-test-controller-request.json` previously described `endpoint_pattern` as a "glob-style pattern" with no normative grammar. The `@adcp/sdk` runner picks the most permissive interpretation (`*` matches `/`-crossing, all other regex metacharacters escaped literally). A different runner could legitimately read "glob-style" and ship POSIX glob semantics where `*` doesn't cross `/` and `?` is single-char-any — same storyboard, different verdict. Pinned: `*` matches zero or more characters of any kind including `/`. No other characters have wildcard semantics — `?` is a literal question mark, `[`/`]` are literal brackets. Implementations MUST anchor the pattern (full-string match). Renamed "glob-style" → "wildcard" in the description so the grammar's intentional narrowness is obvious from the noun.

  **2. Non-JSON `payload_must_contain` match modes downgrade to `not_applicable`.** The earlier comment in `storyboard-schema.yaml` said the runner "falls back to substring matching for `match: present`" against non-JSON payloads (form-urlencoded, multipart, plain text). The `@adcp/sdk` runner implemented this as a terminal-key heuristic (extract `hashed_email` from `users[*].hashed_email`, substring-search the raw payload string). That creates false positives: a payload mentioning `hashed_email` anywhere — URL fragment, comment, unrelated metadata field — would pass the assertion. For an anti-façade contract specifically, false positives are exactly what lets façades pass.

  Per the option-(b) decision in #3845: ALL `payload_must_contain` match modes (`present` / `equals` / `contains_any`) now grade `not_applicable` against non-JSON `content_type`. Storyboards that need a "the upstream call carried this value" signal against non-JSON payloads use `identifier_paths` instead — that surface substring-searches storyboard-supplied VALUES (not path-derived strings), which is encoding-agnostic and doesn't suffer the false-positive surface.

  **Why both belong in spec, not runner docs.** #3816 explicitly framed itself as the load-bearing anti-façade contract that distinguishes a real adapter from a façade. Two compliant runners grading the same storyboard differently against the same agent (because of unspecified wildcard / substring semantics) means adopters can game whichever runner is more permissive. Pinning these is small but the divergence cost is high.

  **Cross-link:** SDK PR `adcontextprotocol/adcp-client#1289` is the runner-side adoption that surfaced both ambiguities; runner needs a follow-up alignment to drop the terminal-key fallback now that the spec downgrades non-JSON matches to `not_applicable`.

- 5a0a792: Add compliance storyboards for async `get_products` and `get_signals` discovery. The new optional cases force submitted discovery envelopes, verify task visibility through `list_tasks`, force deterministic completion, poll `get_task_status` with terminal results, and assert terminal webhook delivery. Also adds `get_products` to the task-type enum, documents the new controller directives `force_get_products_arm` and `force_get_signals_arm`, and aligns account scoping across legacy and alias task polling schemas.
- d80ee8e: Add `audio_distribution_types` discovery metadata to products, placements, and
  `get_products.filters`, using IAB Tech Lab/OpenRTB 2.6 `audio.feed` definitions
  with AdCP-native field names.
- da8b053: spec(errors): split `AUTH_REQUIRED` into `AUTH_MISSING` (correctable) + `AUTH_INVALID` (terminal)

  `AUTH_REQUIRED` conflated two operationally distinct cases: missing credentials (genuinely correctable — agent provides creds and retries) and rejected credentials (terminal — expired/revoked tokens require human rotation, not auto-retry). A buyer agent honoring `correctable` on revoked keys will retry-loop, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

  **New codes:**

  - `AUTH_MISSING` — `Recovery: correctable`. No credentials were presented; agent re-handshakes and retries.
  - `AUTH_INVALID` — `Recovery: terminal`. Credentials were presented and rejected (expired / revoked / malformed signature). Requires human-driven credential rotation; auto-retry is counterproductive.

  **Backward compat:** `AUTH_REQUIRED` is retained in the enum as a deprecated alias (recovery: correctable) during the 3.x deprecation window. Sellers MUST migrate to the split codes; agents MUST handle all three. The `error-code-aliases.json` linter registry now maps `AUTH_REQUIRED → AUTH_MISSING` so storyboard references emit warnings.

  **Related:** adcp-client#1135 (TS SDK error-code drift fix that surfaced this spec gap), adcp-client#1147 (typed-error recovery alignment).

  Closes #3730.

- a1067d0: Add optional `scopes`, `valid_from`, and `valid_until` fields to `brand.json` `authorized_operators[]` so houses can time-box and activity-scope agency-of-record or delegated-operator relationships. Existing entries remain valid when these fields are omitted.
- 21fd8f3: spec(accounts): billing-gate conformance storyboard + BrandAuthorizationResolver naming guidance

  Tier-3 follow-up to #3828 / #3831 (BuyerAgentRegistry spec backing). **Validated end-to-end against the training-agent reference implementation in #3851** — running the storyboard against a real agent surfaced three bugs that lint couldn't catch, all corrected before this PR went ready:

  1. `check: error_code` doesn't accept a `path` parameter for per-account error extraction → switched to `check: field_value` with explicit path on both gate phases.
  2. `expect_error: true` requires transport-level error markers (MCP `isError` / A2A `failed`) — sync_accounts produces transport-level success with per-account errors in the success envelope, not transport-layer failures → removed the flag from both gate phases with explanatory comment.
  3. Idempotency-key reuse across reject/recover phases produced `IDEMPOTENCY_CONFLICT` (same key + different payload per error-handling.mdx) → recover phase now uses a fresh idempotency_key with a distinct stability tag, and both the narrative and recover-phase docs corrected to reflect that the recover phase is a new request rather than a replay.

  Plus one runner-side gap documented in the test kit: today's storyboard runner does not auto-extract `auth.api_key` from the test kit; callers pass it explicitly via `--auth`. The kit's `auth.api_key` declares the bearer the seller's harness expects to be authenticated under; the CLI carries it onto the wire.

  Storyboard now passes 3/3 strict assertions against the training-agent's per-agent-gate flow (capability_discovery + per_agent_gate_reject + per_agent_gate_recover); capability_gate phase grades `not_applicable` when the seller advertises all three billing values, which is the correct outcome against the training-agent.

  **Conformance.** New universal storyboard `billing-gate-dispatch` under `static/compliance/source/universal/` exercises the two-gate dispatch contract on `sync_accounts.billing` rejection:

  - Capability gate (`BILLING_NOT_SUPPORTED` with `error.details.scope: "capability"` and `error.details.supported_billing` echo). Skipped when the seller supports all three `billing` values.
  - Per-buyer-agent gate (`BILLING_NOT_PERMITTED_FOR_AGENT` with the clamped `error.details.rejected_billing` + optional `error.details.suggested_billing`). Skipped when the test kit does not declare `commercial_relationship: "passthrough_only"`. Recovery phase chains off the rejection and validates that retrying with the seller's `suggested_billing` produces a successful provisioning.

  The storyboard also asserts the negative-shape security clamp on the per-agent gate: `error.details` MUST NOT carry `permitted_billing` (full subset), `rate_card`, `payment_terms`, `credit_limit`, or `billing_entity` — these are the per-agent commercial-state oracles that `error-details/billing-not-permitted-for-agent.json` (`additionalProperties: false`) closes off.

  Conformance catalogs (`docs/building/conformance.mdx` and `docs/building/compliance-catalog.mdx`) updated; doc-parity lint clean.

  The storyboard documents two follow-ups it does not yet land:

  1. `comply_test_controller` `seed_buyer_agent` extension to toggle the test caller's `commercial_relationship` programmatically — would let any seller exercise both per-agent branches without a manually-curated test kit.
  2. Test-kit field schema for `commercial_relationship` (currently referenced in `skip_if` expressions; needs a normative test-kit schema entry).

  **SDK naming.** Adds normative guidance to `accounts-and-agents.mdx` Buyer-agent identity section: SDKs surfacing a typed Protocol for the brand-operator authorization check MUST name it after the file consulted — `BrandAuthorizationResolver` (or idiomatic equivalent), NOT `AdagentsResolver`. `adagents.json` is publisher-side and models a different relationship; naming the buyer-side resolver after it confuses surfaces and locks adopters into the wrong mental model. Cross-coordination filed as adcp-client-python#346 ahead of either SDK shipping the Protocol.

- 5134f45: Define the designated-task response payload JWS envelope for Brand Protocol verification responses.

  `verify_brand_claim` and `verify_brand_claims` success schemas now require `signed_response`, binding the signed task body to the designated task, resolved brand tenant, responding agent URL, request hash, and `iat`/`exp` freshness window. The security and brand-agent docs specify ordinary JWS signing input over JCS-canonicalized payloads, response-signing JWK verification requirements, per-brand response-signing key separation, and bulk audit retention requirements.

- 45089c6: Integrate Brandfetch Brand Context API as authenticated ephemeral enrichment context.
- 0627c47: Add `idcrea` as a supported creative identifier type for French ARPP.PUB workflows.

  This also clarifies that `ad_id` is common for US television and accepted by some radio/audio workflows, rather than requiring all broadcast or audio workflows to use Ad-ID.

- a4a51bc: Add operation-scoped `push_notification_config` to `build_creative` requests and include `build_creative` in task-type enum values so async build webhooks and task polling can name the task.
- fa64db9: Add optional `recipe_hash` fields to `build_creative` success responses so creative agents can expose an opaque, agent-scoped identity for build-determining inputs without standardizing a cross-agent hash algorithm.
- af1d287: spec(creative): add build_creative spend controls — `max_spend` cap + `mode: "estimate"` dry-run.

  Follow-on from the persona/scenario review: fan-out (`max_creatives` × `max_variants`) and refinement produce many independently-billed leaves, and `per_unit` pricing gives a rate but not the unit count in advance — so an autonomous buyer had no protocol brake on spend. Both additions are optional and gated by a new `creative.supports_spend_controls` capability.

  - **`mode: "estimate"`** (request) → new `BuildCreativeEstimate` response shape (6th `oneOf` member): a dry run that produces and bills nothing and returns a `cost_low`/`cost_high` band computed against the request's actual inputs, with `basis` (`fixed` exact / `estimated_units` / `cpm_deferred`) and an optional per-leaf breakdown. Advisory/non-binding in this revision.
  - **`max_spend: { amount, currency }`** (request) → a hard per-call ceiling: the agent stops before the next leaf would exceed it and returns the partial `BuildCreativeVariantSuccess` with new `budget_status: "capped"` and an advisory `BUDGET_CAP_REACHED` in `errors[]` (every returned leaf real and billed; `items_returned` < `items_total`). First-leaf-over-cap → terminal `BUDGET_CAP_REACHED`; currency mismatch → `INVALID_REQUEST`.
  - New error code **`BUDGET_CAP_REACHED`** (distinct from `BUDGET_EXCEEDED`/`BUDGET_EXHAUSTED`), in both `enumDescriptions` and `enumMetadata`.
  - New capability **`creative.supports_spend_controls`** (default false).

  Deferred to the working group (flagged, not omitted): whether an estimate can be **binding**, and whether a refinement-**loop** bound is a protocol-level session budget vs. a buyer responsibility (documented as buyer-side for now).

- d024eb8: spec(accounts): buyer-agent identity model + billing error-code coverage for sync_accounts

  Adds the spec/doc backing that adcp-client #1269 (BuyerAgentRegistry) needs to land without inventing wire behavior.

  **Error codes (additive, non-breaking).** Registers four codes referenced by `sync_accounts` but missing from the canonical enum, plus one new code for the per-buyer-agent commercial gate:

  - `BILLING_NOT_SUPPORTED` — seller-wide capability gate (`supported_billing` does not include the value), or per-account-relationship gate. Carries `error.details.scope` ∈ `{"capability", "account"}` so callers can dispatch without parsing prose. Default reject for billing-value mismatches.
  - `BILLING_NOT_PERMITTED_FOR_AGENT` — _new_. Seller-wide capability accepts the value, but the calling buyer agent's commercial relationship does not (e.g., onboarded as passthrough-only — no payments relationship — so `agent` and `advertiser` reject). Distinct from `BILLING_NOT_SUPPORTED` so agents can dispatch on autonomous-retry vs surface-to-human. `error.details` MUST conform to the new `error-details/billing-not-permitted-for-agent.json` schema: `rejected_billing` plus an optional single `suggested_billing`. The shape is deliberately clamped — it MUST NOT carry the agent's full permitted-billing subset, rate cards, payment terms, credit limit, billing entity, or any other per-agent commercial state (those are commercial-state oracles; full-subset disclosure in a single probe is exactly what the clamp prevents).
  - `PAYMENT_TERMS_NOT_SUPPORTED` — seller declines the requested `payment_terms` value.
  - `BRAND_REQUIRED` — billable operation attempted without a brand reference.

  All four registered in `enum`, `enumDescriptions`, and `enumMetadata` per the dual-surface requirement (#3738).

  **Uniform-response rule for unauthenticated callers.** Sellers MUST NOT emit `BILLING_NOT_PERMITTED_FOR_AGENT` to unauthenticated, unverified, or weakly-authenticated callers — emitting the per-agent code without an established agent identity is a cross-tenant onboarding oracle (same shape as `*_NOT_FOUND`). Unauthenticated callers receive `BILLING_NOT_SUPPORTED` (the broader code) regardless of which gate would have fired with identity established. Documented in `error-handling.mdx` Billing and Account Setup section.

  **`sync_accounts` task doc** adds the normative line that sellers MAY reject `billing` at the per-buyer-agent commercial gate distinct from the seller-wide capability gate; error rows cross-link to the new error-handling and accounts-and-agents sections. Also fixes a pre-existing doc bug: the error table referenced `PAYMENT_REQUIRED` (never registered in the enum) where the registered code is `ACCOUNT_PAYMENT_REQUIRED` — corrected to use the registered identifier.

  **Buyer-agent identity narrative.** New "Buyer-agent identity" section in `accounts-and-agents.mdx` framing the two-layer model the spec already implies but doesn't name: agent identity (signed-request `agent_url` derivation OR seller's credential-to-agent mapping) and brand-operator authorization (`brand.json/authorized_operators`). Both layers MUST pass; the checks compose. The brand-operator check runs against cached `brand.json` per existing revocation/cache semantics (eventual revocation, 24h TTL), and high-value or first-time-on-brand provisioning SHOULD bypass the cache to close the TOCTOU window. Per-buyer-agent commercial state — onboarding records, payment-relationship status, default account terms — is offline (out of scope) but surfaces on the wire through (a) the new `BILLING_NOT_PERMITTED_FOR_AGENT` runtime gate and (b) defaults sellers MAY apply during `sync_accounts` upsert (per-account values on the request always take precedence). Defines "passthrough-only" inline on first use.

  **`agent_url` derivation.** `security.mdx` "Agent identity" section now names the derivation explicitly: `agent_url` is the `url` field of the `agents[]` entry whose `jwks_uri` resolved the `keyid` at step 7 of the verifier checklist — not a JWK claim, JWS claim, or signed envelope field. The publication coordinate the verifier already used to fetch the JWKS _is_ the canonical identity. Closes a loophole where an SDK could surface a buyer-asserted `agent_url` from the envelope and treat it as cryptographically established. The bearer / API-key / OAuth transport is also clarified: agent identity MUST come from the seller's credential-to-agent mapping; sellers MUST NOT introduce an envelope-side `buyer_agent_url` as an alternate input. Existing buyer-asserted _verifier_ references (`creative.verify_agent.agent_url`, `governance.accepted_verifiers[].agent_url`) are explicitly outside this prohibition — they name agents the seller invokes under a published allowlist, not the signer.

  **Two new `error-details/` schemas** lock the recovery shapes so SDKs and conformance fixtures don't diverge: `billing-not-permitted-for-agent.json` (`additionalProperties: false`, `rejected_billing` + optional `suggested_billing`) and `billing-not-supported.json` (`scope` + optional `supported_billing` echo). The per-agent schema's clamp prevents full-subset commercial-state disclosure; the per-supported schema's `scope` field MUST be omitted on the unauthenticated path so it cannot itself become a per-account-relationship oracle.

  **Tier 3 (conformance fixtures + cross-language naming alignment with Python `BrandAuthorizationResolver`)** tracked as #3828.

- 8dc46bc: Add `FORMAT_NOT_SUPPORTED` to the canonical error-code enum for creative-agent canonical build routing.

  The 3.1 `creative.supported_formats` storyboard and `build_creative` docs already require creative agents to fail closed with this code when `target_format_id.id` is not an advertised canonical capability or supported legacy named format. Publishing the enum entry, including the `supported_capability_ids` details hint, keeps schema validation, docs, and conformance aligned.

- da42f43: test(compliance): add canonical format satisfaction create-time coverage.

  Defines the direct `PackageRequest.format_kind`/`params` canonical selector used by the negative under-specification case and publishes the runner-output contract for `canonical_format_satisfaction`.

  Read surfaces now echo supplied format selectors losslessly, and update payloads treat all format selector fields as immutable.

- ee1a0b3: **Canonical formats 3.1 follow-ups — fixture, vocab, Pinterest disambiguation.**

  Closes three of the GA-blocking follow-ups identified in PR #3307 expert review, plus a latent slot-enum bug surfaced by the new fixture:

  - **Latent slot `asset_type` enum gap fixed** in `_base.json`. The canonical-formats slot enum was missing `pixel_tracker`, `vast_tracker`, and `daast_tracker` — meaning any product carrying explicit tracker slots (including the `native_in_feed` default slots) failed validation. Added all three to the enum and to the size-mutex if/then "no size semantics" branch. Discovered by the new native_in_feed fixture; would have hit any 3.1 adopter shipping explicit tracker slots.

  - **`native_in_feed` reference Product fixture** at `static/examples/products/canonical/taboola_content_recommendation.json`. Realistic Taboola US Content Recommendation product covering all 12 native_in_feed default slots — title, body_text, main_image (1200×627 / 1080×1080), cta with closed enum, advertiser_name, sponsored_label, landing_page_url, display_url, rating, plus impression / viewability / click `pixel_tracker`. CPC pricing, hourly+daily reporting, v1_format_ref points at `native_content`. Brings the canonical fixture suite to 13 (one per canonical, plus generative Veo on video_hosted).

  - **Pinterest disambiguation worked example** in `docs/creative/canonical-formats.mdx`. Spells out which Pinterest product routes to which canonical: Promoted Pin → `native_in_feed`, Pinterest Collection → `sponsored_placement` (catalog-keyed), Idea Pin → `image_carousel`, Shopping Pin → `sponsored_placement` (fanout_mode: single_item). The cleave is asset-bundle vs catalog-row composition; same logic applies to Snap Story / Snap Collection, TikTok TopView / TikTok Collection, etc. Closes the routing ambiguity flagged by Pia + Nastassia at GA review.

  - **10 new IAB OpenRTB Native 1.2 vocab entries** in `asset-group-vocabulary.json`.
    - Five Data Asset additions: `likes` (type 4), `downloads` (type 5), `saleprice` (type 7), `address` (type 9), `secondary_body_text` aliased to `desc2` (type 10).
    - Five core-native vocab additions surfaced by product-expert review — the `native_in_feed` canonical's default slots referenced these but the vocab didn't have entries, leaving the flagship fixture authoring against non-canonical IDs: `title` (Title Asset type 1; `headline` is the alias for the singular case, distinct from `headlines` pool used by responsive_creative), `main_image` (Image Asset type 3 main, with `image_main`/`hero_image` aliases), `icon` (Image Asset type 1), `advertiser_name` (the IAB `sponsoredBy` field), `sponsored_label` (renderer disclosure string).
    - `phone_number` description annotated with IAB type 8; `body_text` annotated with IAB type 2. `price` description updated to call out the price ↔ saleprice discount-rendering convention.

  **Migration doc** updated: 14 reference Product fixtures, dropped the "native_in_feed fixture follows in a subsequent PR" placeholder.

  Remaining 3.1 follow-ups tracked separately:

  - **SDK codegen (TypeScript + Python)** — multi-week build, the gating dependency for adopter consumption. Schemas shippable today; typed-tagged-union ergonomics arrive with codegen.
  - **`native_in_feed` conformance storyboard** — multi-phase YAML to extend `static/compliance/source/protocols/creative/index.yaml` with native sync_creatives + preview coverage.

- 9c087a2: canonical-formats: five adopter-flagged additions before lock. Each surfaces guidance that was implicit in the spec but not findable; one resolves a normative silence.

  **1. "What `format_kind` is NOT for" decision rule** (canonical-formats.mdx). Adopters seeing the broadcast / DOOH / generative annotations were tempted to propose `format_kind: dooh_image` or `format_kind: broadcast_video` in 3.2. New section enumerates the six axes (creative type / production model / slot shape / channel / measurement / targeting) and the rule of thumb: new `format_kind` ONLY when the creative ASSET is structurally different. All 50 ad formats in the catalog ship via this rule; zero new canonicals added for broadcast / DOOH / native / generative.

  **2. `slots_override` authoring decision rule** (canonical-formats.mdx). When to use it vs leave it off was implicit across the four annotation patterns. New section + table makes it explicit: would a buyer composing the manifest list **different assets** vs the canonical's defaults? Yes → `slots_override`. No → omit. Worked cases: IAB MREC (default), native standard (override), DOOH (default), broadcast (default), generative (override), host-read podcast (override).

  **3. End-to-end `adagents.json` fetch flow worked example** (canonical-formats.mdx). The pieces were documented separately (publisher catalog, property scoping, capability_id resolution, community-mirror fallback, supersession). New section walks the full buyer journey in order: `Product` with `publisher_properties` → fetch `<domain>/.well-known/adagents.json` → fall back to AAO mirror on 404 → check `superseded_by` → scope `formats[]` by `applies_to_property_ids` → resolve `capability_id` against same-file `formats[]`. Concrete payload sequence included.

  **4. Multi-size fan-out normative decision** (canonical-formats.mdx + error code prose). The spec was silent on whether SDKs MAY fan out a multi-size v2 declaration to N v1 format_ids via catalog lookup. Resolved as MAY-do non-normative: SDKs without catalog access emit only seller-asserted refs (the conservative wire shape, default normative behavior); SDKs with catalog access MAY synthesize the missing per-size refs. Either way, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` MUST fire as a transparency advisory; `error.details.synthesized_refs` lists catalog-resolved entries when fan-out is in play. Two SDKs processing the same input may produce different `format_ids[]` lengths, but the advisory keeps consumers in sync.

  **5. `format_schema` fetch-contract test fixtures** (static/examples/format-schemas/). 14 paired positive + negative test vectors covering all 7 failure-mode categories per the normative contract: digest verification, transport (https-only / redirect / oversize), SSRF (RFC 1918 / metadata endpoint), `$ref` sandboxing (cross-origin / depth-exceeded), schema-compile budget (catastrophic regex), schema validity (body is JSON but not a valid schema), graceful degradation (404 with/without cache). Each fixture documents the `setup` to simulate, the `expected_outcome`, the `expected_error_code`, and the rationale linking back to the contract clause. README at `static/examples/format-schemas/README.md` documents shape and usage. Cross-SDK conformance harness tracked as follow-up #4699.

  Validation: schema build clean, 14 canonical fixtures + 28 negative fixtures (was 19) + 50-entry catalog convention lint all green.

- 9c087a2: **Canonical formats (AdCP 3.1).** v2 introduces a structured creative-format vocabulary that buyers and sellers can validate against without per-seller integration code. 13 canonical `format_kind` values (image, html5, display_tag, image_carousel, video_hosted, video_vast, audio_hosted, audio_daast, sponsored_placement, native_in_feed, responsive_creative, agent_placement, custom) with a two-axis model: `format_kind` names the creative TYPE; `asset_source` names the production model (buyer_uploaded / publisher_host_recorded / seller_pre_rendered_from_brief / seller_human_designed / agent_synthesized). Products carry `format_options[]` declarations narrowing a canonical with `params`, `slots`, `applies_to_channels`, optional `capability_id` for multi-format routing, and optional `experimental` flag. The full reference is at `docs/creative/canonical-formats.mdx`.

  **Wire-shape details adopters care about:**

  - `v1_format_ref` is ALWAYS an array of `{agent_url, id}` entries — single-ref is `[{...}]`. Multi-size declarations carry one ref per size in `params.sizes[]`. The `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE` error code surfaces when ref count < sizes[] count.
  - v1 catalog's `canonical:` annotation is ALWAYS an object — minimal `{ "kind": "image" }`, rich `{ "kind", "asset_source", "slots_override" }`. The object form is what lets the 8 generative catalog entries (`display_*_generative`) project losslessly to v2: buyer ships a text prompt, not image bytes.
  - Display canonicals (`image`, `html5`, `display_tag`) support three size modes (mutex-enforced at schema layer): fixed `width+height`, multi-size `sizes: [{w,h}]` (mirrors OpenRTB `banner.format[]`), responsive `min_width/max_width/min_height/max_height`. The same product can carry N format_options across the three modes.
  - `ProductFormatDeclaration.canonical_formats_only: true` is the v2-only marker (mutex with `v1_format_ref`).
  - `format_kind: "custom"` requires `format_shape` (vocabulary entry) + `format_schema` (URI+digest) and either `canonical_formats_only: true` OR `v1_format_ref`.

  **Publisher catalog (`adagents.json formats[]`).** Publishers declare their format support once via top-level `formats[]` (with optional `applies_to_property_ids` / `applies_to_property_tags` scoping). Placements reference declarations by `capability_id`. For platforms that haven't adopted AdCP (Meta, TikTok, etc.), AAO publishes community-maintained adagents.json at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`; `superseded_by` field signals platform-adoption cutover. New media-buy filters `list_creative_formats(publisher_domain, property_id)` answer "what formats does this publisher accept?" with a normative resolution chain (publisher hosted → AAO mirror → agent-derived from products) and a response `source` field labeling which tier produced the list.

  **Where each piece of metadata lives (the "no new canonical" pattern).** Before reaching for a new canonical, the spec checks: production model → `asset_source`; slot shape → `slots_override`; channel → `applies_to_channels`; tracking / measurement → `sync_event_sources` / `event_log`. New canonical only when the CREATIVE ASSET is structurally different. Applied: generative, broadcast TV, DOOH, native all stay on existing canonicals via sibling refinement. Conversion pixels (Meta Pixel, GA4) explicitly belong on event_log, NOT on `platform_extensions` of a creative format.

  **Coverage at GA.** 50/50 ad formats in the AAO catalog annotated with the projection-ref object form. 7 UI scaffolding entries (`product_card_*`, `format_card_*`, `proposal_card_*`, `native_product_card`) split into `ui-element-formats.json` — they're agent-interface widgets, not ad formats; `list_creative_formats` returns them so consumers can resolve by `format_id`, but they never project to ad canonicals.

  **Error codes added** (all surfaced via response `errors[]` augmentation; non-fatal advisories): `FORMAT_PROJECTION_FAILED`, `FORMAT_DECLARATION_DIVERGENT`, `FORMAT_DECLARATION_V1_AMBIGUOUS`, `FORMAT_CAPABILITY_UNRESOLVED`, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE`, `PIXEL_TRACKER_LOSSY_DOWNGRADE`, `PIXEL_TRACKER_UPGRADE_INFERRED`.

  **Cross-version pixel_tracker contract (normative for SDK auto-negotiation)**: when a 3.1 buyer SDK talks to a 3.0.x seller that doesn't know `pixel_tracker`, the SDK MUST downgrade to v1 `{asset_type: url, url_type: tracker_pixel}` shape and emit `PIXEL_TRACKER_LOSSY_DOWNGRADE` with per-field details. Conversely a 3.1 SDK reading v1 trackers MUST upgrade by inferring event/method from `asset_id` conventions and emit `PIXEL_TRACKER_UPGRADE_INFERRED`. Both directions are lossy-with-advisory — no REFUSE branch, even for `method: js` (v1 sellers fire the URL as a GET; counter-based measurement increments, but JS-execution-dependent measurement like OMID-style verification won't run). Buyer-side decision per asset: accept the loss or route to a 3.1-capable seller. Full bidirectional mapping table documented in `pixel-tracker-asset.json` description.

  **Renderer-fired pixel tracker asset type (#4706)**: new `pixel_tracker` asset type at `static/schemas/source/core/assets/pixel-tracker-asset.json` — the generic web-pixel tracker primitive, applies to any web-rendered canonical (image, html5, image*carousel, responsive_creative, sponsored_placement, native*\*, plus non-VAST/DAAST events on video_hosted/audio_hosted). Discriminated union with `event` (impression, viewable_mrc_50, viewable_mrc_100, viewable_video_50, click, custom), `method` (img, js), `url` (uri-template with universal-macros support), and `custom_event_name` (required when event is `custom`). Discriminator shape and event/method enums formalized in IAB OpenRTB Native 1.2 (`imptrackers[]` / `jstracker` / `eventtrackers[]` / `link.clicktrackers[]`). Scope is RENDERER-FIRED trackers — conversion pixels (Meta Pixel, GA4, server-side postbacks) stay on `sync_event_sources` / `event_log` per the format-vs-event_log boundary documented in canonical-formats.mdx. Formats with format-specific tracker structures keep their own primitives: `vast_tracker` (VAST `<TrackingEvents>`), `daast_tracker` (DAAST parity).

  **Catalog tracker upgrade**: 45 ad-format payload entries in `server/src/creative-agent/reference-formats.json` previously carrying `impression_tracker` as `asset_type: "url"` upgraded to `asset_type: "pixel_tracker"` with `event: "impression"` + `method: "img"` — display / native / dooh / video_hosted / audio_hosted families all benefit. Plus 4 `slots_override` declarations on `native_standard` / `native_content` reshaped to use `pixel_tracker` for impression and click trackers. To match real measurement plans (impression + viewability + click trackers are commonly attached together), 90 additional optional slots added across the 45 web-rendered entries: each now carries `viewability_tracker` (`event: viewable_mrc_50`) and `click_tracker` (`event: click`) as optional `pixel_tracker` slots. Buyer populates only the trackers their measurement plan declares; absent slots are skipped. New vocabulary entries: `impression_tracker`, `click_tracker`, `viewability_tracker` in asset-group-vocabulary, all mapping to `asset_type: pixel_tracker`.

  **`pixel_tracker.event` enum mirrors IAB Native event-type registry**: 5 standardized event values plus `click` and `custom`. Maps 1:1 to IAB OpenRTB Native 1.2: `impression` (1), `viewable_mrc_50` (2), `viewable_mrc_100` (3), `viewable_video_50` (4), `audible_video_complete` (500). `audible_video_complete` is distinct from `viewable_video_50` — the former is 100% completion with audio on; the latter is 50% pixels for ≥2 seconds with audio on. Meaningful on non-VAST video (Meta Reels, YouTube Shorts, TikTok Spark) where audible-complete is measured but VAST `<TrackingEvents>` isn't the wire format.

  **Negative-fixture coverage**: 10 new test vectors for `pixel_tracker` in `tests/canonical-negative-fixtures.test.cjs` covering valid shapes (impression img / impression js / viewable_mrc_50 / click / audible_video_complete / custom-with-name) and the rejection paths (custom without `custom_event_name`, non-custom with `custom_event_name`, invalid event enum, invalid method enum). Total negative-fixture count goes from 28 → 38.

  **Other adopter-facing additions:**

  - `ProductFormatDeclaration.seller_preference: "preferred" | "accepted" | "discouraged"` — soft routing hint on multi-format products.
  - `placement-definition.json format_options[]` (capability_id reference OR inline) with same-file resolution scope.
  - Convention lint at `tests/canonical-format-conventions.test.cjs` enforces: object-form `canonical:`, array-form `v1_format_ref[]`, size-mode mutex, AAO-mirror URL convention, slot/param consistency.

  **Round-2 adopter feedback (Pia Malovrh / Nastassia Fulconis, 2026-05-18 Slack):**

  - **`native_in_feed` canonical added.** 13th `format_kind` covering IAB OpenRTB Native 1.2 in-feed native ads, content-recommendation widgets (Taboola, Outbrain, Yahoo Native, AdMob Native), and publisher in-feed sponsored placements without catalog dependency. Slots map 1:1 to IAB Native asset types (`title`, `body_text`, `main_image`, `icon`, `cta`, `advertiser_name`, `sponsored_label`, `landing_page_url`, plus renderer-fired `pixel_tracker` trackers). Routing answer: buyer agents reading `native_in_feed` know to assemble title+image+body+CTA; reading `sponsored_placement` know to attach a catalog feed. Defaults to non-experimental (IAB Native 1.2 contract is well-established).
  - **`sponsored_placement` narrowed.** Canonical is now normatively catalog-keyed retail-media ONLY: REQUIRES `source_catalog` slot. Schema description explicitly excludes IAB in-feed native, content-recommendation, PMax-style algorithmic surfaces, and single-image/video creative — those route elsewhere. Earlier broader framing failed buyer-agent routing (buyer reading `sponsored_placement` couldn't disambiguate Amazon SP from Taboola).
  - **`scenes` → `video_brief` rename.** Renamed `static/schemas/source/creative/scenes.json` → `creative/video-brief.json` (`$id: /schemas/creative/video-brief.json`), wrapper field `scenes[]` → `segments[]`, per-segment `description` → `prompt`. The shape was always a structured generation brief (no camera direction, shot type, mood, or reference attachments) — the rename calls it that. asset_group_id `scenes` → `video_brief` (with `scenes`, `storyboard`, `shot_brief` as aliases). Distinct from `creative_brief` (free-form text); `video_brief` is the structured timed-prompt form. Buyers wanting visual-direction surface still attach `reference-asset.json` with `purpose: storyboard`.
  - **`seller_preference` semantics clarified.** Schema description and `ProductFormatDeclaration` description now state normatively that `format_options[]` is the closed set of accepted formats for a product — sellers MUST reject `create_media_buy` requests targeting any `format_kind` outside that set. `seller_preference` is a soft ranking hint WITHIN the accepted set, NOT an enforcement axis. There is intentionally no `required` enum value; the closed-set rule already handles "this is the only format that works" (list one entry → that's the set). Pia's "won't work vs please don't" distinction is resolved structurally rather than via enum proliferation.
  - **Registry two-tier boundary documented; platform-specific IDs removed.** Dropped `youtube_video_id` and `pin_id` from `asset-group-vocabulary.json`. Added normative paragraph: the canonical vocabulary is the IAB-aligned portable tier; platform-specific asset identifiers (TikTok video IDs, Snap attachment IDs, Meta Advantage+ creative IDs, etc.) belong on the canonical's `platform_extensions[]` (URI+digest reference to the platform's extension schema). Earlier draft set precedent for every platform's identifier vocabulary leaking into the canonical registry — explicitly reversed before GA.

  **Resolves** #4148 (canonical-formats vocabulary), #4620 (publisher-scoped catalogs), #4652 (.adcp placeholder cleanup), #4689 (catalog generative deannotation). Coordinated with adcp-client #1815 (SDK v1↔v2 projection) and adcp-go (catalog consumer).

- 2938456: feat(registry): add catalog collections and YouTube channel aliases

  Adds first-class registry catalog collections, collection change-feed events, YouTube channel distribution identifier types, collection sync/distribution lookup APIs, and an admin community collection upsert path. This supports publisher-owned collections distributed through third-party platforms such as YouTube while keeping publisher authorization anchored on the publisher's own domain.

- 4deed71: Add catalog content macros (`{ITEM_NAME}`, `{ITEM_DESCRIPTION}`, `{ITEM_TAGLINE}`, `{ITEM_PRICE}`, `{ITEM_PRICE_CURRENCY}`) for catalog-driven creative rendering

  Extends the catalog-item macro family from ID values (`{SKU}`, `{GTIN}`, `{OFFERING_ID}`, …) to scalar content values, so catalog-driven creatives (sponsored_placement / DPA: Meta DPA, Snap Collection, TikTok Shopping) can substitute a rendered item's `name`, `description`, `tagline`, `price.amount`, and `price.currency` into a template. Each token maps 1:1 to a real, documented catalog field via the existing `catalog_field` dot-notation vocabulary (catalog-field-binding.json ScalarBinding) — no parallel field vocabulary is introduced.

  All five are scalar TEXT values and fall under the existing catalog-item substitution-safety rules unchanged (NFC normalization → RFC 3986 percent-encoding to the unreserved set → one-pass nested-expansion prohibition → URL-context scope). No new escaping context is added; conformance vectors for content values are added to `catalog-macro-substitution.json`.

  Single-brace `{MACRO}` only. `{{double-brace}}` stays reserved and is NOT adopted — it is one of the downstream ad-server macro syntaxes (`%%...%%`, `${...}`, `[...]`, `{{...}}`) that sales agents MUST neutralize/percent-encode; adopting it would relax a documented substitution-safety guarantee.

  Which catalog items render stays seller-declared via the already-shipped `fanout_mode` enum on `sponsored_placement.json` (`single_item` / `per_item` / `multi_item_in_creative`); no buyer-side selection field is added. On ML-optimized DPA surfaces (Meta Advantage+, TikTok Shopping) the platform may override buyer-authored overlay text, so content macros are a buyer-declared hint the seller MAY honor.

  `format.supported_macros.items` auto-extends via its `anyOf` universal-enum branch (#5099); no schema edit is needed there. Closes #5277.

- 42f3557: Add `committed_metrics_supported` capability flag to
  `media-buy-features.json`. Closes the buyer-side detection gap from
  #3510 where absence of `committed_metrics` was indistinguishable
  between 'seller didn't snapshot' and 'seller doesn't have snapshot
  infrastructure.' Closes #3517.

  **Why one flag (not two).** Per the unified metric-accountability
  design (#3576), `committed_metrics` is a single array carrying both
  standard and vendor-defined entries. The flag inherits that unification —
  one flag declares the seller's snapshot capability across the whole
  contract surface.

  **MUST timing — atomic.** Sellers declaring this flag `true` MUST
  populate `committed_metrics` on every `create_media_buy` response AND
  MUST honor append-only mid-flight metric additions via `update_media_buy`.
  The MUST ships with the flag, not as a future tightening — advisory-only
  flags leave the audit gap exploitable, defeating the purpose.

  **Placement choice — Option A (extend `media-buy-features.json`).**
  Matches the existing `property_list_filtering` / `catalog_management`
  precedent. Buyers can pass it as a `required_features` filter on
  `get_products` to narrow the catalog to snapshot-supporting sellers —
  that side effect is the design intent, not a bug.

  **Backwards compatibility.** Optional and additive. Sellers without
  the flag are unchanged; buyers ignore the flag if they don't filter on
  snapshot support.

  Closes #3517.

- 59f1c37: Add `package.committed_metrics` and `package.committed_vendor_metrics` —
  frozen snapshots of the product's `reporting_capabilities.available_metrics`
  and `vendor_metrics` stamped at `create_media_buy` response time. Closes
  #3481.

  **The audit gap.** PR #3472 established that the product's
  `available_metrics` becomes the binding reporting contract carried into
  the resulting media buy. That holds **only if** the product is immutable
  AND the seller stores a snapshot at buy creation. Neither is guaranteed:

  - Products mutate (sellers add/remove metrics from `available_metrics`
    as their reporting infrastructure evolves)
  - Without a per-package snapshot, `missing_metrics` on
    `get_media_buy_delivery` is computed against "what the product
    _currently_ advertises" — a 90-day-old buy is incorrectly judged as
    "clean" because the seller quietly dropped a metric they originally
    committed to
  - An ops team auditing a 90-day-old buy will not trust an implicit
    contract reference

  This was flagged on PR #3472 by the product expert as the primary
  sell-side audit gap.

  **Changes.**

  - `core/package.json`: new `committed_metrics: AvailableMetric[]` field
    and new `committed_vendor_metrics: { vendor, metric_id }[]` field. Both
    optional in v1; sellers without per-package snapshot infrastructure
    fall back to the product's live state (absence is conformant). Both
    MUST NOT change post-creation — `update_media_buy` cannot modify them.
    Renegotiating the metric contract requires a new buy.
  - `media-buy/get-media-buy-delivery-response.json`: `missing_metrics`
    description updated to declare the reconciliation source — when
    `committed_metrics` is present, that is the contract; when absent,
    fall back to the product's current `available_metrics`.
  - `docs/media-buy/task-reference/create_media_buy.mdx`: new "Reporting
    contract on confirmed packages" subsection documenting the snapshot
    semantics, immutability, and v1-optional posture.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: bullet
    updated to point at the reconciliation source.

  **Design choices spelled out (resolves the three open questions on #3481).**

  1. **Optional or required?** Optional. Forcing the snapshot at v1 would
     break existing implementations on first deployment. Optional with a
     doc note that "buyers SHOULD reconcile against `committed_metrics`
     when present and fall back to the product's live state when absent"
     lets sellers adopt incrementally. Expected to become required at the
     next major.

  2. **What snapshots into `committed_metrics`?** The product's full
     `reporting_capabilities.available_metrics` at the moment of
     `create_media_buy`, NOT the intersection with the buyer's
     `required_metrics` filter. The product committed to reporting all
     those metrics; reducing to the intersection would silently drop
     reporting on metrics the buyer didn't explicitly list but the seller
     still has. `requested_metrics` (on `reporting_webhook`) remains the
     buyer's payload-optimization filter — a separate concept.

  3. **Mutation policy?** Frozen at creation, MUST NOT change post-creation.
     `update_media_buy` cannot modify `committed_metrics` or
     `committed_vendor_metrics`. If the buyer/seller need to renegotiate,
     that's a new buy. This is the cleanest contract; mutability with
     audit trail can be added later if real demand emerges.

  **Backwards compatibility.** Optional and additive. Sellers without
  snapshot infrastructure fall back to the implicit contract (product's
  current state) — this matches the v1 behavior of #3472. Buyers can
  incrementally upgrade to consume `committed_metrics` when present.

  Closes #3481.

- a88d106: Registry: community-mirror catalog lifecycle (#2176).

  Makes AAO catalog-only adagents.json mirrors first-class registry resources. A community mirror is the catalog-only adagents.json (`authorized_agents: []` + formats/properties/placements) AAO publishes on behalf of a platform that hasn't adopted AdCP, served at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`. Builds on #5352/#5353, which made `authorized_agents: []` valid.

  - **Store:** new `community_mirrors` table (migration 506) keyed by `platform`, with the adagents.json body, `catalog_etag`, `superseded_by`, and provenance.
  - **Endpoints** (`/api/registry/mirrors`):
    - `GET /api/registry/mirrors` — list mirrors with their `catalog_etag` (public).
    - `GET /api/registry/mirrors/:platform` — read one mirror (public).
    - `PUT /api/registry/mirrors/:platform` — idempotent publish/upsert (registry moderators or admins). Forces `authorized_agents: []`, requires catalog content, validates the proposal.
  - **Serving:** `GET /translated/:platform/adagents.json` on the creative agent serves the stored mirror with an `ETag` (from `catalog_etag`, falling back to a content hash), `If-None-Match` → `304`, `Cache-Control`, and a `superseded_by` → `Link: rel="successor-version"` header.

  Read-back by platform and listing close the gap where published mirrors could not be retrieved; the idempotent upsert lets audit fixes update in place instead of duplicating.

- d6e94f4: Registry: add `DELETE /api/registry/mirrors/:platform` to retire a community mirror.

  Completes the #2176 community-mirror lifecycle with a moderator/admin-gated retire endpoint, closing the post-supersession deprecation window. Because buyers cache the mirror URL and fall back to it until the platform self-adopts, deletion refuses a mirror that has not published a `superseded_by` migration signal unless `?force=true` is passed — so live fallback traffic isn't yanked out from under buyers. After deletion the serving route returns 404, the documented "no mirror" state. The publish/delete authorization check is factored into a shared helper.

- 15cbd99: Add `completion_source` qualifier key to disambiguate seller-attested vs vendor-attested `completion_rate`. Closes #3861 with Option C from the issue.

  **The hybrid problem.** `completion_rate` is dual-natured: the seller witnesses completion via player events (the seller's player fired the completion beacon), and third-party measurement vendors can independently attest to completion via SDK callbacks, panel methodology, or server-side beacon validation. The two paths can yield materially different rates — particularly in SSAI environments where the player's view of completion may differ from a vendor's. Same `metric_id`, two semantics — exactly the case the [taxonomy doc](https://docs.adcontextprotocol.org/docs/measurement/taxonomy)'s working rule of thumb addresses ("if two layers seem to claim the same field, the field is probably two fields wearing one name — split it").

  **The qualifier slot is the right home.** Instead of splitting the metric_id (`seller_completion_rate` vs `verified_completion_rate`), surface the dual nature at the qualifier layer that #3576 already established for viewability. Viewability is now joined by completion_rate as a Tier 1 graduated metric using the qualifier slot — proves the pattern is generalizable, not viewability-specific.

  **Schemas added.**

  - `enums/completion-source.json`: closed enum `["seller_attested", "vendor_attested"]` with descriptions.

  **Schemas updated.**

  - `core/package.json` `committed_metrics.qualifier`: adds `completion_source` alongside `viewability_standard`. MUST be set when `metric_id` is `completion_rate` and the seller commits to a specific source.
  - `media-buy/package-request.json` `committed_metrics.qualifier`: same shape on the buyer-side request surface.
  - `media-buy/get-media-buy-delivery-response.json` `aggregated_totals.metric_aggregates.qualifier`: adds `completion_source` for partitioned delivery rollups by source.
  - `media-buy/get-media-buy-delivery-response.json` `by_package[].missing_metrics.qualifier`: adds `completion_source` for accountability — a buyer expecting vendor-attested completion flags a seller-attested-only delivery report as missing the vendor commitment.

  **Vendor identity** is anchored on the matching `performance_standard.vendor` BrandRef in the buy contract, not duplicated on the metric row. Same pattern as MRC viewability anchored on `performance_standard.vendor` for the DV/IAS/etc. case.

  **Reconciliation.** The atomic-unit join `(scope, metric_id, qualifier)` from #3576 + #3848 (just-merged `metric_aggregates`) extends naturally — completion_rate rows now carry a `completion_source` qualifier, joined like viewability_standard rows. No reconciliation logic changes; new keys plug into the existing slot.

  **Doc updates.**

  - `docs/media-buy/task-reference/create_media_buy.mdx` — `committed_metrics` reporting contract section now lists both qualifier keys (viewability_standard and completion_source) with their conditional-required semantics.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — qualifier vocabulary section names both keys; missing_metrics description shows the completion_source flagging example.

  **Backwards compatibility.** Additive. Existing `committed_metrics` / `missing_metrics` / `metric_aggregates` consumers without qualifier-aware reconciliation continue to work; the closed-vocabulary nature of qualifier means new keys appear only in subsequent minors with explicit migration paths.

  Closes #3861.

- c6fb0dd: spec(errors): add `CONFIGURATION_ERROR` to canonical error catalog

  Adds a standard error code for **adopter-side server misconfiguration** — a deployment that the seller has stood up incorrectly, that the buyer cannot fix, that is not transient, and that is not an opaque crash. The canonical catalog previously had no code that fit this slot: `INVALID_REQUEST` is buyer-fixable, `SERVICE_UNAVAILABLE` is transient, `UNSUPPORTED_FEATURE` is a capability mismatch, `ACCOUNT_SETUP_REQUIRED` is buyer-side onboarding, and `GOVERNANCE_UNAVAILABLE` is scoped to a registered governance agent. Concrete failure modes the new code fits: an account is declared with `mode: 'mock'` but no `mock_upstream_url` is populated; a platform is declared with `mode: 'live'` or `mode: 'sandbox'` but no `upstream_url` is declared; a required environment variable is unset on the seller process. Recovery is `terminal` — the buyer MUST surface to the seller's operator and MUST NOT auto-retry, since retries cannot resolve a misconfigured deployment until the operator intervenes.

  Wire shape is unchanged — the code itself is the discriminator, no `error-details/configuration-error.json` is registered (mirroring the minimal-disclosure precedent of `AGENT_SUSPENDED` / `AGENT_BLOCKED`); `error.message` carries the operator-readable diagnostic. Sellers SHOULD calibrate that message to a level useful to a seller-side operator without leaking deployment internals to the buyer. The new code is additive — existing catalog entries are unchanged, and SDKs that fall back to the `recovery` classification on unknown codes will already treat unknown sightings as terminal per the forward-compatibility rule in `error-handling.mdx`.

  Closes #3995.

- f3705ae: Add contextual signal coverage forecasts for signal discovery and product-relative availability planning.

  Signals can now include optional `coverage_forecast` data with an explicit denominator, bucket overlap semantics, bucket completeness, and forecast points keyed by canonical signal dimensions. Forecast points gain a `signal` dimension kind and `coverage_rate` becomes a standard forecastable metric for availability breakdowns.

  The feature is additive on the wire. Existing `coverage_percentage` remains available for compatibility, but richer planning should use `coverage_forecast` when sellers can disclose the denominator and value-level distribution.

- 313e3a9: Add top-level `paused` to `create_media_buy` so buyers can create campaigns with
  delivery held from the outset. A start-paused buy returns `media_buy_status:
"paused"` once activation prerequisites are satisfied; missing creatives and
  future start dates still surface as `pending_creatives` and `pending_start`.
- a091c67: Add `media_buy.creative_approval_mode` to `get_adcp_capabilities` so sellers can declare whether human review can block serving eligibility after creatives are assigned and automated validation passes.

  Sellers with any reachable manual-review workflow declare `require_human`, which lets compliance runners skip auto-approval-dependent storyboards instead of reporting false failures. Omission is legacy-unspecified rather than an affirmative `auto_approve` claim; the `pending_creatives_to_start` storyboard now runs only when sellers explicitly declare `auto_approve`.

- af1d287: spec(creative): add `list_transformers` task + account-scoped creative transformers, and extend `build_creative` for transformer selection and variant/catalog multiplicity.

  A **transformer** is the creative analog of a media-buy product: an agent-offered, account-scoped, selectable unit of build capability (a voice, model, style, or director) with a typed configuration surface and per-account pricing. This makes account-specific render configuration — including custom values like cloned voices that exist only for one credential — discoverable from the agent rather than guessed, hung on a global format, or smuggled through `ext`.

  Strictly additive. Existing `build_creative` callers are unaffected (all new request fields are optional; the shipped `BuildCreativeSuccess`/`BuildCreativeMultiSuccess` response shapes are unchanged — a new fifth member is added alongside them).

  New:

  - `list_transformers` task (creative protocol): account-scoped, brief-filterable, paginated discovery. An `expand_params` mode returns account-scoped enumerable option **values** (e.g. your configured voices) on the same tool — no separate options endpoint.
  - Core schemas `transformer.json` and `transformer-param.json`.
  - `get_adcp_capabilities` → `creative.supports_transformers` discriminator.

  `build_creative` extensions:

  - Request: `transformer_id` (select one transformer; target format(s) must be a subset of its `output_format_ids`), `config` (typed bag keyed to the transformer's params — agents MUST reject unknown/out-of-range values), `max_creatives` (catalog/item fan-out: N distinct creatives, one per item, with sampling), `max_variants` + `variant_axis` + `keep_mode` (alternatives per creative).
  - Response: a new `BuildCreativeVariantSuccess` member — `creatives[]` each carrying `variants[]`, with a `build_variant_id` namespace (distinct from preview `preview_id` and served `variant_id`), per-leaf pricing receipt, and `items_total`/`items_returned`. Best-of-N is variants + `recommended`/`rank`. You pay for all produced variants (`per_unit` × N); a kept variant lazily earns a `creative_id` on trafficking, which flows to `report_usage`. Per-format atomic; per-item non-atomic.

  `build_variant` lineage + refinement:

  - `build_variant_id` is now the leaf-level lineage anchor (`x-entity: build_variant`): minted per produced variant, distinct from the call-level `build_creative_id`, lazily earning a durable `creative_id` only on trafficking. Untrafficked leaves are billed via the inline per-leaf `vendor_cost` only; `report_usage` reconciliation applies once a leaf earns a `creative_id`.
  - Conversational refinement: `build_creative` gains `refine_from_build_variant_id` — re-build a prior leaf with a natural-language instruction in `message` plus an optional `config` delta, returning new lineage-linked variants (each with `parent_build_variant_id`); never a mutation. Composes with `max_variants`/`variant_axis`, mutually exclusive with `max_creatives`. Gated by the new `get_adcp_capabilities` → `creative.supports_refinement` discriminator (`UNSUPPORTED_FEATURE` when unsupported; `REFERENCE_NOT_FOUND` for an unknown/expired ref).

  Pricing rides the existing `per_unit` model + inline receipt + `report_usage` unchanged — transformers carry `pricing_options` (reusing `vendor-pricing-option.json`).

  Deprecations (deprecated in 3.1, removed at 4.0; SDKs MUST keep honoring them through 3.1–3.x): `Format.input_format_ids`, `Format.output_format_ids`, `Format.pricing_options`, and the `input_format_ids`/`output_format_ids` discovery filters on `list_creative_formats` — all superseded by `list_transformers`, which carries each transformer's own I/O signature and pricing.

- 431cc86: Reconcile creator and engagement conversion events with the existing metric vocabulary by adding `follow`, `content_view`, and `watch_milestone` event types, clarifying `subscribe` as paid, adding structured event surfaces and progress fields, and allowing per-source `ext` metadata on `sync_event_sources` results.
- de60c64: spec(auth): require buyer-principal credentials on transport channel; add `CREDENTIAL_IN_ARGS` error code

  The AdCP spec was previously silent on credential placement. Buyer-principal credentials arrive over the transport's authentication channel — Bearer per RFC 6750 §2, RFC 9421 signature headers, MCP/A2A authentication framing per RFC 9728 §3, or mTLS — but nothing in the spec said credentials MUST arrive there and MUST NOT arrive embedded in the task payload. In practice the gap produced a recurring bug class: storefront-shaped adopters independently rediscovered top-level `<platform>_access_token`, then nested `request.context.<platform>_access_token`, then `request.ext.<platform>_access_token` — three rounds of expert review on a single PR each surfacing a different smuggling vector. Without spec-level clarity, every adopter reaches the same conclusion independently and ships its own ad-hoc allowlist.

  This release adds a normative **Credential placement** section to `authentication.mdx` after the existing tenant-resolution paragraph: buyer-principal credentials MUST arrive on the transport's authentication channel and MUST NOT be placed in the task payload — top-level, in `context`, in `ext`, or any other nested location. The rule is transport-agnostic; it applies under every supported authentication mechanism. Two carve-outs are explicit: `push_notification_config.authentication.credentials` (the legacy seller-to-buyer webhook authentication, orthogonal to the buyer principal) and onboarding-time secrets exchanged out-of-band. Relay topologies (#2324) authenticate under the relay's own principal — pass-through preserves the brand agent's RFC 9421 signature, re-signing carries brand-agent identity in the request body as identity context — neither model permits forwarding the brand's transport credential as a relay-side payload field.

  A new error code, `CREDENTIAL_IN_ARGS`, joins `error-code.json`. Sellers SHOULD reject credential-in-args under AdCP 3.1; the requirement upgrades to MUST 90 days after the 3.1 publication date. The code's recovery classification is `terminal` — auto-retry against this code re-logs the credential on each attempt, exactly the prompt-injection exfiltration surface the rule closes (`security-model.mdx#threats-specific-to-agentic-advertising`). `error.field` identifies the path at which the credential was detected (e.g., `request.context.access_token`) and MUST NOT echo the credential value or any prefix of it; sellers MUST drop the smuggled credential from logs, audit rows, and observability spans before persisting the rejection. `CREDENTIAL_IN_ARGS` is distinct from `AUTH_REQUIRED` (no credentials presented or transport-channel credentials rejected) and `PERMISSION_DENIED` (authenticated caller not authorized).

  The new code is additive — existing catalog entries are unchanged, and SDKs that fall back to the `recovery` classification on unknown codes already treat unknown sightings as terminal per the forward-compatibility rule in `error-handling.mdx`. The 90-day SHOULD-to-MUST window gives implementations time to land detection without leaving credentials sitting in LLM-visible payloads during the migration.

  Closes #4046.

- 68b86a5: Restructure `product.delivery_measurement.provider` as a `vendors: BrandRef[]` array, deprecating the legacy free-form string. Closes the BrandRef-migration half of #3860; the merger-with-`performance_standards` question is deferred to a follow-up RFC since it requires more design (`delivery_measurement` describes the _overall_ measurement story while `performance_standards` carries _committed_ metrics with thresholds — they're different concerns).

  **The BrandRef migration.** Before this minor, `delivery_measurement.provider` was a string like `"Google Ad Manager with IAS viewability"` — buyer agents had to string-parse to find the verification vendor. The string also conflated two jobs: vendor identity AND methodology description. With this minor:

  - New `vendors: BrandRef[]` field — structured measurement-vendor identity, anchored on `brand.json` `agents[type='measurement']`. Array because a single product often has multiple vendors playing different roles (ad server + viewability vendor; retail-media seller + third-party retail measurement). Each entry's measurement-agent capabilities catalog is queryable via `get_adcp_capabilities.measurement.metrics[]`.
  - Legacy `provider: string` — marked deprecated. Dropped from the schema's `required` array (was previously the lone required field on `delivery_measurement`); retained for one-minor backwards compatibility. When both fields present, consumers MUST use `vendors` for identity and treat `provider` as informational text.
  - `notes: string` — clarified as free-form methodology prose only, not vendor identification.

  **Distinct from `performance_standards.vendor`.** `delivery_measurement.vendors` carries vendor identity for the overall measurement story (including non-committed-but-reported metrics); `performance_standards[].vendor` carries vendor identity for _committed_ metrics with thresholds. The two fields cover different scopes — the merger question raised in #3860 is deferred.

  **Migration.**

  ```json
  // before
  "delivery_measurement": {
    "provider": "Google Ad Manager with IAS viewability",
    "notes": "MRC-accredited viewability. 50% in-view for 1s display / 2s video."
  }

  // after
  "delivery_measurement": {
    "vendors": [
      { "domain": "googleadmanager.com" },
      { "domain": "integralads.com" }
    ],
    "notes": "MRC-accredited viewability. 50% in-view for 1s display / 2s video."
  }
  ```

  **Backwards compatibility.** Additive (new field, deprecated field retained, required dropped). Existing implementations populating `provider` continue to work for one minor; removed at the next major.

  **Doc updates.** `media-products.mdx` field description reflects the structured shape.

  Closes #3860 (BrandRef migration). The merger-with-`performance_standards` question stays open as a follow-up.

- 9ce754e: Close two reporting gaps on `core/delivery-metrics.json`: a duration metric that had no reporting-side counterpart, and ambiguous reach/frequency measurement windows. Attention metrics (#4579) are intentionally **not** added as flat scalars — see below.

  **`viewability.viewed_seconds` (#4579, partial).** Extend the existing `viewability` block to include `viewed_seconds` — average in-view duration per measurable impression. Buyers can already set `viewed_seconds` as an optimization goal in `optimization-goal.json`; this gives them a place to receive the reported value back. Nested into `viewability` rather than added as a top-level scalar because the viewability `standard` governs the in-view threshold for both `viewable_rate` and `viewed_seconds`, and they share the same `measurable_impressions` denominator. The vendor identity is already carried on the parent block.

  **Attention metrics (#4579, remainder).** `attention_seconds` and `attention_score` are intentionally **not** added as graduated delivery-metrics fields. Per `docs/measurement/taxonomy.mdx`, vendor-specific metrics with no industry-graduated standard flow through `vendor_metric_values` — every attention vendor (DoubleVerify, IAS, Adelaide, TVision, Lumen, …) defines them differently with no MRC-or-equivalent accreditation. The reporting path is `vendor_metric_values[]` with `metric_id: "attention_seconds"` or `"attention_score"` and the vendor identified on the row. The `optimization-goal.json` metric enum description is updated to point reporters at this path so the optimization-side and reporting-side stay aligned without schema-graduating these vendor-specific metrics.

  **`reach_window` for reach/frequency disambiguation (#4580).** Add `reach_window` to declare the measurement window for reported `reach` and `frequency`. Before this minor, a buyer summing `reach` across daily delivery rows could silently double-count audiences — a seller could legitimately report daily uniques, cumulative-to-date uniques, or a custom window, with no way for the buyer to tell. With this minor:

  - `reach_window: { kind: "cumulative" | "period" | "rolling", period?: Duration }`. `cumulative` = uniques since campaign start (do not sum across rows; each later row supersedes). `period` = uniques within a single non-overlapping reporting period — e.g., a daily snapshot. `rolling` = uniques within a trailing window — e.g., trailing-7-day reach reported by Nielsen, iSpot, GAM, DV360. The `period: Duration` field is required when `kind` is `period` or `rolling` (enforced via `if/then` so a `kind: "period"` row without a `period` field is rejected at validation).
  - `reach` and `frequency` descriptions updated to reference `reach_window`. When `reach_window` is omitted, the window is unspecified — buyers MUST NOT sum reach across rows or compare/average frequency across rows.
  - Sellers SHOULD populate `reach_window` whenever `reach` is present. Not made hard-required for backwards compatibility, but the description language is prescriptive.

  **Backwards compatibility.** Additive. `viewability.viewed_seconds` and `reach_window` are both optional. Existing sellers continue to validate without changes; existing buyers ignoring the new fields keep working. Buyers SHOULD upgrade their reach summation logic to gate on `reach_window` semantics.

  **Doc updates.** Metrics tables in `docs/media-buy/task-reference/get_media_buy_delivery.mdx` and `docs/creative/task-reference/get_creative_delivery.mdx` reflect the changes.

  Closes #4580. Addresses #4579 partially (viewed_seconds added; attention metrics routed via vendor_metric_values).

- f138c04: Extract remaining delivery-report inline row schemas into named core schemas for SDK generation, and reserve `x-adcp-open-payload: false` until a canonical generator contract exists.
- 3a33e82: spec(specialisms): deprecate sales-proposal-mode (refs #3823 item 4, #3844)

  Proposal mode is how guaranteed deals get sold in practice — RFP → proposal → review → finalize → IO signing → live. Auction-based sales don't have proposals; they're bid-by-bid. Today `sales-proposal-mode` (proposals + briefs) and `sales-guaranteed` (IO + guaranteed) are halves of the same flow that force sellers to declare both or pick the wrong one.

  Following the established `signed-requests` precedent (deprecated in 3.1, retained until 4.0):

  - Adds `sales-proposal-mode` to `x-deprecated-enum-values` in `static/schemas/source/enums/specialism.json`
  - Updates `enumDescriptions[sales-proposal-mode]` with the deprecation note + migration path
  - Adds a deprecation banner to the storyboard at `static/compliance/source/specialisms/sales-proposal-mode/index.yaml`
  - Updates `sales-guaranteed`'s narrative to explain how proposal flows relate to guaranteed selling and why proposal_finalize is not yet folded into its `requires_scenarios`

  The clean folding of `proposal_finalize` into `sales-guaranteed.requires_scenarios` (so both flavors of guaranteed selling grade against the proposal lifecycle) needs a wire-level capability flag the storyboard runner can use to skip the scenario as `not_applicable` for direct-buy guaranteed sellers (auction PG, retail SKU; no RFP). The runner gates only on `requires_capability` predicates against `get_adcp_capabilities`, not on scenario-level metadata. Tracked as a follow-up in #3844 (`add supports_proposals capability flag`).

  **Migration through 3.x**: sellers that do proposals continue to declare BOTH `sales-guaranteed` AND `sales-proposal-mode` so the proposal flow grades under the proposal-mode specialism's existing storyboard bundle. Pure-direct-buy guaranteed sellers (auction PG, retail SKU) declare only `sales-guaranteed`. The wire shape is unchanged — both enum values remain valid through 3.x.

  **At 4.0**: with the `supports_proposals` capability flag in place (#3844), `proposal_finalize` joins `sales-guaranteed.requires_scenarios` with capability-gated skip semantics, the `sales-proposal-mode` enum value is removed, and the storyboard bundle is retired.

- 971ffe4: `brand.json` gains a fifth variant and distributed publishing model. Additive — existing publishers unchanged.

  **New variant — Brand Canonical Document.** A self-published per-brand document carrying the brand's identity attributes plus optional `house_domain` (string, the domain of the brand's parent house). Standalone brands (no parent house — Patagonia, Liquid Death) omit `house_domain`. Excludes top-level house-only fields (`house`, `brands`, `brand_refs`, `authorized_operators`) and redirect-variant fields (`authoritative_location`, `region`, `note`, `redirect_reason`, `redirect_effective_at`) to disambiguate from the other four variants.

  **House Portfolio additions.** Gains `brand_refs[]` — portfolio entries for brands whose canonical documents live elsewhere (child-owned data). Each entry has shape `{ domain, brand_id, managed_by?, effective_at? }`. The entry shape is defined as `#/definitions/portfolio_entry` (the name is distinct from `core/brand-ref.json`, which is the buyer-side schema for identifying brands in media-buy plans). `managed_by` (optional) is house-declared and explicitly non-trust-bearing — it's a directory field for aggregation across houses. `effective_at` (optional) is the publisher-declared timestamp consumers use to age mutual-assertion edges. Required widened from `["house", "brands"]` to `["house"]` with `anyOf` requiring at least one of `brands[]` or `brand_refs[]`.

  **Trust model.** A child Brand Canonical Document declares `house_domain: "<house>"`; the house's `brand_refs[]` must reciprocate for mutual-assertion trust. Trust resolves at two layers: brand identity (logos/colors/tone/tagline — authoritative on the leaf's TLS alone) and brand relationships (governance, billable inclusion — gated on mutual assertion). A leaf-only edge keeps identity trust and surfaces a self-healing notification SHOULD to the house's `contact.email`. Standalone (no `house_domain`) trumps any third-party portfolio claim. Compliance fields resolve strictest-of (union); `policy_categories` and brand-level `disclaimers[]` enumerated alongside `data_subject_contestation` and `compliance_policies`.

  **Typed brand-level trademarks.** New `#/definitions/trademark` extracts the inline house-portfolio shape (`{registry, number, mark}`) as a named definition with optional `status`, `license_type`, `licensor_domain` (when `license_type=licensed_in`), `countries`, and `nice_classes` (Nice Classification for cross-industry disambiguation — Delta-airline vs Delta-faucet). The existing `brand` definition now accepts typed `trademarks: Trademark[]`, enabling both inline `brands[]` entries and self-publishing Brand Canonical Documents to carry their brand-specific marks. House-level `trademarks[]` remains for corporate-level marks; resolution is union.

  **Conformance invariants** (validator + lint, not JSON Schema expressible):

  - `brand_id` MUST NOT appear in both `brands[]` and `brand_refs[]`; `brand_id` and `domain` MUST each be unique within `brand_refs[]`.
  - `house_domain` MUST NOT appear inside `brands[]` entries.
  - Mutual-assertion verification MUST follow House Redirects on the house side before comparing membership.
  - `managed_by` is a directory field — consumers MUST NOT use it for trust or authorization. Aggregation by `managed_by` is the intended use.
  - Standalone trumps third-party claim.
  - Compliance strictest-of for `data_subject_contestation`, `compliance_policies`, `policy_categories`, audience exclusions, regulated-category flags, and brand-level `disclaimers[]`.
  - Edge aging via `brand_refs[].effective_at` (or consumer's first observation); AAO's reference crawler ages at 180 days.
  - Self-healing: leaf-only edges SHOULD trigger consumer-side notification to the house's `contact.email`, rate-limited per `{leaf, house}` pair.

  **Publisher migration.** Free-text values for the existing inline `trademarks[].status` or `trademarks[].countries` properties now must conform to the typed enum (`active|pending|abandoned|cancelled|expired`) and ISO 3166-1 alpha-2 respectively. Publishers using non-conforming values will surface validation errors and need to update; the field shape was previously open via `additionalProperties: true` so this is the only behaviour change visible to existing data.

  `brand-json.mdx` is the normative spec — Motivation, the five variants, the trust model with self-healing notification, Adopting `brand_refs[]`, Out-of-scope cases (JVs, PE-opacity, jurisdictional governance), the resolution algorithm, Trademarks, Conformance, and prior art (ads.txt / app-ads.txt / sellers.json, WebFinger / host-meta) all live there.

- 013ff96: spec(envelope): add `adcp_error` to `protocol-envelope.json` + envelope-aware lint resolution

  The `protocol-envelope.json` schema already declared `replayed`, `status`, `task_id`, `context_id`, `governance_context`, etc. — and explicitly states (line 5): "Task response schemas should NOT include these fields - they are protocol-level concerns." Storyboards correctly assert on envelope-level fields (`path: "replayed"`, `path: "adcp_error"`), but the validations-path lint walked only the per-task `response_schema_ref` and never the envelope, so those assertions were stuck behind allowlist entries.

  Two changes here:

  1. **Schema:** add `adcp_error: $ref core/error.json` to `protocol-envelope.json`, mirroring the field's normative description in `error-handling.mdx#envelope-vs-payload-errors-the-two-layer-model`. The envelope already had `replayed` for the parallel transport-level idempotency-replay indicator; `adcp_error` is the corresponding transport-level error signal that fatal task failures populate alongside the payload's `errors[]`. The envelope schema previously omitted it — a documentation/schema drift this closes.

  2. **Lint:** `lint-storyboard-validations-paths.cjs` now falls back to `protocol-envelope.json` when a path's first segment isn't found in the response schema. Replaces the storyboard-by-storyboard allowlist for envelope-level paths with structural resolution. Both `replayed` (3 entries) and `adcp_error` (1 entry) now resolve cleanly; allowlist drops to zero.

  ### What this PR is NOT doing

  The protocol-expert review pushed back on the original direction (adding `replayed` to `create-media-buy-response.json` for "consistency" with 8 mutating-task payload schemas that already define it). Those 8 schemas are themselves violating the envelope contract — they redundantly declare envelope fields at the payload level, contradicting `protocol-envelope.json:5`. Removing `replayed` from those 8 schemas is a separate spec cleanup PR (deprecation-window question for any SDK currently reading off the payload).

  ### Test plan

  - [x] `npm run test:schemas` (clean — `adcp_error` field validates as a valid `$ref`)
  - [x] `npm run test:storyboard-validations-paths` (13 tests pass; 3 new cases lock in envelope-aware resolution and the "first segment must match an envelope property for fallback to fire" rule)
  - [x] `npm run test:examples`
  - [x] Lint runs clean across all 82 storyboard files with an empty allowlist

- bd3a18c: spec(error): standardize VALIDATION_ERROR `issues[]` as a normative field on `core/error.json`

  Closes #3059. Adds an optional top-level `issues` array to the standard error envelope, normalizing what `@adcp/client` (and prospectively `adcp-go` / `adcp-client-python` / hand-rolled sellers) already need for multi-field validation rejections.

  **Why minor**: new optional field on a published schema (`core/error.json`). Existing senders/receivers stay conformant — the field is additive. Receivers that ignore unknown fields keep working; receivers that look for it gain a richer pointer map without parsing `message` text.

  **Shape**: each entry is `{ pointer (RFC 6901), message, keyword, schemaPath? }`. `schemaPath` MAY be omitted in production to avoid fingerprinting `oneOf` branch selection on adversarial payloads.

  **Backward compatibility with `field` (singular)**: when both are present, sellers SHOULD set `field` to `issues[0].pointer`. Pre-3.1 consumers reading only `field` get the first failure; 3.1+ consumers prefer the top-level `issues`.

  **`details.issues` mirror**: sellers MAY mirror `issues[]` into `details.issues` for backward compat with consumers reading from `details`. New consumers should prefer top-level.

  Updates:

  - `static/schemas/source/core/error.json` — adds `issues` property with item shape
  - `docs/building/implementation/error-handling.mdx` — adds `issues` to the error-envelope field table; clarifies `field`/`issues` interaction

- 6da3000: spec(error): canonicalize `schema_id` + `discriminator` on `core/error.json#issues[]`; unify the validator-internals production-emit stance with carve-outs

  Closes #3867. Adds two optional fields to every `issues[]` item on the standard error envelope and harmonizes production-emit guidance across the three validator-internals fields (`schemaPath`, `schema_id`, `discriminator`) — including normative carve-outs for cases where the public-spec replay rationale doesn't apply.

  **Why minor**: pure additive optional fields on a published schema. Existing senders/receivers stay conformant — both fields ride the wire today through `additionalProperties: true` via `@adcp/sdk`'s TypeScript client (adcp-client#1307), which is what motivated canonicalization. Cross-SDK consumers (Python, Go) couldn't rely on the field names without a spec entry.

  **`schema_id`** — the `$id` of the rejecting (sub-)schema. For tools served from the flat tree (modular, with `$ref`s preserved), this lands on the deepest published sub-schema (e.g. `/schemas/3.1.0/core/activation-key.json`) so the adopter can navigate directly to the failing variant. For tools served from the bundled tree, `$id` preservation during bundling (companion change in `scripts/build-schemas.cjs`, also closing #3868) lets `schema_id` reach the same deep sub-schema; consumers reading bundles produced before that fix see the response-root `$id` instead, which still names a valid published schema. Snake_case to match the rest of the error envelope (`retry_after`, etc.); the older `schemaPath` (camelCase) is retained for 3.0.x backward compatibility and renamed to `schema_path` in a future major.

  **`discriminator`** — array of `{property_name, value}` pairs identifying the const-discriminated variant the validator selected from values present in the payload. The inner field is named `property_name` (not `field`) to avoid collision with the top-level `error.field` (JSONPath-lite pointer to the offending payload location), and to align directly with OpenAPI 3.x `discriminator.propertyName`. Compound discriminators (e.g. `audience-selector`'s `(type, value_type)`) produce multiple entries; entry order MUST follow declaration order in the rejecting schema's `properties` block.

  The discriminator semantics are tightened to avoid leaking validator implementation details:

  - Sellers MUST populate only when the rejecting schema is a const-discriminated `oneOf` / `anyOf` AND the discriminator property is present in the payload — emission on partial-match inference would fingerprint the seller's validator (Ajv vs Python `jsonschema` vs `gojsonschema` diverge on tie-breaking).
  - Sellers MUST omit `discriminator` when zero variants survive validation; omission is the agent's signal that the validator could not localize a target variant.
  - The wire field reports the value the caller sent — not a validator inference — so it is deterministic across implementations.

  **Validator-internals production-emit stance.** The earlier prose on `schemaPath` (`SHOULD NOT emit on production-facing endpoints — leaks which oneOf branch the validator selected, a probe oracle for adversarial callers`) is incompatible with shipping `discriminator` and `schema_id`, both of which expose the same "validator's chosen variant" surface. The resolution: the public-spec rationale wins **with explicit carve-outs**, replacing the blanket SHOULD-NOT.

  The base rationale: schemas are published at adcontextprotocol.org and bundled with every SDK, so when the rejecting element is in the public spec, an adversary can replay the same validator locally against the same payload and derive branch selection from the payload alone — the wire field carries no information the adversary can't compute.

  The carve-outs (normatively documented in `error-handling.mdx`):

  - **Private extensions.** Sellers running schemas with custom `oneOf` branches, server-only sub-schemas, or enum subsets layered via `additionalProperties: true` MUST NOT emit `schema_id`, `schemaPath`, or `discriminator` when the rejecting element is not in the published spec. Replay-locally is structurally inapplicable.
  - **Version skew.** Sellers validating against a pre-release or post-release schema MUST NOT emit a `schema_id` whose `$id` is not in the published bundle for the version named in `get_adcp_capabilities`.
  - **Custom keywords.** `keyword` MUST be drawn from the JSON Schema Draft 7 / 2020-12 vocabulary; validator-specific custom keywords MUST NOT be emitted on the wire.
  - **Probe terseness.** Sellers MAY scope all three fields to dev/sandbox responses on rate-limited production endpoints to keep envelopes terse, even when the carve-outs above don't apply. Field omission is always conformant.

  Updates:

  - `static/schemas/source/core/error.json` — adds `schema_id` (string) and `discriminator` (array of `{property_name, value}`) properties under `issues.items.properties`; rewrites the `schemaPath` description to drop the SHOULD-NOT framing and point at the unified production-emit stance.
  - `docs/building/implementation/error-handling.mdx` — adds a `Validator-internals fields on issues` subsection covering field semantics, `schema_id` resolution path (HTTPS canonical / SDK-bundled / bundled-tree caveat / validator strict-mode requirement), discriminator semantics, and the four carve-outs.

  **Open question carried in the PR description, not blocked on this changeset**: should `discriminator` be an object map (`{type: "audience", value_type: "ids"}`) instead of an array of pairs? The array shape matches what `@adcp/sdk` already emits and what #3867 proposes; the object map is more ergonomic for compound-discriminator consumers (`if (d.type === "audience")` vs `.find(d => d.property_name === "type")`). Resolved as array for v3.1; revisit before v4.

- 4c12454: spec: expert-review follow-ups on the 3.1 WG-review batch (#4399 / #4399b / #4107 / #4227 / #4371 / #2911).

  Consolidated fixes from four-expert review (ad-tech-protocol-expert, adtech-product-expert, security-reviewer, docs-expert) of the 9-commit WG-review batch on this branch:

  **Staged enforcement on universal idempotency_key.** Product expert flagged that a hard "MUST reject reads without idempotency_key" cliff at the 3.1 cut breaks hand-rolled integrators built via curl / thin MCP clients / OpenAPI codegen that doesn't include the field uniformly. Switched to staged: **3.1.0** sellers MUST accept reads carrying `idempotency_key` and SHOULD reject reads that omit it (MAY accept the omission during the 3.1.x maintenance window); **3.2.0** sellers MUST reject. SDK-using integrators (`@adcp/client`, `adcp-py`) are unaffected since both already send uniformly.

  **Cache-at-rest encryption (security reviewer M2).** Universal `idempotency_key` from 3.1 means the cache holds account-scoped read responses (`get_products`, `list_accounts`, `list_creatives`, `get_signals`), not just write receipts. Added: sellers MUST encrypt the cache tier at rest with the same controls used for the underlying resource store, MUST NOT treat the cache as a transient retry-receipt store exempt from data-at-rest controls, and MUST scope reads by `(authenticated_agent, account_id)` at the storage layer (not just application layer).

  **Forward-compatible decoding bounded by retry budget (security reviewer M1).** A receiver that literal-reads the new "default `transient` for unknown codes" rule and writes a retry loop without `maxRetries` could be DOS'd by a hostile sender emitting `code=GO_FOREVER, recovery=transient`. Added: the `transient` default is bounded by §Retry Logic (`maxRetries` + jittered exponential backoff); receivers MUST NOT loop indefinitely. Cross-link added from §Idempotency Buyer obligations to Forward-compatible decoding (the asymmetric link gap docs reviewer flagged).

  **Stale `replayed.description` (flagged by both protocol and docs reviewers).** `core/protocol-envelope.json` still said "Only present on responses to mutating requests that carry idempotency_key" — contradicts both the universal-idempotency change and the replay-snapshot rule. Updated to: "MAY appear on responses to any request that resolved via the idempotency cache, including read tools".

  **A2A serialization framing (protocol reviewer).** Envelope `notes` array described `task.artifacts[0].parts[].DataPart` and `task.status.message.parts[].DataPart` as symmetric, but `a2a-response-extraction.mdx` treats artifacts as canonical and `status.message.parts[]` as the fallback container only for interim states. Tightened to match the canonical/fallback framing and pinned the A2A version (0.3.0+).

  **Cache-growth ceiling acknowledgment (protocol reviewer optional).** Rule 8's recommended 60/sec sustained ceiling was sized against a write-heavy launch pattern. Added a note that read traffic now contributes under universal idempotency and operators with read-heavy mixes SHOULD revisit the deployed ceiling at the 3.1 cut rather than accept silent `RATE_LIMITED` of legitimate reads. The numeric recommendations remain the right starting _shape_, not the right starting _magnitude_, when reads dominate.

  **Mint `MULTI_FINALIZE_UNSUPPORTED` (protocol reviewer optional).** Protocol reviewer flagged that `INVALID_REQUEST` for a seller-side capability gap on multi-finalize ($refine[]$ atomicity) blurs "I can't support this combination" with "your request is malformed." Added `MULTI_FINALIZE_UNSUPPORTED` as the preferred code (`recovery: correctable`); `INVALID_REQUEST` remains acceptable for sellers on pre-3.1 error catalogs.

  **3.1.0 release-notes — `Wire conformance` section + adopter-action table (docs reviewer).** The reach_window section was the only 3.1.0 entry; the spec changes from the WG-review batch were invisible to a 3.0→3.1 migrator reading release-notes. Added a new `### Wire conformance — idempotency & envelope tolerance` section covering all 8 spec changes plus an adopter-action table for the seven distinct integrator categories (SDK-using buyers, hand-rolled MCP clients, FastMCP/Pydantic/Zod sellers, sellers with synchronous-success state-tracking responses, agentic buyers reading `status` from mutations, sellers emitting unsigned webhooks or deprecated specialism claims, sellers emitting unknown error codes).

  **`get_adcp_capabilities.mdx` idempotency block (docs reviewer consistency).** Stale "for mutating requests" framing on the capability description updated to reference the staged universalization and link to security.mdx.

  **3.0→3.1 sender audit note (protocol reviewer optional).** `error.recovery` MUST-populate-from-3.1 rule is safe for buyers (they default to `transient` when absent) but sellers ratcheting `adcp_version` to 3.1 with un-audited error-emit code paths are non-conformant. Adopter-action table calls this out explicitly.

  Files:

  - `docs/building/by-layer/L1/security.mdx` — enforcement-curve paragraph, cache-at-rest paragraph, retry-bounded cross-link, rule-8 read-traffic acknowledgment
  - `docs/building/by-layer/L3/error-handling.mdx` — `transient`-default bounded-by-retry sentence, `MULTI_FINALIZE_UNSUPPORTED` table row
  - `docs/building/operating/transport-errors.mdx` — `MULTI_FINALIZE_UNSUPPORTED` recovery row
  - `docs/protocol/get_adcp_capabilities.mdx` — idempotency block updated for staged universalization
  - `docs/reference/release-notes.mdx` — new `### Wire conformance` section under 3.1.0 with adopter-action table
  - `docs/media-buy/product-discovery/refinement.mdx` — `MULTI_FINALIZE_UNSUPPORTED` referenced, error table row added
  - `docs/media-buy/task-reference/get_products.mdx` — `MULTI_FINALIZE_UNSUPPORTED` error table row
  - `static/schemas/source/core/protocol-envelope.json` — `replayed.description` rewritten, A2A serialization framing tightened
  - `static/schemas/source/enums/error-code.json` — `MULTI_FINALIZE_UNSUPPORTED` added to enum / enumDescriptions / enumMetadata (recovery: correctable)
  - `scripts/error-code-drift-dispositions.json` — `MULTI_FINALIZE_UNSUPPORTED` held-for-next-minor / 3.1
  - `static/schemas/source/media-buy/get-products-request.json` — multi-finalize description references the preferred code

  Refs the eight prior commits in this WG-review batch.

- 9633927: docs(spec-guidelines): enum-membership criterion + reconcile sync_catalogs phantom error codes (#3456)

  Records the **enum-membership criterion** as a durable spec-authoring guideline in `docs/spec-guidelines.md` (under Enum Design), generalizing the decision recorded on #3456: a value earns membership when it is **published**, **natively supported** (handled without bespoke per-value mapping), and has **shared demand** (relevant across >1 producer AND >1 consumer); a material dialect earns its own value only when the parent's consumer would mis-handle it. `feed_format` (#3456) is the worked example, with a note distinguishing this from platform-agnosticism (a `feed_format` value legitimately names a vendor's _published spec_).

  Reconciles four error codes documented in the `sync_catalogs` error table but absent from `enums/error-code.json` — `FEED_FETCH_FAILED`, `INVALID_FEED_FORMAT`, `ITEM_VALIDATION_FAILED`, `CATALOG_LIMIT_EXCEEDED` — adding them to the canonical enum with `enumDescriptions` + `enumMetadata` (all `recovery: correctable`) and `held-for-next-minor` (3.1) drift dispositions. The `INVALID_FEED_FORMAT` phantom flagged on #5271 turned out to be one of four siblings in the same table.

  Refs #3456 (resolution shipped in #5298; this is the durable docs formalization + the error-code reconciliation).

- 7129dbc: Add `tiktok_shop`, `pinterest_catalog`, and `openai_product_feed` to the `feed_format` enum, and reconcile `brand.json` to reference the canonical enum.

  All three are externally-documented, Google-Merchant-Center-derived product-feed dialects that real sellers (TikTok Shop, Pinterest, OpenAI/ChatGPT commerce) parse natively — so buyers declaring them no longer have to fall back to `custom` + `feed_field_mappings` to re-describe a standardized feed. Each carries material deltas a strict GMC parser would mis-handle (TikTok `sku_id`/`video_link`; Pinterest composite price/shipping + mandatory `google_product_category`; OpenAI `is_eligible_*` flags), which is the bar for a dialect to earn its own value under the #3456 enum-membership criterion.

  `feed_format` values are vendor spec names (proper nouns), not semantic categories — a feed format _is_ the vendor's published spec, so there is no vendor-neutral name (the deliberate inverse of the semantic `video_placement_types`/`social_placement_surfaces` axes). The enum now carries `enumDescriptions` documenting each format and citing its spec.

  `brand.json` previously inlined a drifted feed_format enum (it had `openai_product_feed` but was missing `shopify`/`linkedin_jobs`); it now `$ref`s `/schemas/enums/feed-format.json` (matching `core/catalog.json`), so the two surfaces can no longer diverge.

  `feed_format` is a seller-side parsing label only — AdCP ships no per-format mapping table and SDKs do not parse feeds, so first-class membership is a label + SDK enum-widening, not a parser obligation.

  Closes #5271. Implements the #3456 enum-membership criterion.

- 0276746: Add optional `filter_diagnostics` block to `get_products` response —
  non-fatal observability for the filter-not-fail empty-result UX gap.
  Closes #3482.

  **The gap.** Every `required_*` filter in `product-filters.json` is
  silent-exclude semantics (the established AdCP convention; matches
  OpenRTB / SSP capability discovery patterns). When the result list is
  empty or unexpectedly small, the buyer can't distinguish:

  - "No inventory matches the brief"
  - "`required_metrics` excluded everything"
  - "`required_geo_targeting` excluded everything"
  - "`budget_range` had no overlap with available products"

  Today the buyer must blindly relax filters one at a time to discover
  which one was unsatisfiable. Both pre-build expert reviewers (protocol
  and product) independently flagged this as the buyer-side observability
  gap on PR #3472 (`required_metrics`).

  **Shape.** Optional, additive, observability — not error reporting:

  ```json
  {
    "products": [],
    "filter_diagnostics": {
      "total_candidates": 47,
      "excluded_by": {
        "required_metrics": { "count": 31, "values": ["completed_views"] },
        "required_geo_targeting": { "count": 9 },
        "budget_range": { "count": 7 }
      }
    }
  }
  ```

  - `total_candidates`: integer baseline before filters applied. May be
    sampled or capped at large catalogs.
  - `excluded_by`: keyed by filter property name as it appears in the
    request's `filters` object. Each value carries `count` (required),
    optional `values` (the specific filter values that contributed to
    exclusions), and optional `notes` (human-readable narrative).

  **Counts only — never product names.** Listing excluded products would
  leak competitive intelligence about adjacent campaigns or seller
  inventory. Counts plus `values` (the filter inputs that did the
  excluding, not the products that got excluded) is enough for triage
  without that leakage.

  **Counting semantics intentionally loose.** Sellers vary on whether to
  count products excluded by ANY filter or ONLY by this filter. The spec
  documents the field as approximate — buyers SHOULD treat counts as
  triage signal, not exact accounting. Tightening this would force every
  seller to implement the same ordering of filter evaluations, which is
  an internal-architecture imposition AdCP shouldn't make.

  **Wired in.**

  - `media-buy/get-products-response.json`: new optional
    `filter_diagnostics` object with the shape above. `additionalProperties:
true` on each per-filter detail object so filter-specific extensions
    (e.g., per-metric breakdown) can land later without spec churn.
  - `docs/media-buy/task-reference/get_products.mdx`: new Response Metadata
    row + dedicated `filter_diagnostics` section with field table and
    example response.

  **Backwards compatibility.** Optional and additive. Sellers that don't
  populate the field, and buyers that don't consume it, see no change.

  **Sell-side adoption.** Zero cost for sellers who don't populate it.
  Sellers that already track per-filter exclusion counts internally
  surface them with a single new field on their response builder. Sellers
  without that instrumentation can adopt incrementally — the field's
  absence is conformant.

  Closes #3482.

- 19813bd: Align `get_creative_features` documentation with its already-Final lifecycle stage, and close a phantom error code.

  Per [specification-lifecycle](docs/reference/specification-lifecycle.mdx) (a surface with no `x-status` marker that has shipped in a GA release is at the **Final** stage), `get_creative_features` is already Final: none of its schemas (`get-creative-features-request.json`, `get-creative-features-response.json`, `creative-feature-result.json`) carry `x-status: experimental`, it shipped in 3.0 GA, and it is absent from the canonical `experimental_features` list in [experimental-status](docs/reference/experimental-status.mdx). It is listed as a **Required** creative-governance task in `docs/protocol/required-tasks.mdx`, and its capability is advertised via `get_adcp_capabilities.creative_features[]`. The task carried a stale "AdCP 3.0 Proposal — under development" prose banner that contradicted that Final state. This is not a Proposed→Final transition — the lifecycle stage is unchanged — so no decision record is required; it removes a contradictory documentation artifact.

  **Changes**

  - Removed the proposal `<Info>` banner from `docs/governance/creative/get_creative_features.mdx` and the creative-governance section landing page `docs/governance/creative/index.mdx`. The section's only banner-marked page was `get_creative_features`; `provenance-verification` carries no proposal banner.
  - Added `CREATIVE_INACCESSIBLE` to the canonical error-code enum (with `enumDescriptions` and `enumMetadata`, recovery `correctable`). The `get_creative_features` error example documented this code but it was absent from the enum — a documented task surface must not emit a phantom code (#3456 enum-membership criterion). It fires when a creative governance agent cannot retrieve the submitted `creative_manifest` assets at all — distinct from `CREATIVE_NOT_FOUND` (a `creative_id` absent from the agent's library), `CREATIVE_REJECTED` (assets retrieved but failed policy), and `GOVERNANCE_UNAVAILABLE` (agent unreachable; transient).

  No schema field changes; no behavior change to the task. The `creative/specification.mdx` (v1 creative model) and `media-buy/specification.mdx` proposal banners are unrelated surfaces and unchanged. The frozen `dist/docs/<version>/` release snapshots still carry the banner by design — they refresh at the next snapshot cut, not on content PRs.

  This unblocks the 3.1 creative-feature-oracle gate/rank pipeline (#5311 / #5305), which uses `get_creative_features` as the gate's feature source.

  Refs #5311, #5305, #3456.

- 377ef99: Add optional `currency` and `total_budget` fields to `CreateMediaBuySuccess` and `UpdateMediaBuySuccess` response schemas to match the entity shape already required by `get_media_buys`. Sellers using a shared mapper across create/list will now have these fields declared in the create and update schemas, eliminating silent Zod validation failures on `get_media_buys` poll steps.
- 1154e9d: feat(schema): add `Submitted` arm to per-tool response `oneOf` for `update_media_buy`, `build_creative`, and `sync_catalogs` (#3392)

  AdCP 3.0 shipped `*-async-response-submitted.json` schemas for 6 HITL tools but only 2 of 6 per-tool `xxx-response.json` schemas included the `Submitted` arm in their top-level `oneOf`. This left SDK codegen unable to generate typed `*Task` HITL methods for the 4 missing tools.

  This changeset fixes 3 of the 4 gaps (the `get_products` case is flagged for human review — see #3392):

  - `update-media-buy-response.json` — adds `UpdateMediaBuySubmitted` arm (`status: "submitted"` + `task_id`); updates `UpdateMediaBuyError.not` to exclude the submitted state
  - `build-creative-response.json` — adds `BuildCreativeSubmitted` arm; updates `BuildCreativeError.not` to exclude the submitted state
  - `sync-catalogs-response.json` — adds `SyncCatalogsSubmitted` arm; updates `SyncCatalogsError.not` to exclude the submitted state

  Non-breaking: existing `Success | Error` consumers are unaffected. Buyers gain a new permitted response shape and SDK codegen can produce typed HITL methods for these three tools.

  Note: the fix uses the same inline arm pattern as `create-media-buy-response.json` and `sync-creatives-response.json` — not `$ref` to the `*-async-response-submitted.json` schemas (those are task-completion artifact payloads for the webhook path, not the initial-response discriminated arm).

  Closes partial scope of #3392.

- af1d287: spec(creative): generative-encoding safe additions — `free_text` params + per-output transformer pricing.

  The additive half of the generative-agent (Veo/Imagen) encodings follow-on. The two _normative_ rules it pairs with — generation count is owned by `max_variants`/`max_creatives` (never a config param), and `aspect_ratio` rides the format axis — are intentionally left to the working group; only the safe schema bits land here.

  - `transformer-param.json` `value_source` gains **`free_text`** (an open buyer-authored string with no closed set — e.g. a `negative_prompt` or style note; `type` MUST be `string`, the closed-set fields MUST be absent) plus an optional **`max_length`**. The description also states that count/quantity knobs MUST NOT be params (count rides `max_variants`/`max_creatives`).
  - `vendor-pricing-option.json` gains optional **`applies_to_output_format_ids`** so one creative transformer can price different outputs differently (e.g. a multi-publisher template charging per publisher format); an unscoped option is the default. Additive and inert for non-creative vendors (signals/governance) — **flagged for shared-schema owner ack**.

- 271f669: Add `filters.pricing_currencies` to `get_products` so buyers can restrict discovery to media products priced in currencies they can transact in.

  The filter matches products with at least one product-level `pricing_options` entry in a requested ISO 4217 currency, requires mandatory product-scoped signal charges to be satisfiable in those currencies or have no incremental price, and requires sellers to prune returned product-level `pricing_options` to matching currencies.

- 7b2de61: Single governance agent per account — reconcile 3.x governance schemas with a coherent semantic model (closes #3010).

  **The inconsistency.** 3.x registration (`sync_governance`) allowed up to 10 governance agents per account with per-agent `categories`, and the campaign-governance spec documented fan-out-and-unanimous-approval. But the protocol envelope and `check_governance` carried a single `governance_context` string, and the four-value `scope` enum on brand.json (`spend_authority | delivery_monitor | brand_safety | regulatory_compliance`) didn't carve the governance responsibility at its joints — those aren't independent specialisms held by different authorities, they're phases and facets of one evaluation over one plan.

  **Decision.** Commit to single-agent: an account binds to one governance agent that owns the full lifecycle. Multi-agent registration was aspirational and produced schema inconsistencies without a coherent semantic story. A plan is unitary (budget, policies, restricted attributes all live on the plan); `check_governance` already separates authorization / fidelity / drift on the `phase` axis (`purchase` / `modification` / `delivery`); internal specialist review (legal, brand safety, category) belongs inside the configured agent, not at the registration layer.

  **Changes.**

  - `account/sync-governance-request`: `governance_agents` constrained to `maxItems: 1`. `categories` field removed. Description makes the one-agent-per-account invariant explicit and explains why (phases, not specialisms; plan is unitary; specialist review composes inside the agent).
  - `core/protocol-envelope`: `governance_context` stays a singular string. Description updated to state the single-agent invariant and why phased lifecycle (not split authority) means one token covers the full governed action.
  - `brand.json`: remove the governance-agent `scope` enum (`spend_authority | delivery_monitor | brand_safety | regulatory_compliance`) — no longer meaningful under single-agent registration. P&G example updated to drop the stray `scope` array.
  - `docs/governance/campaign/specification.mdx`: replace "Multi-agent composition" with "One governance agent per account" explaining the rationale (authorization/fidelity/drift are phases, regulatory rules are encoded in the plan, specialist review composes inside the agent, one lifecycle/one token/one audit trail). Fix the remaining `governance_agent(s)` plural residue.
  - `governance/check-governance-request` / `response` / `report-plan-outcome-request`: revert any language implying per-agent fan-out; all three are single-agent calls as originally designed.
  - `docs/governance/campaign/tasks/check_governance.mdx`, `report_plan_outcome.mdx`: revert to the single-agent prose.

  **Backwards compatibility.** Buyers with one agent registered (practically every 3.0 deployment per maintainer's reading of the ecosystem) are unaffected. Buyers that registered more than one agent per account against the previous `maxItems: 10` — if any exist — MUST collapse to a single agent; the protocol does not support routing or aggregating across multiple. Sellers that validated the `categories` field MUST treat registrations without it as valid (the field is removed, not deprecated).

  **What this is not.** This PR does not address specialist governance surfaces adjacent to campaign governance — brand-safety pre-screen of creatives, property-list policy, content-standards evaluation — those are separate governance domains with their own agents and their own lifecycle. Campaign governance speaks only for the plan.

- 2578146: spec(idempotency): declare `capabilities.idempotency.in_flight_max_seconds` so buyers can compute retry budgets

  Closes #4406. Follow-up to #4402 (rules 9 + 10 + IDEMPOTENCY_IN_FLIGHT).

  Rule 9 requires sellers to bound the lifetime of an in-flight idempotency row to their declared per-task handler timeout. That bound exists in every conformant seller's deployment but is not buyer-observable — `capabilities.idempotency` currently declares `replay_ttl_seconds` (1h–7d) only, which is far wider than a realistic handler timeout. A buyer that retries on `IDEMPOTENCY_IN_FLIGHT` must either pick an arbitrary retry budget or be told to wait up to the full `replay_ttl_seconds` ceiling.

  This change adds an optional `in_flight_max_seconds` field to the `IdempotencySupported` branch of `adcp.idempotency`:

  - **Optional in 3.1.** SDKs that don't see the field fall back to rule 9's order-of-magnitude SHOULD heuristic. Additive change; no existing seller is non-compliant for omitting it.
  - **Required when `supported: true` in 4.0** — same migration path `replay_ttl_seconds` followed across the 2.x → 3.x boundary. Buyers get a guaranteed bound at the next major.
  - **Bounded** `integer ≥ 1, ≤ 604800` at the schema layer; cross-field bound `≤ replay_ttl_seconds` is enforced by the composed-schema validation suite (JSON Schema cannot express field-relative bounds).
  - **Forbidden on the `IdempotencyUnsupported` branch.** No replay window means no in-flight bound — mirrors the existing `replay_ttl_seconds` treatment.

  Buyer SDKs use the declared value to:

  - Cap individual retry waits on `IDEMPOTENCY_IN_FLIGHT` at this value rather than the much-wider `replay_ttl_seconds` ceiling.
  - Surface meaningful "your retry will succeed or fail within N seconds" hints to operators.
  - Treat any `error.details.retry_after` exceeding this value as a seller bug — the in-flight row cannot legitimately outlive the declared bound.

  Rule 9 in `security.mdx` is updated to point at the new capability field as the primary retry-budget bound when declared; the order-of-magnitude heuristic remains the fallback for sellers that haven't yet adopted the field.

- 231bc2e: spec(idempotency): add normative rules for concurrent retries and downstream reconciliation; introduce `IDEMPOTENCY_IN_FLIGHT`

  Two new normative rules in `L1/security.mdx#idempotency`:

  **Rule 9 — Concurrent retries / first-insert-wins.** A second request carrying the same `(authenticated_agent, account_id, idempotency_key)` MAY arrive while the first is still executing. Sellers MUST resolve the race deterministically (`INSERT … ON CONFLICT DO NOTHING` on the scope tuple) and MAY pick one of two policies, behaving consistently: **wait-and-replay** (block the second request until the first completes, return cached response with `replayed: true`), or **reject-and-redirect** (return new `IDEMPOTENCY_IN_FLIGHT` code with `error.details.retry_after`). Same key with a _different_ canonical payload during the in-flight window still returns `IDEMPOTENCY_CONFLICT` (rule 5). Verified against the canonical Python sales-agent (Wonderstruck) — its wait-and-replay implementation passes the new rule out of the box.

  **Rule 10 — Crossing service boundaries / downstream reconciliation.** When a seller invokes a downstream system (SSP, ad server, payment provider) during request handling, "errors don't cache" (rule 3) is necessary but not sufficient — a crash between downstream-accepts and local-persist leaves the seller in a "downstream unknown" state. Sellers MUST adopt one of two patterns for every downstream call whose duplicate-invocation has business consequences: **write-claim-before-invoke** (persist a claim row with `downstream_request_id` before invoking; reconcile on retry by querying the downstream by that id) or **thread-buyer-key** (pass the buyer's `idempotency_key` or a deterministic seller-side derivative as the downstream's own idempotency key). The pattern "best-effort dedup on downstream response inspection" is explicitly forbidden.

  **New error code: `IDEMPOTENCY_IN_FLIGHT`** (held for 3.1 per the wire-stability policy). Recovery: transient. Buyers MUST retry with the **same** `idempotency_key` after `error.details.retry_after` — minting a fresh key on this code turns a safe retry into a double-execution race.

  **Transitional note on `SERVICE_UNAVAILABLE + retry_after`.** Both reference implementations today (the Python sales-agent at `wonderstruck.sales-agent.scope3.com` and the `@adcp/sdk` middleware) implement wait-and-replay (rule 9's other policy) and never need to emit `IDEMPOTENCY_IN_FLIGHT`. SDKs that previously emitted `SERVICE_UNAVAILABLE + retry_after: 1` on the in-flight branch are NOT out of compliance with rule 9 as long as they adopt wait-and-replay end-to-end — `IDEMPOTENCY_IN_FLIGHT` is only required when a seller picks reject-and-redirect. The `@adcp/sdk` middleware swap from `SERVICE_UNAVAILABLE` to `IDEMPOTENCY_IN_FLIGHT` is tracked separately (adcp-client follow-up); it's a wire-code tightening, not a behavioral change.

  **Storyboard coverage.** `static/compliance/source/universal/idempotency.yaml` gains a `concurrent_retry` phase using two new cross-response check kinds (`cross_response_count_distinct`, `cross_response_field_equal`) that operate on the resolved response set across N parallel dispatches. The runner contract is documented in the new `test-kits/parallel-dispatch-runner.yaml`; runners without parallel-dispatch support skip the phase with a stable not_applicable marker. SDK/runner implementation tracked separately (adcp-client follow-up).

  Author skill (`skills/call-adcp-agent/SKILL.md`) and the buyer-facing `docs/protocol/calling-an-agent.mdx` updated so buyers know to wait-and-retry on `IDEMPOTENCY_IN_FLIGHT` rather than mint a fresh key.

- 5015802: Add `IMPRESSION_ID` universal macro for impression-level deduplication

  A general-purpose per-impression identifier macro that buyers, measurement vendors, verification services, and TMP can use for per-impression dedup, cross-vendor reconciliation, pixel-retry detection, and (in TMP) cross-identity exposure dedup. Closes the gap where TMP context-only impressions had no impression_id available (no `{TMPX}` → no buyer-side decode-time mint).

  Format is implementation choice — UUID, ULID, snowflake, or any collision-resistant scheme. Three-layer minting hierarchy: (1) publisher first-party code, (2) ad-decision layer (Prebid TMP module, ad server, SSP), (3) buyer impression tracker at `{TMPX}` decode (TMP-specific fallback). Each lower layer MUST defer to whatever an upstream layer already minted.

  Documents the Prebid TMP module pattern using the `tmp_impression_id` GAM targeting key and the optional reuse of `adUnit.transactionId` when Prebid's `enableTIDs` config is on. No router changes; preserves TMP's identity↔context structural separation by keeping minting at the publisher/decision-layer join.

- 1a2b9e3: Add non-colliding AdCP task-lifecycle aliases in the protocol namespace:
  `get_task_status` and `list_tasks`.

  These are aliases for AdCP's application-layer lifecycle tools, not aliases for
  transport-native MCP/A2A `tasks/*` APIs. The existing `core/tasks-get-*` and
  `core/tasks-list-*` schemas remain valid through 3.x for compatibility; the
  new aliases avoid transport-name collisions without changing AdCP async task
  polling or reconciliation semantics.

- f44fba3: Three small cleanups from the measurement schema audit (closes audit findings §3.8 and §3.10; finishes the prose-side work for #3863).

  **§3.8 — `attribution-window` dedup.** `optimization-goal.json` previously inlined a partial `attribution_window` shape with `post_click` and `post_view` but no `model`, with `post_click` required. The canonical `core/attribution-window.json` has `post_click`, `post_view`, and `model` with `model` required. Two surfaces describing the same concept with conflicting constraints. Fix:

  - `optimization-goal.json` `attribution_window` collapses to `$ref attribution-window.json` so there's one canonical shape.
  - `attribution-window.json` `model` becomes optional (was required). Absence means the seller's default attribution model applies (typically `last_touch` per industry convention). Sellers SHOULD populate `model` when committing to a specific methodology. Buyers reading delivery reports get the seller's choice when set; fall back to default when not.

  **§3.10 — `dooh_metrics.calculation_notes` description tightening.** Previously a one-liner ("Explanation of how DOOH impressions were calculated") that read like a primary methodology surface. Tightened to clarify it's for **row-specific supplementary context** (a particular daypart's calculation, a venue-mix exception) — the canonical methodology declaration belongs on the measurement vendor's `get_adcp_capabilities.measurement.metrics[]` block where it's discoverable once and inherited across delivery rows. Doesn't deprecate the field — DOOH methodology genuinely has row-level exceptions worth carrying inline.

  **#3863 — `forecastable-metric.json` description drift fix.** The description previously claimed `audience_size`, `measured_impressions`, `grps`, `reach`, `frequency` were forecast-only deltas. **Wrong:** `grps`, `reach`, `frequency` are also in `available-metric.json` (have been since their introduction). The actual forecast-only deltas are `audience_size` and `measured_impressions`. Description corrected. Closes the prose-cross-reference half of #3863; the schema-level enforcement of overlap (build-script work, not schema work) is deferred.

  **Backwards compatibility.** All three changes are additive or relax existing constraints (the `attribution-window.model` requirement relaxation makes previously-failing payloads valid; previously-valid payloads remain valid). No breaking changes.

  Closes audit findings §3.8 and §3.10. Substantially closes #3863 (prose cross-references); build-script overlap enforcement deferred to a follow-up.

- 12bfb06: Add `measurement` capability block to `get_adcp_capabilities`. Closes
  #3612 (the protocol surface piece of the per-metric catalog discovery
  design from #3586). Unblocks #3613 (AAO crawler + index
  implementation).

  **Adds `measurement` to `supported_protocols` and `enums/adcp-protocol.json`.**
  Measurement is a protocol-in-development. The capability block ships
  now so measurement vendors can publish their catalogs and AAO can
  crawl them; additional measurement tasks (reporting, attribution,
  panel queries) and a baseline compliance storyboard land in
  subsequent minors. Same as every other protocol — `creative` is in
  `supported_protocols` AND has a capability block; same for
  `governance`. Measurement follows the same model.

  **Self-describing, parallels other agents.** Every AdCP agent type
  publishes capabilities at the agent itself (sales / creative /
  governance / brand / buying / signals / rights). Measurement now
  follows the same pattern with a new `measurement` block whose
  `metrics[]` array carries the per-metric catalog. The shape mirrors
  `governance.property_features[]` (typed feature objects in an array)
  including the `methodology_url` and `methodology_version` fields.

  **Scope.** An agent claiming `measurement` computes one or more
  quantitative metrics about ad delivery, exposure, or effect
  (impression verification, viewability, IVT, attention, brand lift,
  incrementality, outcomes, emissions — vendors define the surface in
  `metrics[]`). Returns metric definitions (this block), not pricing
  or coverage (negotiated per buy via `measurement_terms`) and not
  live values (returned per buy via `vendor_metric_values`). Same
  mechanical model as `compliance_testing` and `webhook_signing`.

  **No closed category enum.** An earlier draft included a closed 12-value
  `measurement-category.json` enum and a required `category` field on
  each metric. WG review pushed back on two grounds: (1) categories
  overlap (e.g., `brand_safety` measurement vs. governance's
  `content_standards`), making the boundary fuzzy; (2) without a
  buyer-side discovery primitive consuming the field, the enum was
  adding schema surface and drift risk without earning its keep.
  Dropped: `category` field, `measurement-category.json` enum file,
  `metric_categories[]` on brand.json (already removed in this PR's
  prior commit). AAO and buyer agents normalize across catalogs from
  `metric_id`, `description`, `standard_reference`, and
  `accreditations[]` — all already structured. If a category facet
  proves useful once #3613's discovery primitive lands, it can be
  added back as an open vendor-asserted string with real query
  patterns shaping the taxonomy.

  **Schema additions.**

  - `protocol/get-adcp-capabilities-response.json`: new `measurement`
    block with `metrics[]`. Each metric carries `metric_id` (required),
    plus optional `standard_reference`, `accreditations[]` (third-party
    certification list, distinct from `standard_reference` — accrediting
    body, optional cert ID, validity date, evidence URL), `unit`,
    `description`, `methodology_url`, and `methodology_version`.
    `additionalProperties: false` with explicit `ext` slot, matching
    the governance pattern. `uniqueItems: true` on `metrics[]` — duplicate
    `metric_id` within one agent's catalog is a conformance bug.

  **Why `accreditations[]` is separate from `standard_reference`.**
  A metric can implement a published standard (URL points at the spec)
  without holding independent third-party accreditation. Buyers asking
  "is this MRC-accredited?" need a structured answer that survives URL
  parsing — every vendor pasting the same MRC URL whether accredited
  or not gives a false signal of comparability. The split surfaces
  the distinction at the schema layer.

  **Doc updates.**

  - `docs/protocol/get_adcp_capabilities.mdx`: new `measurement` section
    with field table, response example showing `accreditations[]` and
    `methodology_version`, the discovery-vs-settlement framing, an
    explicit Scope subsection ("what does claiming `measurement` mean?"),
    and an explicit "this is a discovery surface, not a rate card" callout
    (pricing/SLAs/coverage are negotiated per buy via
    `measurement_terms`).
  - `docs/registry/index.mdx`: refines the measurement-vendor discovery
    section to reference the now-defined `measurement` capability block
    and forward-references the AAO index endpoint (#3613) and the
    buyer-agent direct-call docs (#3614).
  - `core/reporting-capabilities.json`: updated `vendor_metrics[]` prose
    to point at `get_adcp_capabilities.measurement.metrics[]` as the
    canonical metric-definition source (was previously brand.json).

  **Backwards compatibility.** All additions are optional and additive.
  Sellers without measurement capability are unchanged; sellers with
  measurement capability gain a structured catalog surface.

  **WG review.** This is the protocol surface for measurement-vendor
  capability declaration. Three independent expert reviews plus WG
  pushback shaped this version: kept `measurement` in
  `supported_protocols` per the protocol-in-development framing, added
  `methodology_version`, added structured `accreditations[]` to separate
  "implements a standard" from "third-party certified," dropped the
  brand.json coarse-filter field, and dropped the closed category enum
  in favor of letting real catalogs shape the taxonomy.

  Closes #3612.

- f6f90d8: Add optional `vendor: BrandRef` to two vendor-attested rows that lacked structured vendor identity, bringing them into the same identity discipline as `vendor_metric_values`, `performance-standard.vendor`, and `committed_metrics` (vendor-scope entries).

  **`core/delivery-metrics.json` `viewability`** (closes #3862). Optional but RECOMMENDED — makes the viewability row self-describing so buyer agents reading delivery in isolation can attribute the numbers to a measurement vendor without joining back to `package.committed_metrics` or `package.performance_standards`. Same shape as `vendor_metric_value.vendor` for symmetry.

  **`core/performance-feedback.json`** (closes #3859). SHOULD be populated when `feedback_source` is `third_party_measurement` or `verification_partner` AND a single attesting vendor exists. OMITTED for blended outputs (MMM mixes from Nielsen MMM / Analytic Partners / in-house models, multi-touch attribution that joins across vendors, clean-room outputs from LiveRamp / Habu / AWS Clean Rooms where the clean room is not itself the measurement source) — exactly the high-value third-party signals that don't have a single attesting vendor. Optional for `buyer_attribution` and `platform_analytics` (those sources are implicit from context). Described in the field; not enforced via JSON Schema `if/then`, matching the precedent set by `performance-standard.standard`. Without the BrandRef on single-vendor feedback, the row is unattributed — consumers can't verify authorization, resolve metric definitions via the vendor's `get_adcp_capabilities.measurement.metrics[]`, or route disputes.

  Both fields are additive and backwards-compatible. Origin: schema audit run during PR #3843, findings §3.4 and §3.9. Aligns with the [measurement taxonomy](https://docs.adcontextprotocol.org/docs/measurement/taxonomy) doctrinal framing that vendor-attested measurement is anchored on `BrandRef → brand.json agents[type='measurement']` discoverable identities.

  Doc updates: `docs/media-buy/task-reference/provide_performance_feedback.mdx` (vendor field row, example payload), `docs/media-buy/media-buys/optimization-reporting.mdx` (viewability field list).

- c2e3edf: Add a per-agent REST surface at `/api/me/agents` so members can register, list, update, and remove individual agents from CI or scripts via WorkOS API key (Bearer `sk_…`) — no full-profile round-trip and no Addie/UI dependency. Reuses the same visibility gate and server-side type resolution as `PUT /api/me/member-profile`; type-resolution flips (the smuggle-protection events) are audit-logged. Writes serialize through `SELECT … FOR UPDATE` on `member_profiles` so concurrent register/update/delete calls cannot race the JSONB read-modify-write. Multi-org callers may pass `?org=…` to target a non-primary org; verification goes through `resolveUserOrgMembership`. `DELETE /api/me/agents/{url}` returns `409 unpublish_first` when the agent is currently `public` so the registry catalog and the published `brand.json` cannot silently disagree. `PATCH /api/me/agents/{url}` with a body `url` that disagrees with the path returns `400 url_immutable` rather than dropping the rename silently.
- 0b2cf2b: Add `metric_aggregates` partition to `aggregated_totals` on `get_media_buy_delivery` — qualifier-aware delivery rollups symmetric to `committed_metrics`. Closes #3848. Supersedes #3631 and #3833 (both already closed).

  **The atomic unit is now identical across contract, diff, and delivery.** Each surface carries `(scope, metric_id, qualifier, …)` rows; reconciliation collapses to a row-level join on the tuple. `committed_metrics` adds `committed_at`; `missing_metrics` strips it; `metric_aggregates` swaps it for `value` plus per-metric component fields.

  **Provides the structural primitive for solving apples-to-oranges sums.** MRC and GroupM viewability define materially different thresholds and must never be combined into a single cross-buy rate. The partition shape (one row per `(metric_id, full-qualifier-set)`) makes the partition expressible; future qualifier-aware metrics (`completion_rate` × completion threshold; attention scoring × methodology if it standardizes) plug into the same shape with no schema break. Note: this PR ships the _structure_ — sellers actually emitting partitioned rows requires a forcing function from the contract surface (buyers committing to specific qualifiers via `committed_metrics`) plus seller adoption. Expect adoption to lag the structure until a real contract demand exists.

  **Schema additions.**

  - `media-buy/get-media-buy-delivery-response.json` `aggregated_totals.metric_aggregates`: array of discriminated rows. Two oneOf branches (`scope: standard` / `scope: vendor`), `additionalProperties: false` on both (matching `committed_metrics` symmetry), reusing the qualifier shape from `core/package.json` `committed_metrics` and the BrandRef pattern from `core/vendor-metric-value.json`. Per-metric component fields (`measurable_impressions`, `viewable_impressions`, `impressions`, `completed_views`, `spend`, `conversions`, `conversion_value`, `clicks`) inlined as siblings of `value` rather than nested in a `components` sub-object — flatter, matches the per-buy `viewability` block's existing flat shape. Per-metric required components enforced via `if/then` for the four highest-traffic metrics (`viewable_rate`, `completion_rate`, `cost_per_acquisition`, `roas`); other metrics rely on prose-described components today (full `oneOf` discriminated on `metric_id` would be 31+ branches; deferred to a future minor if conformance testing demands).
  - `core/package.json` `committed_metrics` description updated to cross-link `aggregated_totals.metric_aggregates` and articulate the row-symmetric model across contract / diff / delivery.

  **Granularity rule.** One row per `(metric_id, full-qualifier-set)`, reported at the finest available granularity. Buyers re-aggregate up if they want a coarser view. Eliminates rollup ambiguity and prevents accidental double-counting.

  **Closed today, expected to diverge.** `committed_metrics.qualifier` and `metric_aggregates.qualifier` are both `additionalProperties: false` today with identical content (`viewability_standard` only). The delivery vocabulary is **expected to diverge from contract** in future minors as transparency disclosures buyers don't commit to ship delivery-only (e.g., `tracker_firing` pending #3832). New keys ship explicitly in subsequent minors on either surface.

  **Unqualified metrics stay top-level; mutual exclusion MUST.** `impressions`, `spend`, `media_buy_count`, etc. remain at the top of `aggregated_totals`. `metric_aggregates` is only used for metrics with non-empty qualifier sets. **For any `metric_id` appearing in `metric_aggregates`, the corresponding top-level scalar in `aggregated_totals` MUST be omitted (not zeroed)** — sellers MUST NOT emit both. Avoids duplicate sources of truth.

  **Qualifier-set drift across reports.** When a campaign gains a new qualifier mid-flight (e.g., adds `tracker_firing` partitioning in week 2 after only client-side firing in week 1), prior periods' rows remain valid at their original granularity. Buyers SHOULD NOT retroactively repartition.

  **Per-buy shape stays flat.** Each individual buy is single-qualifier by definition; only the cross-buy aggregate spans qualifiers. Per-buy `totals.viewability` continues to be a flat object with its own `standard` field.

  **Value typing.** Heterogeneous by `metric_id` (rate vs count vs ratio). Buyer agents MUST inspect `metric_id` before doing arithmetic — same dispatch convention as `committed_metrics`. Documented in the description and in `docs/media-buy/task-reference/get_media_buy_delivery.mdx`.

  **Backwards compatibility.** Additive. The field is optional in v1 (`additionalProperties: true` on `aggregated_totals` already permitted ad-hoc partition fields like the original Vox `viewability` insertion); existing clients are unchanged.

  Doc updates: `docs/media-buy/task-reference/get_media_buy_delivery.mdx` adds an "Aggregated metric partitions" section documenting the reconciliation join, granularity rule, qualifier-vocabulary asymmetry, per-buy / aggregate divergence, and value-typing dispatch.

  Closes #3848.

- 53e7920: Reconcile the metric vocabulary across the protocol. Closes #3858 (deprecate `metric-type` enum on `performance-feedback`); substantially addresses #3863 (four-parallel-enums cleanup) — full sub-enum restructuring deferred to a follow-up minor.

  **Problem.** Four parallel metric enums grew independently with overlapping but inconsistent vocabularies:

  - `available-metric.json` (30 values) — closed delivery enum used by `committed_metrics`, `required_metrics`, `reporting_capabilities.available_metrics`
  - `forecastable-metric.json` (15 values) — forecast-time enum, mostly mirrors `available-metric` plus deltas (`audience_size`, `measured_impressions`, `grps`, `reach`, `frequency`)
  - `performance-standard-metric.json` (5 values) — verification subset (`viewability`, `ivt`, `completion_rate`, `brand_safety`, `attention_score`)
  - `metric-type.json` (8 values) — legacy `performance-feedback` enum mixing metrics, verification, and attribution into one list (`overall_performance`, `conversion_rate`, `brand_lift`, `click_through_rate`, `completion_rate`, `viewability`, `brand_safety`, `cost_efficiency`)

  **Changes.**

  ### `performance-feedback.json` (#3858)

  - Adds `metric: { scope, metric_id, qualifier? }` field — the discriminated row shape symmetric with `committed_metrics` and `metric_aggregates`. Preferred over the legacy `metric_type` field for new implementations.
  - Marks `metric_type` as **deprecated** in description and **drops it from `required`** at the schema level — the previous "still required while deprecated" pattern was internally inconsistent. Existing implementations populating `metric_type` continue to work; new implementations populate `metric` instead. Removed at the next major when `metric` becomes the canonical dispatch path.
  - When both `metric` and `metric_type` are present, consumers MUST use `metric` for dispatch.
  - **`metric` is also optional** — for holistic feedback (a trader flagging a campaign as underperforming without a specific metric), senders can omit `metric` entirely; `performance_index` plus the response narrative carry the signal. This preserves the workflow that legacy `metric_type: "overall_performance"` and `cost_efficiency` served.
  - Standard-scope `metric` entries support `qualifier.viewability_standard` (MRC vs GroupM) and `qualifier.completion_source` (seller vs vendor attested). Vendor-scope entries carry the BrandRef pattern.
  - For `brand_safety` migration: buyers who don't know the vendor's specific `metric_id` MAY populate the top-level `vendor` field and OMIT `metric` — the row stays attributable via `feedback_source` + `vendor` without forcing buyers to learn vendor-specific metric vocabularies.

  ### `metric-type.json` (#3858)

  - Marked deprecated in title and description.
  - Description carries a migration table mapping each legacy value to its replacement on the new `metric` field. Meta-bucket values (`overall_performance`, `cost_efficiency`) migrate to **omitting `metric` entirely** — the previously-meaningless meta-buckets are now expressible as "no specific metric" rather than "a meta-string with no defined dispatch semantics." `conversion_rate` has no clean direct target (the protocol distinguishes ratio from count); migration suggests either feeding back `conversions` or a vendor-scope MMM/MTA conversion-rate variant. `brand_safety` migration accommodates buyers who don't know vendor-specific metric IDs (top-level `vendor` field carries source identity even when `metric` is omitted).

  ### `forecastable-metric.json` (#3863, partial)

  - Description clarifies which values mirror `available-metric.json` (the canonical delivery vocabulary) and which are forecast-only deltas. Forecast-only values graduate into `available-metric.json` if and when the industry converges on adding them to delivery reporting.
  - No schema shape change in this minor; the cross-reference is documented in prose.

  ### `performance-standard-metric.json` (#3863, partial)

  - Description clarifies the verification-subset role and the relationship to `available-metric.json` (shared values mirror; verification-only values like `ivt`, `brand_safety`, `attention_score` flow through `vendor_metric_values` or vendor-scope `committed_metrics` entries).
  - No schema shape change.

  ### `provide_performance_feedback.mdx`

  - Request parameters table updated with the new `metric` field row and the `metric_type` deprecation marker.
  - Disambiguates the top-level `vendor` field (source of the feedback) from the nested `metric.vendor` field (vendor that defines the metric). Often the same; can differ.

  **Migration.**

  Implementations using `performance-feedback.metric_type` continue to work unchanged for one minor. New implementations SHOULD populate both fields during the transition window: `metric_type` for backwards-compat with consumers reading the legacy field, `metric` as the preferred dispatch surface. At the next major (4.0), `metric_type` is removed and `metric` becomes required.

  **Backwards compatibility.** Additive (new field on performance-feedback). Existing consumers that ignore the new field continue to work. Deprecated `metric_type` is still required at the schema level for one minor.

  **What's deferred** (#3863 follow-up). Forecast-only sub-enum extraction (split `forecastable-metric` into `delivery-metrics-shared` + `forecast-only`) and `performance-standard-metric` cross-reference enforcement at the schema level. Both are mechanical follow-ups; the prose description updates ship the conceptual reconciliation now and unblock the deprecation path on `metric-type`.

  Closes #3858. Substantially addresses #3863.

- 4f08ba1: Add five missing scalar metrics that production reporting carries today
  but had no enum entry: `cost_per_completed_view`, `cpm`, `downloads`,
  `units_sold`, `new_to_brand_units`. Closes the missing-scalars sub-item
  of #3460.

  **The scalars and where they fit.**

  - `cost_per_completed_view` — CTV CPCV pricing scalar. Parallels existing
    `cost_per_click` and `cost_per_acquisition`; the package's
    `pricing_model` is `cpcv` when this field is the billing basis.
  - `cpm` — Cost per thousand impressions. Universal pricing scalar across
    CTV, display, mobile/web video, native, audio, and DOOH inventory.
    Conspicuous absence next to `cost_per_click` before this PR; the
    package's `pricing_model` is `cpm` when this field is the billing
    basis. Field name aligns with the canonical `cpm` token in
    `pricing-model.json` and `pricing-options/cpm-option.json` so buyers
    cross-walk pricing model → reported scalar without a translation.
  - `downloads` — IAB-standard scalar for audio/podcast inventory (IAB
    Podcast Measurement Technical Guidelines 2.x methodology). Distinct
    from `views`.
  - `units_sold` — Retail-media commerce scalar. Distinct from
    `conversions` (a single transaction may carry multiple units).
    Attribution windows are platform-specific; sellers SHOULD declare the
    window via `reporting_capabilities.measurement_windows` or
    `measurement_terms` rather than encoding it in this scalar.
  - `new_to_brand_units` — Retail-media count of units sold to first-time
    brand buyers. Unit-volume parallel to existing `new_to_brand_rate`
    (which carries the fraction-of-conversions metric); this is the
    absolute unit count.

  **Wired in.**

  - `enums/available-metric.json`: five new enum values appended.
  - `core/delivery-metrics.json`: five new properties (`type: number,
minimum: 0`) added next to `cost_per_click`. Existing `new_to_brand_rate`
    description tightened to clarify it is the fraction of `conversions`
    (transactions), distinguishing it from the new units count.
  - `docs/media-buy/media-buys/optimization-reporting.mdx`: metric list
    updated.

  **Sub-items already resolved on #3460.**

  - **Closed-vs-open enum** — resolved by #3492 (vendor-metric extensions).
    Closed enum stays closed; vendor-defined metrics live in the parallel
    structured `vendor_metrics` surface anchored on the vendor's brand.json.
  - **`completion_rate` derived ratio** — resolved by the drop-carve-out
    call in #3472's refactor. `missing_metrics` is the symmetric mirror of
    `available_metrics` with no carve-outs.

  **Sub-item that remains as a follow-up.**

  - **DBCFM cross-check with David Porzelt** on whether
    `engagements`/`follows`/`saves`/`profile_visits` (added in #3453)
    collide with DBCFM `Reporting`/`Performance` KPI codes. Human contact;
    not a code change.

  **Backwards compatibility.** All additions are optional. Existing reports
  without these scalars stay conformant; sellers that adopt them populate
  the new fields when applicable.

  Closes #3460.

- 6776ce4: Unify outcome measurement into the same primitives as the rest of the measurement surface — outcome metrics live in `available-metric.json`, attribution methodology and window live in the qualifier slot, and `outcome_measurement` as a dedicated field is deprecated. Closes #3857.

  **The conceptual collapse.** Before this minor, the protocol had two surfaces describing overlapping subject matter:

  - `delivery-metrics.json` carried outcome scalars (`conversions`, `conversion_value`, `roas`, `cost_per_acquisition`, `units_sold`, etc.) as part of seller-reported delivery — already the audit-flagged "attribution-derived but seller-reported" hybrid.
  - `core/outcome-measurement.json` (a separate field on `product`) carried business outcome capabilities (`incremental_sales_lift`, `brand_lift`, `foot_traffic`) as free-form strings with implicit vendor identity.

  These were always the same conceptual category — seller-as-measurement-vendor outcome metrics — split across two surfaces because the protocol predated the unified row-shape vocabulary established by #3576 / #3848. With the qualifier slot proven generalizable (#3877's `completion_source` joining `viewability_standard`), the two surfaces collapse cleanly.

  **Schemas added.**

  - `enums/attribution-methodology.json`: closed enum `["deterministic_purchase", "probabilistic", "panel_based", "modeled"]` covering the methodology axis. `deterministic_purchase` is the retail-media closed-loop default (Walmart Connect / Kroger Precision / Amazon DSP); `modeled` covers MMM and clean-room outputs; `panel_based` covers Nielsen / comScore / Edison; `probabilistic` covers statistical match without a 1:1 identifier.
  - `enums/lift-dimension.json`: closed enum `["awareness", "consideration", "favorability", "purchase_intent", "ad_recall"]` for brand-lift dimension disambiguation. Brand lift is multidimensional in production — Kantar, Upwave, Cint, DV all report each dimension separately with its own sample size and confidence interval; the qualifier ensures rows aren't combined into a single number.

  **Schemas updated.**

  - `enums/available-metric.json`: adds `incremental_sales_lift`, `brand_lift`, `foot_traffic`, `conversion_lift`, `brand_search_lift` to the closed delivery vocabulary. Existing outcome scalars (`conversions`, `conversion_value`, `roas`, etc.) cover the rest. **Note: no separate `attributed_sales` entry** — that's `conversion_value` with `qualifier.attribution_methodology: "deterministic_purchase"`. The unified pattern handles the deterministic/probabilistic/modeled split via qualifier rather than parallel metric IDs.
  - `core/delivery-metrics.json`: adds scalar properties for the five new outcome metrics, with descriptions clarifying which methodologies typically apply.
  - **Qualifier slot expanded with three new keys** at all five sites (`core/package.json` `committed_metrics`, `media-buy/package-request.json` buyer-side `committed_metrics`, `media-buy/get-media-buy-delivery-response.json` `metric_aggregates` and `missing_metrics`, `core/performance-feedback.json` `metric`):
    - `attribution_methodology` — closed string enum (`$ref attribution-methodology.json`)
    - `attribution_window` — structured duration (`$ref duration.json`). **First object-valued qualifier key** — the slot was previously string-enum-only; this PR establishes that qualifier values can be structured. Schema description explicitly calls out object-valued shape and forbids shorthand strings (`"14d"`); consumers MUST dispatch on key name to know value shape, and structured-value qualifiers join on canonical (key-sorted) deep equality. Window isn't disambiguating "which version of the metric" the way `viewability_standard` does — it's parameterizing — but the join-on-`(metric_id, qualifier)` pattern handles the same-metric-different-window case correctly so the placement works.
    - `lift_dimension` — closed string enum (`$ref lift-dimension.json`). Disambiguates `brand_lift` rows by surveyed dimension. Production reality (Kantar, Upwave, Cint, DV) reports awareness/consideration/favorability/purchase_intent/ad_recall as separate measurements; a single scalar would force vendors to either pick one or composite. Same qualifier-pattern solution as the other multi-flavored metrics.
  - `core/outcome-measurement.json`: title and description marked **deprecated**. Description carries a migration table mapping legacy field semantics to the unified pattern. Schema retained as-is for one-minor backwards compatibility.
  - `core/product.json` `outcome_measurement` field description marked deprecated, points at the new pattern.

  **Doc updates.**

  - `docs/media-buy/commerce-media.mdx`: "How products declare it" section rewritten to show the new pattern (`reporting_capabilities.available_metrics` + qualifier on commit) alongside the legacy `outcome_measurement` field for the transition window. Existing example payloads continue to use the legacy field — they validate during the deprecation window.
  - `docs/media-buy/product-discovery/media-products.mdx`: `outcome_measurement` field description updated with deprecation note.
  - `docs/media-buy/task-reference/create_media_buy.mdx`: qualifier section adds `attribution_methodology` and `attribution_window` with their conditional-required semantics.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: qualifier vocabulary section names all four keys.

  **Migration.**

  Retail-media sellers using `outcome_measurement` continue to work for one minor. New implementations declare outcome capabilities via `reporting_capabilities.available_metrics` (the same surface used for impressions, conversions, ROAS today) and pin attribution methodology + window via `qualifier` on `committed_metrics` / `metric_aggregates`. Seller-as-measurement-vendor remains the dominant retail-media topology — vendor identity is implicit (the seller) when no separate `performance_standards.vendor` BrandRef is set.

  **What's deferred.**

  `reporting_frequency` and `reporting_format` (the `outcome_measurement.reporting` field's dimensions) move to a follow-up extension on `reporting_capabilities` — they're a property of the seller's reporting infrastructure (daily API, weekly dashboard) rather than a per-metric concern, so they don't belong entangled with the metric definition. Existing `outcome_measurement.reporting` payloads continue to work for one minor.

  **Backwards compatibility.** Additive (new metrics, new qualifier keys, new enum). Deprecated `outcome_measurement` field continues to validate. Removed at the next major when the unified pattern is canonical.

  Closes #3857.

- 72c9be4: feat(media-buy): clarify package correlation across mixed seller versions.

  Sellers now have explicit normative guidance to echo `product_id` on package responses created from explicit `create_media_buy` package requests. Buyers targeting mixed seller populations should use package-level `context`, commonly `context.buyer_ref`, as the legacy-safe fallback for sellers that do not echo `product_id`; read surfaces now document persisted media-buy and package context so that fallback is recoverable, and deprecated top-level `buyer_ref` is removed from not-found recovery guidance.

- aa58c94: Add `capability_ids[]` to `PackageRequest` (the `packages[]` item shape on `create_media_buy`) as a V2 path equivalent to `format_ids[]`. Lets buyers reading the V2 mental model (`Product.format_options[]`) author a `create_media_buy` call without translating back through `v1_format_ref[]`.

  Symmetric with the V2 path that `creative-manifest` already exposes (manifest carries a single `capability_id`; package-side carries an array since one package may activate multiple `format_options` entries).

  Additive optional field. When both `capability_ids` and `format_ids` are sent, `capability_ids` wins and the seller routes by it; the resolving seller ignores `format_ids` (V2-native buyer SDKs SHOULD still emit it as a v1-compat hint for v1-only sellers further down the wire). When neither is sent, the package defaults to all formats supported by the product (unchanged from v1 behavior). Sellers MUST reject with `UNSUPPORTED_FEATURE` when an entry doesn't match a `format_options[]` entry, when the product is v1-only (no `format_options[]` at all), or when the product's `format_options[]` entries don't publish `capability_id` values.

  Closes #4842.

- add4715: Add schema-level `not` constraints to `package-update.json` that explicitly
  forbid the fully-immutable fields (`product_id`, `format_ids`,
  `pricing_option_id`) from appearing in update payloads. Mirrors existing
  MUST NOT prose with machine-checkable validation so permissive sellers
  can no longer silently override frozen values.

  `committed_metrics` is intentionally NOT in the not-list. Per the unified
  metric-accountability design (#3576), `committed_metrics` is **append-only**
  on update — sellers accept new entries (mid-flight metric additions) but
  MUST reject modify/remove of existing entries via runtime validation
  (`validation_error` with code `IMMUTABLE_FIELD`). The "you can append but
  not modify" semantics are not expressible in JSON Schema's `not` clause,
  so this is enforced at the seller's runtime layer rather than the schema
  layer. The append-only contract is documented on `committed_metrics`
  itself.

  Closes #3520.

- a8ba75c: Add `sponsored_placement_types` (retail media) and `social_placement_surfaces` (social) declarations to products and placements, plus matching `get_products.filters` discovery filters, mirroring the `video_placement_types` pattern. Both are seller-declared discovery metadata, not buyer gates. Retail values: `sponsored_search`, `sponsored_display`, `sponsored_native` (`sponsored_offsite` excluded — not catalog-keyed). Social values: `feed`, `stories`, `short_video`, `explore`, `search` (semantic surfaces, not platform brand names).
- 3f7c461: Add `plays` scalar to `delivery-metrics.json` and `available-metric.json` —
  closes a forecast↔delivery asymmetry where `plays` was declared as a
  forecastable metric (`forecastable-metric.json:23`, `forecast-point.json:38`)
  but absent from delivery reporting. Closes #3516.

  **The shape.** Top-level `type: number, minimum: 0`. Description
  cross-references the forecast-side definition and explicitly distinguishes
  from `dooh_metrics.loop_plays` (per-screen rotation count) and
  `impressions` (multiplied audience figure). Used for DOOH and broadcast
  inventory where buyers reconcile against forecast `plays`.

  Why top-level (Option A) over nesting in `dooh_metrics` (Option B):

  - Forecast side declares `plays` at the same level as `impressions` /
    `views` (top-level on `forecast-point`); reconciliation pairs cleanly
    when the delivery-side field mirrors that placement
  - Used for broadcast inventory too (not DOOH-only), so confining to
    `dooh_metrics` would force a separate field for non-DOOH plays
  - Matches the type convention of other top-level count scalars
    (`type: number`, not the `integer` used inside `dooh_metrics`)

  **Test plan** — `build:schemas`, `test:schemas`, `test:examples`,
  `typecheck` all green.

  Closes #3516.

- 72b79ac: Replace country-fused postal targeting as the preferred shape with country-local postal systems:

  - `postal-system` now adds country-local system names such as `zip`, `zip_plus_four`, `outward`, `plz`, and the fallback `postal_code`; the published enum retains existing country-fused values for 3.x compatibility.
  - New postal area objects use `{ country, system, values }`.
  - Country/system pairs are validated so known countries only accept their registered local systems; unknown countries use `postal_code` or `custom`.
  - `get_adcp_capabilities.media_buy.execution.targeting.geo_postal_areas` now prefers an ISO 3166-1 alpha-2 country-keyed map such as `{ "US": ["zip"], "ZA": ["postal_code"] }`.
  - During the 3.x migration, sellers SHOULD emit equivalent deprecated aliases such as `us_zip` alongside native country keys where an alias exists. Buyers and SDKs SHOULD normalize both forms.
  - Deprecated country-fused aliases remain accepted through legacy branches for SDK backfill and existing integrations.
  - Delivery geo rows now require native postal rows to include `country`.

  Refs #5383.

- 8da6974: Clarify proposal lifecycle semantics and mark measurement catalog discovery experimental for 3.1.

  Proposal updates:

  - `proposal_status` is the per-proposal source of truth for whether finalization is required before `create_media_buy`.
  - `finalize` is seller commitment to firm pricing/terms/hold, not buyer acceptance.
  - `create_media_buy(proposal_id)` is buyer acceptance/execution of a committed proposal.
  - `supports_proposals` is a conformance grading declaration, not buyer routing logic for an individual returned proposal.
  - `allowed_actions[]` / `available_actions[]` remain scoped to media-buy mutations; proposal lifecycle is not modeled as a proposal-level action list.
  - `requires_proposal` is removed from media-buy action modes before 3.1 GA, replacing the rc-shipped enum with `REQUOTE_REQUIRED` recovery when an update exceeds the current quoted envelope. 3.1 does not define an amendment-quote artifact for `update_media_buy`.

  Measurement updates:

  - `measurement` capability block is marked `x-status: experimental`.
  - Agents implementing the measurement catalog declare `measurement.core` in `experimental_features`.
  - Docs describe measurement vendor catalog discovery as experimental while the task surface and compliance baseline remain unfrozen.

- 75793d5: feat(provenance): embedded_provenance, watermarks, accepted_verifiers, and structured rejection codes

  Two new optional arrays on `provenance.json` distinguish between provenance metadata carried within the content stream (`embedded_provenance`) and content watermarks that encode an identifier or fingerprint (`watermarks`). The separation aligns with C2PA's normative taxonomy: embedded provenance maps to binding assertions and manifest embedding (Section A.7), while watermarks map to the `c2pa.watermarked.*` action family.

  The verifier contract follows seller-publishes / buyer-represents / seller-confirms:

  - **Seller publishes** `creative_policy.accepted_verifiers[]` — the governance agents it operates or has allowlisted, each with `agent_url`, optional `feature_id`, and optional `providers[]`. Returned on `get_products`.
  - **Buyer represents** on each `embedded_provenance[]` and `watermarks[]` entry by attaching `verify_agent: { agent_url, feature_id? }` whose `agent_url` matches a published `accepted_verifiers[]` entry (canonicalized).
  - **Seller confirms** by cross-checking the URL against its allowlist before any outbound call, then invoking `get_creative_features` against the matching on-list agent. Sellers MUST NOT call buyer-asserted endpoints outside their allowlist.

  This closes the SSRF / exfil / phishing surface a buyer-controlled URL would otherwise create, and matches how publishers actually pick verifiers (they run their own pipeline; buyer-attached evidence is supplementary, not authoritative).

  A new `provenance_requirements` object on `creative-policy.json` gives sellers structured, field-level provenance requirements: `require_digital_source_type`, `require_disclosure_metadata`, `require_embedded_provenance`. Sellers that publish a requirement MUST enforce it on `sync_creatives` with the matching error code from the new `PROVENANCE_*` family on `error-code.json`:

  - `PROVENANCE_REQUIRED` — no provenance object on the creative
  - `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING` — required `digital_source_type` absent
  - `PROVENANCE_DISCLOSURE_MISSING` — required `disclosure` block absent
  - `PROVENANCE_EMBEDDED_MISSING` — required `embedded_provenance` entry absent
  - `PROVENANCE_VERIFIER_NOT_ACCEPTED` — `verify_agent.agent_url` is off the seller's `accepted_verifiers` list (cross-checked before any outbound call)
  - `PROVENANCE_CLAIM_CONTRADICTED` — on-list verifier (called via `get_creative_features`) refutes the buyer's claim

  These codes are correctable: a buyer's orchestrator reads them, fixes the creative, and resubmits without negotiating with the seller. `PROVENANCE_CLAIM_CONTRADICTED.error.details` is constrained to the audit-safe allowlist `{ agent_url, feature_id, claimed_value, observed_value, confidence, substituted_for }` so verifier responses cannot leak cross-tenant or PII data.

  The `c2pa` field description on `provenance.json` is updated to note that sidecar manifest bindings break during ad-server transcoding, with a reference to `embedded_provenance` as the alternative for intermediary pipelines.

  New enum files: `embedded-provenance-method.json`, `watermark-media-type.json`, `c2pa-watermark-action.json`. New compliance scenario: `protocols/media-buy/scenarios/provenance_enforcement.yaml` walks the structural-rejection contract end to end (discover requirement → reject off-list verifier → reject missing disclosure → accept corrected resubmission).

  All wire additions are optional and additive; existing agents that do not read the new fields are unaffected.

  Closes #2854 (Option A: must-carry baseline expansion + Track 1: embedded provenance field shape).

- 8f03600: Add published-post reference creatives as a canonical-format refinement, not a new task surface or format family.

  - Adds `published_post` as an asset payload type, canonical slot asset type, and `asset_types` filter value for `list_creative_formats`.
  - Adds `publisher_owned_reference` to canonical `asset_source` where a product resolves an existing post instead of accepting uploaded bytes.
  - Adds `required_connections` for downstream platform grants, plus `AUTHORIZATION_REQUIRED` details for missing advertiser account, publisher identity, or post-scoped authorizations.
  - Adds `CreativeStatus: "suspended"` plus authorization/source reason codes so recoverable published-post dependency loss is distinct from policy rejection, with documented escalation from `suspended` to `rejected` when the dependency becomes terminal.
  - Adds `AUTHORIZATION_REQUIRED` for authenticated calls that need additional creator, identity, or post authorization before serving.
  - Documents the canonical `video_hosted` published-post pattern and keeps catalog-driven retail media on `sponsored_placement`.

- 1f158e8: Fix release validation for compliance bundle closure and align signals conformance with the owned-signal manifest fix tracked in #5186.

  - Package webhook receiver envelope vectors under the versioned compliance tree and update storyboard references to bundle-relative paths.
  - Fail compliance and protocol tarball builds when authored vector/test-kit references do not resolve inside the packaged compliance tree.
  - Narrow baseline and `signal_owned` conformance back to discovery-only so SDK manifests do not require owned-signal agents to implement marketplace activation.
  - Require `activate_signal` on the `signal_marketplace` specialism and update the Signals Protocol docs to state the two-tier obligation explicitly.

- 6ff3f9d: Reconcile `available-metric` enum with `delivery-metrics.json` so every
  declarable metric has a corresponding property in the delivery payload.

  **Why.** A buyer that says "I can only use products that report
  `completed_views`" only has accountability if the enum used at the discovery
  layer is a 1:1 mirror of what reporting can actually return. The enum had
  drifted from the property set:

  - `video_completions` was listed in the enum but had no corresponding property
    in `delivery-metrics.json` — the property was renamed to `completed_views`
    in a prior release (per `docs/reference/release-notes.mdx` §7) and the enum
    alias was never cleaned up. A seller declaring it in `available_metrics`
    was advertising a metric they could not report.
  - Four scalar properties on `delivery-metrics.json` (`engagements`, `follows`,
    `saves`, `profile_visits`) had no enum entries, so a product that reports
    social/social-platform engagements had no way to declare so at discovery.

  **Changes.**

  - `enums/available-metric.json`: remove `video_completions`; add `engagements`,
    `follows`, `saves`, `profile_visits`. Object/namespace entries (`viewability`,
    `quartile_data`, `dooh_metrics`) remain — they map to namespace properties
    in `delivery-metrics.json`.
  - `core/reporting-capabilities.json`: example updated to use `completed_views`.
  - `docs/media-buy/media-buys/optimization-reporting.mdx`: metric list rewritten
    to match the reconciled enum (drops the stale `video_completions` entry,
    adds `engagements` / `follows` / `saves` / `profile_visits` /
    `new_to_brand_rate`). Notes platform variance for `saves`
    (Pinterest "repins", TikTok "video_saves").
  - `docs/media-buy/task-reference/create_media_buy.mdx`: `requested_metrics`
    examples updated to `completed_views`.
  - `server/src/training-agent/publishers.ts`: training-agent fixture
    `reportingMetrics` arrays use `completed_views`.

  **Vocabulary provenance.** `completed_views` and `engagements` follow IAB/MRC
  and VAST 4 conventions. `follows`, `saves`, and `profile_visits` are
  platform-native names (Meta/TikTok/Pinterest); AdCP is setting these as the
  canonical aliases for cross-platform reporting since IAB does not define
  social-platform engagement scalars.

  **Backwards compatibility.** Removing `video_completions` from the enum is a
  validation-constraint change — minor-bumped per the schema-publication-at-merge
  policy. Any seller that had populated `available_metrics: ["video_completions"]`
  was already non-functional (no `video_completions` field in delivery responses
  to populate, only `completed_views`). Buyers that filtered against
  `video_completions` on the discovery side should switch to `completed_views`.

  This unblocks a follow-up that adds `required_metrics` to `get_products` and
  `missing_metrics` to `get_media_buy_delivery` for end-to-end metric
  accountability through the media buy lifecycle.

  **DBCFM KPI cross-reference.** The DBCFM `Reporting`/`Performance` KPI
  vocabulary has not been mapped into AdCP (PRs #1594, #1605, #1664 covered
  price/business-entities/proposal-lifecycle; measurement block is out of
  scope). No string-level or semantic collision exists at merge time. When the
  DBCFM measurement mapping is eventually added, note that `engagements`
  corresponds to DBCFM `Interaktionen`, `follows` to `Follower-Gewinn`, `saves`
  to `Gespeichert`, and `profile_visits` to `Profilbesuche`. No aliasing is
  required — the AdCP names are unambiguous — but a cross-reference note will be
  needed in the DBCFM mapping doc (tracked in #3460).

  **`completion_rate` is a derived ratio.** `completion_rate =
completed_views / impressions` — it is derivable, not independently
  reportable. The planned `missing_metrics` check in `get_media_buy_delivery`
  must treat ratio metrics as derivable to avoid false
  `metric_accountability_breach` hints. This is a design signal for the
  `required_metrics`/`missing_metrics` follow-up; it does not affect this PR.

- 16147ac: Add `redirect_reason` and `redirect_effective_at` to both redirect variants in `brand.json` (Authoritative Location Redirect and House Redirect).

  Today, when a brand.json transitions from a portfolio document to a redirect (e.g., during M&A — Dentsu becomes a House Redirect to WPP), DSPs / crawlers / prebid configs sit on stale cached state for whatever their TTL is. Free-text `note` is human-readable but not machine-parseable.

  `redirect_reason` is an enum (`acquisition`, `divestiture`, `rebrand`, `regional`, `legacy`, `consolidation`, `other`) that consumers SHOULD use to inform cache TTL: in-transition reasons (`acquisition`, `divestiture`, `rebrand`, `consolidation`) suggest the resolved target is moving and consumers SHOULD shorten cache TTL until stable; stable reasons (`regional`, `legacy`) keep standard caching.

  `redirect_effective_at` is an ISO 8601 timestamp. Caches **MUST** treat any entry cached before this timestamp as stale and re-fetch through the redirect — this is the hard invariant that closes the cache-poisoning gap during transitions, regardless of TTL.

  Both fields are optional and additive. Existing redirect publishers continue to work unchanged.

  Motivated by review of the distributed brand.json RFC ([#3533](https://github.com/adcontextprotocol/adcp/pull/3533)) — the M&A migration story uses existing redirect variants, and this PR makes that ergonomic.

- f7f6600: spec(request-signing): add `protocol_methods_*` namespace to `request_signing` capability; widen test-agent strict route to enforce it (closes #4318, #4314)

  `request_signing.supported_for` / `required_for` carry **AdCP protocol operation names** (`create_media_buy`, `update_media_buy`, …). They have always been silent on **JSON-RPC protocol methods** like `tasks/cancel` and `tasks/get` — methods that traverse the same authenticated channel as `tools/call` (auto-registered by MCP and defined by A2A 0.3.0 §7.x), but are not AdCP operations and MUST NOT be conflated with the AdCP-tool namespace per the existing normative rule at `security.mdx:927`. Buyers signing `tasks/cancel` on abort had no spec-grounded way to know whether the seller's verifier covered it; the only defensible default was to over-sign on best-effort.

  This change adds three sibling fields to `request_signing` for sellers to declare verifier coverage of protocol methods:

  ```jsonc
  {
    "request_signing": {
      "supported": true,
      "supported_for": ["create_media_buy", "update_media_buy"],
      "required_for": ["create_media_buy"],
      "protocol_methods_supported_for": ["tasks/cancel", "tasks/get"],
      "protocol_methods_required_for": ["tasks/cancel"]
    }
  }
  ```

  Schema enforces the namespace split via `pattern: "/"` on items — JSON-RPC method strings (containing `/`) MUST appear here; AdCP tool names (no `/`) MUST appear in `supported_for` / `required_for`. `protocol_methods_required_for` is `subset_of` `protocol_methods_supported_for`; `protocol_methods_warn_for` is `disjoint_with` `protocol_methods_required_for` and `subset_of` `protocol_methods_supported_for` (mirrors AdCP-namespace rules). `identity.brand_json_url` is now `required_when` any of the new fields is non-empty.

  Normative text added to `docs/building/by-layer/L1/security.mdx`:

  - The `protocol_methods_*` arrays are matched against the JSON-RPC envelope's `method` field, not the `tools/call` `params.name`.
  - The same RFC 9421 covered components apply to JSON-RPC method calls (`@target-uri`, `@method`, `content-digest` per the seller's `covers_content_digest` policy, `authorization` when present).
  - Buyers MUST NOT infer protocol-method coverage from `supported_for` / `required_for`.

  `test-agent.adcontextprotocol.org` strict route (`/<tenant>/mcp-strict`) is widened to enforce the new bucket: `STRICT_REQUIRED_FOR` adds `update_media_buy` and `sync_creatives` (so a buyer that signs the initial create but forgets follow-on mutations gets a 401 instead of a silent green light), and a new `STRICT_PROTOCOL_METHODS_REQUIRED_FOR = ['tasks/cancel']` constant feeds the SDK verifier through a new namespace-aware `mcpOperationResolver`. The wire response from `get_adcp_capabilities` splits the bundle so AdCP tool names emit on `required_for` and JSON-RPC methods emit on `protocol_methods_required_for`. Closes the original `tasks/cancel`-on-abort regression-test ask in adcp-client#1617 Phase 2.

  The earlier #4314 proposal of an `X-Test-Require-Signing` per-session header is **not** adopted: per the triage, header-driven per-session enforcement contradicts `security.mdx:927` (declaration-enforcement coherence) and the SDK's verifier architecture (singleton capability objects, eagerly-built authenticators). Strict-route enforcement on `/mcp-strict` is the spec-coherent path.

  No `VerifierCapability` (SDK type) shape change — the SDK's flat `required_for` array remains; namespace separation lives on the wire and in storyboard runners, not in the verifier match step.

- dececcd: Add end-to-end metric accountability through the media buy lifecycle: buyers
  can now require specific reporting metrics at discovery time, and delivery
  reports surface any gaps in the contract.

  **Why.** Without this, a buyer asking for `completed_views` on a CTV CPCV buy
  discovers metric availability through `reporting_capabilities.available_metrics`
  on each product, then has to manually filter — and at delivery time there is
  no field that flags when an advertised metric was not produced. The closest
  existing primitive (`required_performance_standards`) is for guarantee
  thresholds (e.g., "70% MRC viewability") with vendor selection, not for
  capability-level metric discovery.

  **Changes.**

  - `core/product-filters.json`: new `required_metrics` field on `get_products`
    filters. Sellers MUST silently exclude products whose
    `reporting_capabilities.available_metrics` is not a superset
    (filter-not-fail; do not return an error). The product's declared
    `available_metrics` becomes the binding reporting contract carried into
    the resulting media buy — the same vocabulary computes `missing_metrics`
    on `get_media_buy_delivery`.
  - `media-buy/get-media-buy-delivery-response.json`: new `missing_metrics`
    field on each `by_package[]` entry. Lists metrics from the product's
    `available_metrics` that are NOT populated in this report. Empty array (or
    absent) indicates clean delivery; non-empty signals an accountability
    breach. Sellers MUST exclude metrics not yet measurable for the current
    `measurement_window` (e.g., post-IVT counts during the live window) —
    those will appear (or not) when a wider window supersedes this report
    via `supersedes_window`.
  - `docs/media-buy/task-reference/get_products.mdx`: documents the new filter,
    filter-not-fail semantics, and the derived-ratio carve-out.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: documents the
    `missing_metrics` field as the accountability signal.
  - `static/compliance/source/protocols/media-buy/scenarios/measurement_accountability.yaml`:
    new conformance storyboard exercising the full lifecycle — discovery with
    `required_metrics`, create, simulated delivery, and delivery-report shape
    validation. Storyboard validates schema-level contract; semantic
    enforcement (verifying the seller honestly populates `missing_metrics`)
    is left to a follow-up that extends the test controller with
    metric-omission scenarios.

  **No additional field on `create_media_buy`.** The product's declared
  `available_metrics` carries forward as the reporting contract — adding a
  new field on the buy would duplicate that, and `measurement_terms` /
  `performance_standards` already cover guarantee-level commitments at the
  package level.

  **Backwards compatibility.** Both fields are optional and additive. Existing
  sellers that do not populate `missing_metrics` are interpreted as "no breach"
  (field absent = clean delivery), so existing reports remain conformant.
  Buyers that omit `required_metrics` see the same behavior as today.

  **Hint kind follow-up.** A dedicated `metric_accountability_breach` storyboard
  hint kind (with Diagnose/Locate/Fix/Verify formatter) is deferred to a
  follow-up @adcp/client PR — for now, breach is detectable via standard
  schema validation on the delivery response and the storyboard runner's
  `field_present` check on populated metrics.

  Refs #3460.

- e52f78e: Add normative `response_schema_validator_semantics` clause to `runner-output-contract.yaml`.

  Runners MUST apply the referenced JSON schema with a draft-07 compliant validator that honours the schema's own `additionalProperties` declaration without process-level override. Configuring AJV `removeAdditional: 'all'` or Zod `.strict()` on derived schema objects in a way that contradicts the schema's `additionalProperties: true` declaration is a conformance violation. Addresses issue #4419, where the comply runner produced false-negative verdicts for spec-valid seller responses that included optional or newly-added fields (`authorization`, `sandbox`).

- dbc5b56: Name 3.1 schema component shapes used by SDK code generators: account-with-authorization response items, forecast dimension variants, signal selection-group rules, canonical projection slot overrides, committed metrics, delivery metric aggregates, and vendor-metric optimization rows. Document nullable scalar representation and mark intentionally open payload fields with `x-adcp-open-payload`.
- f23c966: Add `search_brands` task to the brand protocol.

  Provides a natural-language brand discovery verb for IP desks that need to find brands on an agent's roster before they have a known `brand_id`. Returns lightweight brand stubs (public identity tier) that feed directly into `get_brand_identity` or `get_rights` without an extra identity-resolution round-trip.

  New schemas (experimental): `search-brands-request.json`, `search-brands-response.json`. New task type `search_brands` added to stable `task-type.json` enum.

  Closes #3480.

- 1d1c562: Add Sponsored Intelligence sponsored-context accountability primitives.

  New SI schemas define `context_use` (`presentation_only`, `comparison_set`, `reasoning_context`), `sponsored_context` declarations, and host `sponsored_context_receipt` records. `si_get_offering`, `si_initiate_session`, and `si_send_message` now have optional fields for carrying those declarations and receipts across the host boundary.

  The model separates `paying_principal` (who economically sponsored the context) from `host_receipt` (what use mode and disclosure commitment the receiving host accepted). Accepted receipts must include the accepted use mode and disclosure commitment; hosts that cannot honor the declaration reject the context rather than down-scoping it.

- 1584e44: spec(signals): make deprecated `coverage_percentage` optional on signal responses.

  `get_signals.signals[]` and wholesale feed signal payloads now keep `coverage_percentage` as an optional deprecated legacy scalar instead of a required deprecated field. `coverage_forecast` is the source of truth for detailed signal coverage planning; the scalar remains a backward-compatible fallback for clients that still consume it.

  Adds validation coverage for `coverage_rate.low` and `coverage_rate.high` upper bounds, and pins the intended valid signal forecast shape where `presence: "present"` omits `signal_value`.

  Closes #5089.

- e5d2bbc: Extend `core/signal-definition.json` with definition-side signal enrichment for taxonomy metadata, DTS-aligned source/methodology disclosures, modeling metadata, jurisdiction applicability, consent basis, and per-signal data-subject-rights routing.

  Taxonomy is modeled as signal-definition metadata rather than a new `signal-value-type`, so package targeting continues to use the existing binary, categorical, and numeric expression grammar. Categorical signals can map `allowed_values[]` strings to stable taxonomy nodes with `taxonomy.value_mappings`. Parent taxonomy node expansion is declared as seller behavior through `taxonomy.parent_match_behavior` instead of being implied by the schema.

  Adds a signal-specific `core/signal-modeling-disclosure.json` instead of reusing creative `provenance.disclosure`, because data-signal modeling disclosure has different semantics from content provenance and render guidance. Modeled signals now require non-empty training-data jurisdictions, and required modeling disclosures must name the jurisdictions where the disclosure applies.

- 1b6831e: Add product-scoped `included_signals`, `signal_targeting_options`, `signal_targeting_rules`, and package-level `targeting_overlay.signal_targeting_groups` for explicit buy-time selection of seller-offered signals. Signals are referenced with `signal_ref` using `scope: "product"` for product-local signal options, `scope: "data_provider"` with `data_provider_domain` for signals from published adagents.json `signals[]`, or `scope: "signal_source"` for source-native signals that are not published in adagents.json `signals[]`. `included_signals` describes non-selectable signals already bundled into or planned into the product. Sellers can expose signals through `get_signals`, omit inline options when a wholesale product uses that feed, declare product-specific options or overrides through `Product.signal_targeting_options`, and buyers can apply selected signals on `create_media_buy` with the selected signal `pricing_option_id` and optional seller execution handle without overloading first-party audience fields. `signal_targeting_groups` provides the portable Boolean baseline for all signal selection: top-level `operator: "all"` with child groups using `operator: "any"` for include groups and `operator: "none"` for exclusion groups. Product-scoped signal pricing is authoritative for product composition, and free or bundled signals may omit `pricing_options`. Updates media-buy and signals docs plus targeting-overlay echo vectors.

  Product signal listings share one signal-ref-plus-definition shape. Product-local signal refs require inline `name` and `value_type`; data-provider and signal-source refs can be reference-only because the authoritative definition lives at the referenced provider-published signal definition or source.

  `signal_targeting_rules.resolution_model` distinguishes direct targeting from seller-planned resolution. Use `direct_targeting` when selected signals are applied as package targeting predicates, and `seller_planned` when selected signals are inputs to seller-managed planning against product-specific inventory, timing, availability, reach, or pacing constraints.

  This also relaxes `get_signals.signals[].data_provider` and `pricing_options` so source-native, free, bundled, or caller-hidden pricing cases can omit those fields; buyers should not assume every discovered signal has a data-provider display name or standalone price.

  The legacy `SignalId` / `signal_id.source` shape is deprecated in favor of `SignalRef`. New payloads should use `signal_ref` for response identity and `signal_refs` for exact lookup/refinement; `signal_id` and `signal_ids` remain as deprecated compatibility fields for older clients. During this minor-version migration window, legacy `signal_id` remains accepted on signal listings, audience selectors, legacy flat signal targeting, and wholesale signal events. Legacy `targeting_overlay.signal_targeting` also remains schema-valid but deprecated; new package-level selection should use `targeting_overlay.signal_targeting_groups`.
  The legacy `signals.features.catalog_signals` capability flag is also deprecated. New agents should rely on `supported_protocols: ["signals"]`, `signals.data_provider_domains`, `signals.discovery_modes`, and `get_signals` behavior instead of emitting a separate provider-published-signals feature flag.

- 6ddfea9: Lift sole-stateful-step cascade exemption into `runner-output-contract.yaml` as normative MUST language. The spec was previously silent on what happens when the sole stateful step in a phase grades `not_applicable`, `missing_tool`, or `missing_test_controller` — causing runner divergence (the TS SDK exempts the cascade; other runners may not). Adds a top-level `cascade_rules` section with `default_cascade` and `sole_stateful_step_exemption` rules. Also bumps the contract's own `version` field from `2.0.0` → `2.1.0`.
- 7525019: Add `identity.brand_json_url` to `get_adcp_capabilities` response — capabilities-level pointer to the operator's brand.json so verifiers can bootstrap from an agent URL to that agent's signing keys without out-of-band knowledge of the operator domain. Closes the discovery gap in the request-signing chain (capabilities → `identity.brand_json_url` → brand.json → `agents[]` → `jwks_uri` → JWKS).

  **What's new in `static/schemas/source/protocol/get-adcp-capabilities-response.json`:**

  - New `brand_json_url` field inside the existing `identity` block (HTTPS URI). Co-located with `identity.key_origins`, `per_principal_key_isolation`, `compromise_notification` — all the trust-posture fields that depend on it. Naming intentionally distinguishes from `sponsored_intelligence.brand_url`: `brand_url` is reserved for "the brand being advertised" contexts; `brand_json_url` names the file artifact (the operator's brand.json), independent of whether the operator is a single brand, a house, an agency, or a pure operator record.
  - Schema-optional in 3.x; storyboard-enforced when the agent declares any signing posture (`request_signing.supported_for`/`required_for` non-empty, `webhook_signing.supported === true`, or any `identity.key_origins` subfield). Becomes schema-required in 4.0 for responses declaring `supported_versions` containing any 4.x release.
  - Structured constraints (required-when rules, verifier constraints, distinct-from relationships) lifted into a new `x-adcp-validation` extension keyword on the field. Codegen consumers get a tight 2-sentence JSDoc; the storyboard runner and SDK validators consume the structured rules programmatically. See `docs/reference/schema-extensions.mdx` for the convention.

  **What's new in `docs/building/implementation/security.mdx`:**

  - §"Discovering an agent's signing keys via `brand_json_url`" — 8-step verifier algorithm with eTLD+1 origin binding (pinned PSL snapshot required), `authorized_operators[]` opt-in for SaaS-platform-as-operator deployments, mandatory `identity.key_origins` consistency check (purpose-AND-role, with sell-side webhook publisher-pin carve-out), no-redirect rule on brand.json fetch, body cap and timeout budgets, negative-cache 60s floor.
  - Eight new `request_signature_*` rejection codes with detail fields and remediation column: `brand_json_url_missing`, `capabilities_unreachable`, `brand_json_unreachable`, `brand_origin_mismatch`, `agent_not_in_brand_json`, `brand_json_ambiguous`, `key_origin_mismatch`, `key_origin_missing`.
  - Trust-root distinction: brand.json operator-attested; adagents.json publisher-attested; agent never self-attests.
  - Quickstart subsection mirroring §796 — 6 numbered steps + 15-line pseudocode for implementing a `brand_json_url`-based verifier.
  - Reference-implementation paragraph naming `@adcp/client` (TypeScript), `adcp` (Python), `adcp-go` (Go) with their `resolveAgent` / `getAgentJwks` / `verify_request_signature` signatures and the `npx @adcp/client resolve <url>` CLI.

  **Backwards compatibility:** Strictly additive. Verifiers that ignore `identity.brand_json_url` continue to work. The full design (with reviewer history, multi-tenant operator handling, SDK + CLI integration, naming-convention discussion, and rejected hosted-AAO-resolver alternative) is in `specs/capabilities-brand-url.md`.

  **Adopting from 3.0 (no version bump required).** The wire shape is forward-compatible — 3.0-conformant agents can populate and read the field today without waiting for the 3.x bump. A 3.0 seller MAY emit `identity.brand_json_url` on its capabilities response and a 3.x verifier picks it up automatically; a 3.0 verifier MAY read it opportunistically and run the 8-step chain when present, falling back to existing out-of-band agent → operator mapping when absent. The chain itself is plain HTTPS fetches and JSON parsing — no 3.x SDK required. AdCP doesn't backport new schema fields to patch releases (3.0.x), but 3.0-pinned implementers building signature verification today (e.g., Scope3) can ship the field now and let the 3.x rollout happen passively. See [security.mdx §Discovering an agent's signing keys](https://adcontextprotocol.org/docs/building/implementation/security#discovering-an-agents-signing-keys-via-brand_json_url) for the verifier algorithm.

- 1323f39: spec(specialisms): add `sponsored-intelligence` to `AdCPSpecialism` (preview)

  Adds `sponsored-intelligence` to the `AdCPSpecialism` enum so SI agents have a wire-level specialism ID to claim, with the same dispatch parity as `signal-marketplace`, `creative-template`, `governance-spend-authority`, and the other agent shapes. SDKs (e.g. `@adcp/sdk` v6) can now key SI dispatch off the specialism ID instead of routing through escape-hatch handler bags.

  Shipped as `status: preview` while the four SI lifecycle tools (`si_get_offering`, `si_initiate_session`, `si_send_message`, `si_terminate_session`) remain `x-status: experimental`. Per the preview-status contract, claims of this specialism are graded as `{ status: "preview", passed: null, reason: "storyboard not yet defined" }`; conformance for SI agents continues to be exercised by the `sponsored-intelligence` protocol baseline at `/compliance/{version}/protocols/sponsored-intelligence/`. Promotes to `stable` (with `required_tools` and a graded storyboard) when the SI tools graduate.

  Closes #3961.

- 4e96782: Add optional `requires` field to the storyboard schema for whole-storyboard runtime requirement gating.

  Third-party runners can now declare per-storyboard requirements (`controller`, `seeded_state`, `real_wire`) that the runner evaluates at load time before executing any steps. Storyboards without the field run unchanged. The `requirement_unmet` skip reason is added to runner-output-contract.yaml to match the skip reason already emitted by `@adcp/sdk@^6.16.0` (adcp-client#1635).

- b7068f0: Tighten three universal storyboard false-failure paths: webhook-emission now explicitly requires a configured webhook receiver so unresolved runner URL templates must grade not_applicable instead of reaching the agent; security_baseline positive static-credential probes now document initialized-session dispatch rather than raw direct Bearer-only `tools/call`; and schema-validation now requires the concrete INVALID_REQUEST past-start rejection instead of a trailing branch-set contribution assertion.

  Migration note: agents that currently accept a past concrete `start_time` and adjust it to a current/future flight must instead return `INVALID_REQUEST`; use `start_time: "asap"` when the buyer wants immediate activation.

- cf889f2: feat(media-buy): `supports_proposals` capability flag — closes #3844

  Adds a wire-level capability flag at `media_buy.supports_proposals` (boolean) so the storyboard runner can gate `proposal_finalize` cleanly, and folds the scenario into `sales-guaranteed.requires_scenarios`.

  `get-adcp-capabilities-response.json`:

  - New `media_buy.supports_proposals` boolean. A declaration of `true` is a commitment the seller will be graded against (return at least one entry in `proposals[]` for `buying_mode: 'brief'`; honor `action: 'finalize'` to transition draft → committed), not just a feature flag. Full-service guaranteed sellers (premium pubs, broadcast, CTV) declare `true`; auction-based PG, retail SKU, and quoted-rate direct-buy flows declare `false`.

  `media-buy/scenarios/proposal_finalize.yaml`:

  - Adds `requires_capability: { path: media_buy.supports_proposals, equals: true }`. Sellers that explicitly declare `false` skip the scenario as `capability_unsupported`; sellers that declare `true` (or omit the field per the runner's absence semantics) are graded against it.

  `specialisms/sales-guaranteed/index.yaml`:

  - Adds `media_buy_seller/proposal_finalize` to `requires_scenarios`. Now safe — capability-gated. Narrative updated to remove the "tracked at #3844" caveat.

  `specialisms/sales-proposal-mode/index.yaml` and `enums/specialism.json`:

  - Deprecation note for `sales-proposal-mode` updated to point sellers at the migration path: drop the specialism, declare `sales-guaranteed` plus `media_buy.supports_proposals: true`. Storyboard retained through 3.x for backward compat; removed at 4.0.

  Refs: #3823 (taxonomy consolidation), #3840 (sales-proposal-mode deprecation), #3844 (this).

- 81ad6f5: Require creatives accepted by a synchronous `sync_creatives` success response to be immediately visible through `list_creatives` for the same account and authorized caller, while preserving the submitted task envelope for whole-operation async ingestion.
- 48e140f: feat(training-agent): impairment tracking on media buys — creative-status transitions propagate to media_buy.impairments[].

  Closes #4719. Two storyboards added in #4677/#4685 (`media_buy_seller/dependency_impairment` and `dependency_impairment_cardinality`) needed full impairment-tracking machinery: when a creative referenced by a media buy's package transitions to `rejected`, the buy MUST surface `health: "impaired"` and an `impairments[]` entry; when the buyer recovers via assignment swap, the impairment MUST clear.

  **Model.** Adds `impairments?: Impairment[]` to `MediaBuyState` (`server/src/training-agent/types.ts`). Impairment shape mirrors `static/schemas/source/core/impairment.json` — `impairment_id`, `resource_type`, `resource_id`, `package_ids`, `transition`, `reason_code`, `observed_at`.

  **Propagation.** `comply-test-controller.ts:forceCreativeStatus` now calls `propagateCreativeImpairment` after mutating creative status. Walks `session.mediaBuys`, finds buys whose packages reference the creative, and appends/removes an impairment entry per direction (`approved → rejected` appends; `rejected → approved` removes). Idempotent on re-emission.

  **Recovery.** `handleUpdateMediaBuy`'s `creative_assignments` replacement path recomputes the buy's open impairments: any creative-impairment whose `resource_id` is no longer referenced by any package on the buy is dropped. This is the canonical recovery vector — the buyer swaps the offline creative for an approved sibling.

  **Response surface.** `handleGetMediaBuys` now emits `health` (`'impaired'` when `impairments.length > 0`, else `'ok'`) and `impairments[]` per the spec.

  **Comply config.** `force_creative_status` adapter wired into the `/sales` tenant's `buildSalesComplyConfig` (was missing — the storyboards reported `force_scenario_unsupported`).

  **Storyboard scenario adjustments.** The v6 SDK's `SalesPlatform.syncCreatives(creatives, ctx)` signature drops the request-level `assignments[]` field — the platform method has no surface for inline assignments. Both dependency_impairment scenarios are restructured to do the binding via `update_media_buy.packages[].creative_assignments` after `sync_creatives`, which is the spec's canonical surface for the binding anyway. Filed upstream at `adcontextprotocol/adcp-client#1842` to thread assignments to the platform.

  `dependency_impairment_cardinality` also needed an explicit `bid_price` on its `create_media_buy` request — the product returned for its slightly-different brief picks an auction-pricing option as `pricing_options[0]`, and the seller correctly requires `bid_price` for auction. The parent `dependency_impairment` scenario happens to land on a fixed-price option and didn't need it.

  Sales floor lifts from 72:340 to 74:380 (+1-clean buffer below observed 75:398).

  Files:

  - `server/src/training-agent/types.ts` — `MediaBuyState.impairments`, `Impairment` interface.
  - `server/src/training-agent/comply-test-controller.ts` — `propagateCreativeImpairment`, called from `forceCreativeStatus`.
  - `server/src/training-agent/task-handlers.ts` — `health`/`impairments` in `handleGetMediaBuys`; assignment-swap impairment clearing in `handleUpdateMediaBuy`.
  - `server/src/training-agent/tenants/comply.ts` — `force_creative_status` adapter.
  - `static/compliance/source/protocols/media-buy/scenarios/dependency_impairment.yaml` — split `sync_creative_with_assignment` into `sync_creative` + `assign_creative_to_package`.
  - `static/compliance/source/protocols/media-buy/scenarios/dependency_impairment_cardinality.yaml` — same split + `bid_price: 10.0` on packages.
  - `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh` — floor bump.

- 868a051: feat(schema): add `result` and `include_result` to `tasks/get` request/response (closes #3123)

  `tasks/get` had no typed field for the completion payload — buyers polling an async `create_media_buy` (or any submitted-arm task) could see `status: completed` but had no schema-backed path to retrieve `media_buy_id` and `packages`. The push-notification webhook schema already defined this pattern correctly (`result: $ref async-response-data.json`); the polling API simply never got the same field.

  **Schema changes (both additive, non-breaking):**

  - `static/schemas/source/core/tasks-get-response.json` — adds optional `result: $ref /schemas/core/async-response-data.json`. Present when `status` is `completed` and `include_result: true` was requested; absent otherwise. For `failed`/`canceled` tasks, sellers continue to use the existing `error` field — `result` is for the success terminal only. Mirrors the `result` field in `mcp-webhook-payload.json` so push and pull paths return the same payload shape.
  - `static/schemas/source/core/tasks-get-request.json` — adds optional `include_result: boolean` (default `false`). Signals that the caller wants the completion payload on the response.

  **Docs:**

  - `docs/protocol/calling-an-agent.mdx` — adds a completed `tasks/get` example showing the `result` field, closing the documentation gap identified in the issue.
  - `docs/building/implementation/task-lifecycle.mdx`, `async-operations.mdx`, `error-handling.mdx`, `orchestrator-design.mdx` — re-introduces `include_result: true` in the polling examples that patch #3127 stripped (now spec-backed by this PR's schema additions).

  Non-breaking: `result` is optional on both request and response. Sellers omitting it on non-completed tasks or on requests without `include_result: true` remain spec-conformant. Existing `adcp-client` consumers relying on informal `additionalProperties` passthrough continue to work; the typed field gives SDKs a stable, named field to key on.

  Unblocks adcp-client#967 (polling-cycle hardening).

- f45191b: spec: allow multi-tenant seller-agent operators to publish more than 20 `brand.json` `agents[]` entries and clarify per-tenant JWKS resolution.

  `brand.json` no longer caps `agents[]` at 20 entries, allowing one same-type sales-agent entry per tenant or property-scoped endpoint. The seller setup guidance now documents the A1 static-shard pattern: verifiers resolve keys from the authenticated agent URL to exactly one `agents[].url` entry, use that entry's `jwks_uri` or the default origin JWKS, and reject duplicate matching entries as ambiguous rather than selecting by agent `type` or request-payload tenant fields.

- 563eaf4: spec(tmp): add required `seller_agent_url` to `context_match_request`.

  The context-match request now carries `seller_agent_url`, matching the identity-match request's field shape and placement (PR #3687). The resolution semantics are deliberately actor-specific, not a mirror: on the context path the **provider** resolves the active package set it has **synced** for the asking seller, whereas on the identity path the **buyer agent** resolves the set it has **registered**. When `package_ids` is omitted, evaluation runs against that seller's full active set; a `seller_agent_url` the provider has not synced packages for MUST return an empty offer set rather than fall back to another seller's set.

  This reverses the prior decision (PR #3063's seller-attribution section) that kept seller identity off `context_match_request`. That section argued the provider already holds the sync-time `seller_agent` binding so the request field is redundant, and that putting seller on the context path opens a request-time filtering vector. In practice a provider serves many sellers and needs the asking seller's identity on the wire to scope its active-set resolution without a deployment-pinned constant — the same need the buyer agent has on the identity path, even though the actor and the set it resolves against differ. The decorrelation argument does not apply: `seller_agent_url` is a single stable value identifying the asking seller, identical for every user on a placement and carrying no user identity, so it adds no per-user signal that context and identity requests could be correlated on. The package-set decorrelation guarantee constrains per-user-varying data (`package_ids`), which is unchanged.

  Required, consistent with identity-match. `context_match_request` is `x-status: experimental`, so the added required field is permitted pre-stable.

  Files:

  - `static/schemas/source/tmp/context-match-request.json` — `seller_agent_url` property (string, uri) added to `properties` and to `required`.
  - `docs/trusted-match/specification.mdx` — §Seller Attribution "Placement rationale", the Router participant row, and the "What This Is Not" bullet rewritten so the normative text matches: both request types carry `seller_agent_url`; the package-side `seller_agent` remains attribution-only; neither may be used as a per-user filter.
  - `docs/trusted-match/{index,buyer-guide,context-and-identity,ai-mediation}.mdx` and `docs/trusted-match/surfaces/{web,mobile,ctv,ai-assistants,retail-media}.mdx` — request examples updated with `seller_agent_url`.
  - `tests/example-validation-simple.test.cjs` — both context-match request fixtures updated.

- 1e44c04: TMP Identity Match: add required `seller_agent_url` to the request and make
  `package_ids` optional.

  **Why.** The buyer's identity-match service already keeps the authoritative
  set of active packages it has registered per seller. Carrying that set on
  every request was redundant and forced publishers to enumerate ALL active
  packages on every call to avoid the set-correlation attack on Context
  Match. Identifying the seller by URL lets the buyer resolve the package
  set itself.

  **Changes to `static/schemas/source/tmp/identity-match-request.json`.**

  - New required field `seller_agent_url` (`string`, `format: uri`). The
    seller agent's API endpoint URL. Compared using the AdCP URL
    canonicalization rules, consistent with `seller_agent.agent_url` on
    `AvailablePackage` and `agent_url` in `adagents.json`.
  - `package_ids` is now optional. When omitted, the buyer evaluates against
    the full active set registered for `seller_agent_url`. When provided,
    the ALL-active-packages rule still applies — partial sets remain a
    correlation risk.
  - Top-level description updated to reflect both modes.

  **Spec changes alongside the schema.**

  - Reversed prior stance forbidding seller identity on `identity_match_request`. The "What This Is Not" / SellerAgentRef guidance has been narrowed to apply only to `context_match_request`.
  - Added a fail-closed rule: when `seller_agent_url` matches no seller for which the buyer has registered active packages, the buyer MUST return an empty `eligible_package_ids`, not fall back to another seller's set.
  - Defined precedence when both `seller_agent_url` and `package_ids` are present: buyer evaluates against the intersection of its registered active set and `package_ids`; unknown IDs are silently dropped (not error-surfaced) so the response cannot leak registry membership.
  - Reframed the package-set-decorrelation invariant as **statistical independence of `package_ids` from the current placement**, with two acceptable modes: all-active and fuzzed (random sample padded with synthetic non-existent IDs that the buyer silently drops). The page-specific subset remains forbidden.
  - Strengthened temporal decorrelation: random delay alone leaks the pairing through ordering. Publishers SHOULD also randomize whether Context Match or Identity Match is sent first — each opportunity SHOULD have a roughly equal probability either way.

  **Privacy boundary.** `seller_agent_url` identifies the seller agent, not
  the user; no leakage across the identity boundary. Routers do NOT strip
  it (unlike `country`) — buyers need it to resolve the package set.

  **Backwards compatibility.** Breaking for the experimental TMP schema
  (`x-status: experimental`): callers MUST now send `seller_agent_url`. The
  relaxation of `package_ids` is non-breaking on its own — previously valid
  requests remain valid as long as they also include `seller_agent_url`.

- cdfe3ad: Add an experimental verified-identity attestation surface to TMP Identity Match, letting a publisher (or a network/issuer-as-RP) forward a **verifiable** proof about a user — proof-of-personhood and/or age — so the buyer verifies the claim cryptographically instead of trusting an assertion. Issuer-agnostic; World ID is the first scheme.

  **Schema changes (additive):**

  - `enums/uid-type.json` — adds `world_id_nullifier` (Sybil-resistant, rp-scoped, unlinkable pseudonym; asserts nothing on its own — trust comes from the accompanying attestation).
  - `enums/attestation-claim.json` (new) — closed, issuer-agnostic claim set: `unique_human`, `age_over_13/16/18/21`. Age is threshold-only and resolves to eligibility, never a wire attribute.
  - `tmp/identity-match-request.json` — adds an optional `attestation` object per `identities[]` entry (`issuer`, `scheme`, `relying_party_id`, `action`, `claims[]`, `verification_level`, `signal_binding`, `proof`, `expires_at`) and an optional top-level `sealed_credentials[]` (`{audience_kid, payload}`, TMPX envelope) for the network-as-RP carrier. `issuer` is a vendor BrandRef (`core/brand-ref.json`, canonical domain) — the same vendor-reference shape as measurement/signals vendors; the relying party is namespaced by the issuer as `(issuer.domain, issuer.brand_id, relying_party_id)`.

  **Contract-bearing note:** `identity-match-request.json` is `additionalProperties: false` on purpose (the identity privacy boundary). These fields are a deliberate, reviewed widening — they carry proof _about_ the identity (identity side of the boundary), not page context. Shipped as `x-status: experimental`; not subject to deprecation cycles until 3.0.0 GA.

  **Conformance invariants (normative):** verify every accepted `scheme`; treat an unverifiable attestation as "no attestation", never as asserted-true; reject on failed `signal_binding`, `relying_party_id` provenance, or `expires_at`; decrypt only `sealed_credentials` whose `audience_kid` you hold; bound attestation + sealed-credential count/size.

  **Router handling of `sealed_credentials[]` (normative):** forward each entry only to the provider owning its `audience_kid` (not broadcast); fold `sealed_credentials` into the per-provider re-signature canonical bytes; include a `sealed_credentials_hash` in the dedup cache key.

  relying_party_id ownership is published in `brand.json` `identity_relying_parties[]`; age jurisdiction→threshold tables live in the AdCP Policy Registry and resolve to `eligible_package_ids`. Advertised via a new `trusted_match.verified_identity` experimental feature id. Full design: `specs/tmp-verified-identity-attestation.md`.

- 505cb4f: feat(trusted-match): scope the world_id_nullifier TMPX token to its relying party

  Register `world_id_nullifier` in the TMPX Type ID registry, and define its token as relying-party-scoped: a 16-byte digest of the proof's `relying_party_id` followed by the 32-byte nullifier.

  A World ID nullifier is meaningful only within the `rp_id` it was minted for, but the `rp_id` rides the request-side `attestation`, which does not round-trip into the `tmpx` exposure token. With only the bare nullifier in the token, the out-of-band impression tracker cannot attribute an exposure to its relying party or reconstruct the `(rp_id, nullifier)` key the buyer caps on. Embedding the `rp_id` digest closes that: the tracker matches the digest against the relying parties it accepts, keys frequency state on `(rp_id, nullifier)`, and no `rp_id` cleartext crosses into the token.

  Open (WG): the digest width (16 bytes proposed) and whether a digest-plus-registry lookup suffices versus carrying a registry-assigned relying-party id. `world_id_nullifier` is gated by the experimental `trusted_match.verified_identity` feature, so its token layout is not yet frozen.

- b44996f: spec(manifest): publish `manifest.json` + structured `enumMetadata` to stop SDK drift (adcp#3725)

  Adds two additive artifacts to every released schema bundle:

  1. **`enums/error-code.json` gains an `enumMetadata` block.** Every error code now carries structured `recovery` (correctable | transient | terminal) and `suggestion` fields. SDKs MUST consume this block instead of parsing `Recovery: X` prose out of `enumDescriptions`. A build-time lint rejects any drift between the structured value and the prose. Root cause for adcp-client#1135 (17 missing codes, 3 wrong recovery classifications shipped in TS SDK for over a year).
  2. **`manifest.json` at `/schemas/{version}/manifest.json` (and `/schemas/latest/manifest.json` for nightly codegen).** Single canonical artifact listing every tool (with `protocol`, `mutating`, `request_schema`, `response_schema`, `async_response_schemas`, `specialisms`), every error code (with `recovery`, `description`, `suggestion`), an `error_code_policy` block (defining `default_unknown_recovery` so SDKs handle non-spec codes from non-conforming sellers correctly), and every storyboard specialism (with `protocol`, `entry_point_tools`, `exercised_tools`). Validates against `/schemas/{version}/manifest.schema.json`. Generated deterministically from existing source — no new authored content. Lets SDKs derive their internal tool/error tables from one place at codegen time instead of hand-transcribing the spec.

  `mutating` is derived using the same classifier the idempotency-key lint enforces (single source of truth — manifest and lint can never disagree). The read-only verb pattern was tightened in the process: it now anchors at the start so tools like `create-collection-list` and `delete-property-list` are no longer mis-classified as read-only because they happen to contain `-list-` mid-name. `search-` was added as a read-only verb.

  Specialisms expose two distinct tool sets per #3725 review feedback: `entry_point_tools` (the curated minimal contract from `index.yaml.required_tools` — what the spec asserts implementers MUST ship) and `exercised_tools` (the full surface — union of own phases and every linked scenario, derived by walking `phases[].steps[].task` and resolving `requires_scenarios`). SDK authors should size their tool registration against `exercised_tools` to ensure they handle every call the conformance kit will make.

  Migration: SDKs targeting 3.0.x continue to work unchanged — `enumDescriptions` and the existing `index.json` are retained verbatim. SDKs targeting 3.1+ should switch to `enumMetadata` for error recovery and `manifest.json` for tool/specialism enumeration. The prose "Recovery: X" sentence embedded in each `enumDescriptions` value is stripped from the manifest's per-code `description` to avoid double-encoding; it remains in `enumDescriptions` for the human-readable narrative until a future minor formally deprecates it. Until then, the lint guarantees both surfaces stay synchronized.

- af1d287: spec(creative): add pre-call discriminators for creative-transformer refinement retention and fan-out multiplicity.

  Lets a buyer agent know — before sending — what a creative agent supports, instead of probing and handling failures. Additive and optional (all fields default to "unsupported / unbounded"), and the keystone the spend-control and conformance follow-ons build on.

  - `get_adcp_capabilities` → `creative.refinable_retention_seconds` (integer): the guaranteed-minimum window a produced `build_variant_id` stays refinable. Replaces the prose-only "agent-defined window" with a machine-readable floor; omit to keep it agent-defined.
  - `get_adcp_capabilities` → `creative.multiplicity` (object): `supports_catalog_fanout` + `max_creatives_limit`, `supports_variants` + `max_variants_limit`, and `variant_dimensions[]`. Over-limit `max_creatives`/`max_variants` are **clamped** to the ceilings (shortfall via `items_returned` < `items_total`), not rejected — consistent with `item_limit`'s "use the lesser" rule. Absent means no fan-out.
  - `transformer.json` → optional `multiplicity` that narrows the agent-level object per transformer (ceilings ≤ agent, `variant_dimensions` ⊆ agent).
  - `build_creative` docs note the clamp behavior on `max_creatives`/`max_variants`.

- 1652b93: Unify metric accountability into a single timestamped contract array
  covering both standard and vendor-defined metrics. Reshapes
  `package.committed_metrics` and `by_package.missing_metrics` from
  string arrays to discriminated object arrays. Closes the audit gap
  for vendor metrics (#3519), adds mid-flight contract amendments
  (#3518), and supersedes the parallel-array design that shipped
  hours ago in #3510.

  **Why a unified shape.** AdCP had grown five different metric adjectives
  (`available`, `required`, `committed`, `requested`, `missing`) across
  two parallel surfaces (standard via the closed `available-metric.json`
  enum; vendor via the structured `vendor_metric_extensions`). The contract
  layer (committed/missing) is the right place to unify because:

  1. Buyer's reconciliation code is simpler — one array walk, one shape
  2. The contract is the "agreement reached" — it doesn't matter where
     the metric came from (closed enum vs vendor extension)
  3. Audit is symmetric — `missing_metrics` covers everything that was
     committed but not delivered, regardless of metric scope
  4. Mid-flight amendments fit naturally — every entry is timestamped, so
     day-1 commitments and mid-flight additions share one shape

  The capability layer (`reporting_capabilities.available_metrics` and
  `vendor_metrics`) stays separate — capabilities use the closed vocabulary
  upstream, contracts use the unified shape because they need timestamps
  and vendor scoping.

  **Schemas added.**

  - `enums/metric-scope.json`: discriminator enum `["standard", "vendor"]`.
    Tags entries in unified metric arrays so consumers can branch on a
    literal string instead of inferring from field presence. Matches the
    existing AdCP discriminator pattern (`refinement_applied`,
    `incomplete[].scope`).

  **Schemas reshaped.**

  - `core/package.json` `committed_metrics`: was `string[]` from
    `available-metric.json` enum + parallel `committed_vendor_metrics`
    array. Now a single `[{scope, metric_id, vendor?, committed_at}]`
    array covering both. Each entry carries an explicit `committed_at`
    timestamp, so the array also serves as the contract amendment ledger.
    Day-1 entries share `committed_at = create_media_buy.confirmed_at`;
    mid-flight additions appended via `update_media_buy` carry their own
    timestamps. Append-only — sellers MUST reject attempts to modify or
    remove existing entries with `validation_error` (suggested code:
    `IMMUTABLE_FIELD`). The standalone `committed_vendor_metrics` field
    is **deleted**; vendor entries now live in the unified array with
    `scope: "vendor"`.
  - `media-buy/get-media-buy-delivery-response.json`
    `by_package[].missing_metrics`: was `string[]`. Now
    `[{scope, metric_id, vendor?}]`, symmetric with `committed_metrics`
    minus the timestamp (the audit channel doesn't need to carry the
    commitment time; it filters by it).
  - `missing_metrics` reconciliation rule: filters `committed_metrics`
    to entries where `committed_at < reporting_period.end`, then flags
    any not populated in the report. A metric committed mid-flight is
    audited only from its commitment timestamp forward — matches the
    IAB Open Measurement §4.3 precedent for accountability boundaries
    when measurement starts mid-flight.

  **Measurement-standard qualifier on standard entries.** Standard-scope
  entries on `committed_metrics` and `missing_metrics` MAY carry an
  optional `qualifier` object disambiguating metrics whose definition
  varies by measurement standard. v1 defines a single qualifier key —
  `viewability_standard` (`mrc` | `groupm`) — required when the seller
  commits to a specific viewability standard for any of
  `viewable_impressions`, `viewable_rate`, `measurable_impressions`.
  Without it the contract is ambiguous (MRC and GroupM are materially
  different thresholds and not comparable, see
  `viewability-standard.json`) and reconciliation falls back to whatever
  `viewability.standard` the delivery report happens to carry. Symmetric
  on `missing_metrics`: a buyer expecting MRC viewability flags a
  GroupM-only delivery report as missing the MRC commitment. The
  qualifier object is closed (`additionalProperties: false`) so future
  qualifiers — completion threshold, reach unit — get added explicitly
  in subsequent minors rather than via free-form keys. Emerged from a
  field discussion where a partner proposed an `ext`-level viewability
  rollup at root `aggregated_totals`; the right place to handle
  standard-disambiguation is the contract entry, not the aggregate.

  **Vendor metric accountability scope.** PR #3492 deliberately scoped
  vendor metrics as advisory in v1 ("buyers verify out-of-band via
  `measurable_impressions` coverage"). With this PR, the
  advisory-vs-accountable distinction moves to the contract layer
  rather than the metric scope: any metric (standard or vendor) that
  appears in `committed_metrics` is accountable. Sellers who can't
  credibly attest to a vendor metric SHOULD NOT stamp it; absence keeps
  that metric advisory and reconciliation falls back to coverage plus
  out-of-band verification.

  **Closes/supersedes.**

  - Closes #3518 (mid-flight amendments — every entry has its own
    `committed_at`, so amendments are just new entries; no separate
    `additional_committed_metrics` array needed)
  - Closes #3519 (vendor-metric audit symmetry — vendor entries live in
    the unified `missing_metrics` array; no separate
    `missing_vendor_metrics` field needed)
  - Supersedes the parallel-array design from #3510. The `string[]`
    shape introduced there merged hours before this PR and had zero GA
    adopters; the breaking change is taking advantage of the open window
    to land the cleaner final shape before adoption hardens.

  **Wired in.**

  - `core/package.json`: reshape `committed_metrics`, delete
    `committed_vendor_metrics`.
  - `media-buy/get-media-buy-delivery-response.json`: reshape
    `missing_metrics` and update the description to declare the
    reconciliation rule (`committed_at < reporting_period.end`).
  - `enums/metric-scope.json`: new shared discriminator.
  - `docs/media-buy/task-reference/create_media_buy.mdx`: rewrite the
    "Reporting contract on confirmed packages" section with a worked
    example showing day-1 + mid-flight entries and the
    `qualifier.viewability_standard` on viewability metrics.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: update
    `missing_metrics` bullet with the discriminated-shape example
    and the qualifier-symmetric reconciliation note.
  - `docs/media-buy/media-buys/optimization-reporting.mdx`: update the
    Vendor-Defined Metrics section to reflect that the
    advisory-vs-accountable distinction now lives at the contract layer
    (any committed metric is accountable, regardless of scope).

  **Backwards compatibility.** Both `committed_metrics` and
  `missing_metrics` are optional. The fields landed in #3472 and #3510
  hours before this PR with `string[]` shape; that shape is now
  replaced with a discriminated object array. Adopters who jumped on
  the `string[]` shape immediately need to update; this is judged
  acceptable given the field's optional status, the absence of any GA
  implementations, and the meaningful improvement in the final
  conceptual model.

  **WG review.** This PR involves a v1.x scope shift on vendor-metric
  accountability and a breaking reshape of two newly-merged optional
  fields. Worth WG visibility before merge.

  Refs #3518, #3519. Builds on #3472, #3492, #3510.

- 2f88e59: Document the normative attestation-mode selection rule for upstream_traffic compliance checks.

  Conforming runners now have one explicit raw-vs-digest decision order for query_upstream_traffic that preserves assertion coverage, including the non-JSON identifier_paths case where raw mode is required to avoid grading an otherwise evaluable assertion as not_applicable. Storyboard authors should rely on that rule instead of non-schema attestation-mode hints.

  Closes #5080.

- f6af651: spec(url-asset): add SHOULD on `url_type`, role-based fallback, and mechanism-vs-purpose clarification (#2986 step 2)

  `url_type` was optional with no fallback rule, so a conformant URL asset that omitted it left receivers guessing — buyers would either pick a default mechanism (with bad blast-radius if a clickthrough fired as a pixel) or refuse to render. Two parallel vocabularies (`url-asset-type` mechanism: 3 values; `url-asset-requirements.role` purpose: 6 values) compounded the confusion because the docs treated them as the same thing.

  This change:

  - Adds a top-level description on `url-asset` stating senders SHOULD include `url_type` on every URL asset, and defining the receiver fallback: when `url_type` is absent, receivers SHOULD fall back to the format's `url-asset-requirements.role` (clickthrough/landing_page → `clickthrough` mechanism; \*\_tracker roles → `tracker_pixel`); when neither is present, receivers MAY reject rather than guess.
  - Updates the `url_type` property description to frame it explicitly as the receiver's invocation mechanism, and points at the role fallback for senders that omit it.
  - Updates `url-asset-requirements.role` description to call out the mechanism-vs-purpose distinction (a `click_tracker` slot validly accepts a `tracker_pixel` URL).
  - Rewrites `docs/creative/asset-types.mdx` URL Asset section, replacing the old "you only need to supply the `url` value" guidance and the incorrect enum list (`impression_tracker`/`video_tracker`/`landing_page` — those were the requirement-side `role` values, not `url_type` values) with the actual `clickthrough`/`tracker_pixel`/`tracker_script` enum, the SHOULD note, and the role fallback table.

  Wire format unchanged. Existing senders that already include `url_type` are unaffected. Senders that omit `url_type` continue to validate but now have explicit receiver semantics; in 4.0 we plan to make `url_type` required (separate change). Closes step 2 of the rollout proposed on adcp#2986.

- 9c087a2: feat(creative): v2 Phase 1 — asset_group_id vocabulary registry, `scenes` schema, `zip` asset type, video/audio mdx asset_type fixes

  First PR implementing the v2 creative formats RFC (#3305). Backwards-compatible additions only — no v1 producers are affected. Minor bump because this introduces new schemas (`asset-group-vocabulary.json`, `scenes.json`, `zip-asset.json`), which are additive features rather than bug fixes.

  **New schemas:**

  - `static/schemas/source/core/asset-group-vocabulary.json` — canonical registry of `asset_group_id` values (the seven existing catalog vocab entries plus 12 audit-driven additions: `video_vertical`, `video_horizontal`, `audio`, `companion_image`, `companion_banner`, `brand_name`, `body_text`, `cards`, `landing_page_url`, `privacy_policy_url`, `youtube_video_id`, `pin_id`). Includes the `landing_page_url` aliases canonicalizing six different field names today (`click_url`, `link`, `final_url`, `link_url`, `click_through_url`, `landing_url`). Non-canonical IDs remain valid for platform-specific extensions; validators MAY soft-warn on non-canonical usage.

  - `static/schemas/source/creative/scenes.json` — typed scene-by-scene structure used as input to `build_creative` for generative video platforms. Each scene has `order`, `duration_ms`, `description`, optional `vo` and `caption`. Renamed from "storyboard" to avoid collision with the testing-harness storyboard concept; description disambiguates from `reference-asset.json` `purpose: "storyboard"` (which describes a reference asset, not a structured plan).

  - `static/schemas/source/core/assets/zip-asset.json` — new asset type for bundled creatives delivered as zip archives (HTML5 banners with index.html + CSS + JS + images, MRAID-compatible interactive ads). Carries `url`, optional `max_file_size_kb`, `entry_point`, `allowed_inner_extensions`, `backup_image_url`, and SHA-256 `digest` for integrity. Distinct from inline HTML (`html` asset) and from third-party tag URLs (`url` asset with appropriate `url_type`).

  **Registry updates:**

  - `static/schemas/source/creative/asset-types/index.json` — added `zip` entry pointing at the new schema
  - `static/schemas/source/core/format.json` — added `IndividualZipAsset` and `GroupZipAsset` branches to the format declaration oneOf
  - `static/schemas/source/core/offering-asset-group.json`, `creative-manifest.json`, `creative-asset.json`, `creative/list-creatives-response.json` — added `zip-asset.json` to manifest/asset-group oneOf branches so manifests can carry zip assets

  **Doc fixes:**

  - `docs/creative/channels/video.mdx` — corrected three format-definition examples that used `asset_type: "url"` + `asset_role: "vast_url"` / `"vpaid_url"`, contradicting the schema-correct `asset_type: "vast"` used elsewhere in the same file. Updated VPAID examples to use `asset_type: "vast"` with `vpaid_enabled: true` in requirements.
  - `docs/creative/channels/audio.mdx:200` — same bug pattern: `asset_type: "url"` for what should be a VAST audio tag. Corrected to `asset_type: "vast"` with `delivery_type: "url"`; renamed slot key from `vast_url` to `vast_tag` for clarity.

  **Why minor (not patch):** new schemas and a new asset type are additive features — patch is reserved for bug fixes only. **Why not major:** no breaking changes; v1 producers and consumers continue to work unchanged. The new `zip` asset type is purely additive — receivers that don't recognize it ignore it via standard discriminator-mismatch handling.

  Tracks #3305 (v2 RFC). Phase 1 lays foundational primitives; subsequent phases build the canonical format catalog, `ProductFormatDeclaration` schema, and tools on top of these primitives.

- 25131af: Add optional storyboard validation ids and require runners to echo them in
  validation results for stable per-assertion diagnostics.
- b4471ce: Add `vast_tracker` and `daast_tracker` asset types for decomposed VAST/DAAST `<TrackingEvents>` URLs. Creative agents can now emit per-event tracker URLs (start, quartiles, complete, etc.) as a discriminated-union alternative to a complete VAST tag; the sales agent assembles them into the VAST `<TrackingEvents>` block at serve time. Adds normative creative/sales boundary: wrapper ownership belongs to the sales agent, and the `<Impression>` URL stays on `url` asset with `url_type: "tracker_pixel"` (not `vast_tracker` with `vast_event: "impression"`).

  **Tracker asset constraints (from authoritative spec):**

  - `offset` pattern aligns with the VAST 4.2 XSD `Tracking@offset` constraint (`vast_4.2.xsd` line 146): `HH:MM:SS[.mmm]` with two-digit hours and minutes/seconds 00–59, or an integer percentage 0–100 suffixed with `%`. Negative offsets are not permitted — the VAST XSD pattern has no leading-minus branch.
  - A JSON Schema `if/then` requires `offset` whenever `vast_event` / `daast_event` is `progress` (mirrors the XSD documentation: "Must be present for progress event").
  - `vast_event` / `daast_event` exclude both VAST/DAAST element-children that don't live under `<TrackingEvents>` (`impression`, `clickTracking`, `customClick`, `error`) and `<ViewableImpression>`-element children (`viewable`, `notViewable`, `viewUndetermined`, `measurableImpression`, `viewableImpression`).
  - Each tracker carries a `target` field (`linear` | `non_linear` | `companion` for VAST; `linear` | `companion` for DAAST, since DAAST has no `<NonLinearAds>` element) so the sales agent places the tracker under the correct `<TrackingEvents>` parent during XML assembly.

  **Tracking-event enum corrections (corrective alignment to spec):**

  - VAST: add the five VAST 4.2 events that were missing from `vast-tracking-event.json` (`acceptInvitation`, `adExpand`, `adCollapse`, `minimize`, `overlayViewDuration` — all in the XSD enumeration). Drop `notUsed`, which was incorrectly inherited from earlier draft work and is not in the VAST 4.2 XSD `Tracking@event` enumeration. `fullscreen` / `exitFullscreen` are kept and labeled as VAST 2.x / 3.x compat.
  - DAAST: add `rewind` (DAAST 1.1 §3.2.1.7 lists it explicitly). Drop `loaded`, which is not in DAAST 1.1 §3.2.1.7. `progress` is retained per DAAST 1.1 §3.2.4.3.

  These enum corrections are nominally breaking for the existing `tracking_events` field on the `vast` / `daast` asset types, but the dropped values were never spec-correct (`notUsed` is not in the VAST 4.2 XSD; `loaded` is not in DAAST 1.1 §3.2.1.7) — fixing them up before the new tracker assets reference these enums avoids carrying the inconsistency forward.

- 1431b6e: Add vendor-defined metric extensions — a structured pointer surface for
  proprietary measurement metrics (attention scores, emissions per impression,
  panel-based demographics, brand-lift surveys, in-flight attention panels)
  that don't belong in the closed `available-metric.json` enum. Resolves the
  closed/open enum question raised in #3460 with a structured surface instead
  of opening the standard vocabulary to free-form strings.

  **Why a parallel surface, not opening the enum.** Opening the closed enum
  to free-form strings (e.g., `x_*` prefixed) would solve the asymmetry with
  `delivery-metrics.json`'s `additionalProperties: true` posture but defeats
  discovery: a buyer asking "I need attention measurement" can't query a
  flat string namespace where every vendor uses a different name. A
  structured extension gives the buyer a queryable axis — `vendor` (BrandRef)
  — with `metric_id` as a second pin once vendors converge.

  **Why the surface is intentionally thin.** Per-product extensions carry
  only what the seller can credibly attest to: "I support this vendor's
  metric." Everything else — category, methodology, standard alignment,
  human-readable documentation, agent capabilities — is a property of the
  vendor's metric definition, published once at the vendor's `brand.json`
  `agents[type='measurement']` and queried out-of-band. Re-asserting that
  metadata on every seller's extension is duplication that drifts.

  **Schemas added.**

  - `core/vendor-metric-id.json`: shared identifier schema (analogous to
    `core/brand-id.json`) — lowercase pattern, length bounds, namespaced
    semantics. Reused by the declaration site, the value site, and the
    filter site.
  - `core/vendor-metric-value.json`: the reported value
    `{ vendor, metric_id, value, unit?, measurable_impressions?, breakdown? }`.
    `measurable_impressions` is the coverage denominator (vendor measurement
    is rarely 100% — vendors only score impressions where their SDK fires
    or their panel matches). Absence means coverage is unspecified; do NOT
    compute a coverage rate or assume full coverage when absent. The
    `breakdown` slot is the only escape hatch for structured payloads
    beyond a single scalar (panel demographic breakouts, co-view ratios,
    incremental decompositions); the rest of the envelope is closed
    (`additionalProperties: false` on the value object). This pattern
    parallels the existing `viewability.measurable_impressions` field.

  **Wired in.**

  - `core/reporting-capabilities.json`: new `vendor_metrics` array (parallel
    to `available_metrics`). Semantic uniqueness key is
    `(vendor.domain, vendor.brand_id, metric_id)`; sellers MUST NOT declare
    the same vendor metric twice. JSON Schema `uniqueItems` is not used
    because BrandRef carries optional fields whose absence/presence would
    defeat deep-equal — uniqueness is enforced at build/validation time on
    the semantic key.
  - `core/product-filters.json`: new `required_vendor_metrics` filter — each
    entry pins `vendor` and/or `metric_id`. Cross-vendor discovery (e.g.,
    "any attention measurement") is the buyer agent's responsibility: the
    agent resolves which vendors offer a category via the vendors'
    `brand.json` records, then enumerates them as filter entries. Same
    filter-not-fail convention as the other `required_*` filters.
  - `core/delivery-metrics.json`: new `vendor_metric_values` array — emitted
    alongside standard scalars on every level that uses delivery-metrics
    (totals, by_package, by_creative, by_audience, etc.). One row per
    `(vendor.domain, vendor.brand_id, metric_id)` per reporting period.
    The parent `additionalProperties: true` is preserved so existing
    free-form vendor emissions remain conformant during migration.
  - `docs/media-buy/task-reference/get_products.mdx`: new filter row.
  - `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: new
    `vendor_metric_values` bullet under per-package fields.
  - `docs/media-buy/media-buys/optimization-reporting.mdx`: new
    Vendor-Defined Metrics section covering declaration, the brand.json
    discovery anchor for vendor-side metadata, the filter shape and
    cross-vendor discovery responsibility, the value emission shape with
    the coverage denominator, the standards-driven promotion path, and the
    v1 accountability scope.

  **v1 accountability scope.** Standard `available_metrics` are subject to
  the `missing_metrics` contract from #3472. Vendor metrics are advisory in
  v1 — buyers verify out-of-band via `measurable_impressions` coverage and
  direct calls to the vendor's measurement agent. The asymmetry reflects
  what the seller can credibly attest to: SSPs typically don't have
  proprietary measurement numbers in their delivery pipeline; those flow
  from the vendor's own infrastructure.

  **Promotion path.** When the industry converges on a metric via a
  published standard, the spec adds it to the closed `available-metric.json`
  enum and the vendor extensions become historical aliases. Anchored on
  standards-body publication, not vendor-count thresholds.

  **Backwards compatibility.** All additions are optional. Sellers without
  vendor metrics see no change. The closed `available-metric.json` enum is
  unchanged. `additionalProperties: true` is preserved on
  `delivery-metrics.json` so existing free-form vendor emissions remain
  conformant; the structured `vendor_metric_values` array is the
  recommended path going forward.

  Refs #3460. Closes the closed/open enum question.

- 952787c: Add vendor_metric optimization-goal storyboard coverage (issue #4933). New storyboard exercises the 3.1 vendor_metric goal contract: positive acceptance when all preconditions are met, and negative paths for capability mismatch and reporting-coherence mismatch. Training-agent fixtures now surface vendor_metric_optimization on products.
- fb01678: Add `kind: "vendor_metric"` optimization goal — end-to-end buyer→seller→vendor binding for vendor-attested measurement (attention, brand lift, emissions, retail-media partner metrics). Closes #4644.

  **The problem.** The `metric` kind's enum had `attention_seconds` and `attention_score` as if they were seller-native metrics — but DoubleVerify, IAS, Adelaide, TVision, and Lumen each define attention differently with no MRC-or-equivalent shared standard. A buyer setting `{ metric: "attention_seconds" }` was asking a meaningless question — _whose_ attention model? The seller had to guess, and delivery reconciliation against `vendor_metric_values[]` (which IS vendor-keyed) couldn't close the loop.

  **The fix — three additions that mirror existing patterns:**

  1. **`kind: "vendor_metric"` on `optimization-goal.json`** — third oneOf branch, structurally parallel to the existing `event` kind (which binds buyer-attested conversion events). Shape:

     ```json
     {
       "kind": "vendor_metric",
       "vendor": { "domain": "adelaidemetrics.com" },
       "metric_id": "attention_score",
       "target": { "kind": "threshold_rate", "value": 70 },
       "priority": 1
     }
     ```

     `vendor` is the same BrandRef shape used on `vendor_metric_values.vendor`, `reporting_capabilities.vendor_metrics[].vendor`, and `performance_standards.vendor` — symmetric across discovery, capability, commitment, optimization, and reporting surfaces. `metric_id` is the same `vendor-metric-id` reference used on the reporting side. Targets are `cost_per` and `threshold_rate` (no `maximize_value` — that's monetary-only).

  2. **New `core/vendor-metric-optimization.json` capability schema** — product-level declaration of which `(vendor, metric_id)` pairs the product's bidding stack can steer toward, with `supported_targets` per pair. Referenced from `product.json` alongside `metric_optimization` and `reporting_capabilities`. Per-product, not per-seller, because measurement integrations vary by inventory (premium CTV may have DV attention integrated; remnant display won't).

  3. **Three-precondition rejection rule.** Sellers MUST reject `vendor_metric` goals failing any of:

     - **Discovery** — `metric_id` is in the vendor's published `measurement.metrics[]` catalog.
     - **Capability** — `(vendor, metric_id)` is in the product's `vendor_metric_optimization.supported_metrics[]`, and `target.kind` is in the matching entry's `supported_targets`.
     - **Reporting coherence** — the package's `committed_metrics[]` includes a matching `{ scope: "vendor", vendor, metric_id }`. **Optimization without committed reporting is unverifiable** — the buyer can't grade the seller against a goal whose value isn't contractually reported. This precondition is what makes vendor-attested optimization meaningful at the wire level.

  **The deprecation.** `attention_seconds` and `attention_score` remain in the `metric` enum on `optimization-goal.json` and on `product.json` `metric_optimization.supported_metrics` for backwards compatibility this minor, marked **deprecated** in their descriptions. Slated for removal at the next major. Sellers MAY reject the deprecated values with `TERMS_REJECTED` and a pointer to the `vendor_metric` kind. Same deprecation pattern used elsewhere (e.g., `delivery_measurement.provider` → `vendors[]`).

  **What this unblocks.** The same `vendor_metric` shape generalizes to:

  - Panel-based brand lift (Kantar, Upwave, Cint)
  - Emissions optimization (Scope3, Good-Loop)
  - Retail-media partner metrics (Amazon, Walmart Connect, Criteo)
  - Any future vendor-attested measurement that adopters want as an optimization target

  **Symmetry summary** — same `(vendor, metric_id)` key across every surface:

  | Surface                   | Field                                                          | What it asserts                                             |
  | ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
  | Discovery                 | Vendor's `get_adcp_capabilities.measurement.metrics[]`         | "This metric exists in my catalog"                          |
  | Capability — reporting    | Product's `reporting_capabilities.vendor_metrics`              | "This product can report this vendor metric"                |
  | Capability — optimization | Product's `vendor_metric_optimization.supported_metrics` (new) | "This product's bidder can steer toward this vendor metric" |
  | Commitment                | Package's `committed_metrics` (scope: vendor)                  | "I commit to reporting this for this package"               |
  | Optimization              | Package's `optimization_goals` (kind: vendor_metric) (new)     | "Steer delivery toward this for this package"               |
  | Accountability            | Package's `performance_standards.vendor`                       | "I commit to a threshold on this metric"                    |
  | Delivery — value          | `vendor_metric_values`                                         | "Here's what was measured"                                  |
  | Delivery — missing        | `missing_metrics` (scope: vendor)                              | "I committed but couldn't deliver"                          |

  **Backwards compatibility.** Additive — new schema, new oneOf branch, new optional product field, deprecated-but-still-valid enum values. Existing 3.x agents continue to validate. Buyers adopting `vendor_metric` need the matching seller-side capability + commitment in place; the three-precondition rule prevents silent acceptance of orphaned goals.

  **Doc updates.** New `kind: vendor_metric` section in `docs/media-buy/conversion-tracking/index.mdx` (alongside `kind: event` and `kind: metric`); Target Kinds and Choosing a Strategy tables updated; migration doc reflects deprecation routing.

  Opened as draft for a 7-day WG comment window before merge — measurement vendors (DV/IAS/Adelaide/Kantar/Scope3) invited to raise extension needs (e.g., `qualifier` slots for vendor sub-models) while the shape is still flexible.

  Closes #4644.

- d3351cc: Brand protocol gains `verify_brand_claim` — a unified brand-agent task that lets partners ask the brand authoritatively whether a specific claim about its identity is true. One tool, four claim types discriminated by `claim_type`:

  - `subsidiary` — "Is this brand a subsidiary of yours?" (house-side)
  - `parent` — "Is this brand your parent house?" (leaf-side mirror, lets mutual assertion complete at the agent layer)
  - `property` — "Is this site / app / property one of yours?"
  - `trademark` — "Is this trademark yours?"

  The shared `VerificationStatus` enum (`owned`, `pending_review`, `transferring`, `disputed`, `not_ours`, `licensed_in`, `licensed_out`, `unknown`) captures the rich state surface crawl-based mutual-assertion can't express. Per-claim-type `details` field carries the typed response payload. Public/authorized tier split mirrors `get_brand_identity`.

  **Trust model is asymmetric by direction.** Signed rejections (`disputed` / `not_ours`) win unilaterally — a brand has standing to refuse association without reciprocation. Signed assertions (`owned` / `pending_review` / `transferring` / `licensed_*`) do NOT bypass mutual assertion — the reciprocating side must still confirm. When both sides have brand-agents, mutual assertion completes via two signed agent calls (subsidiary + parent claim types) without requiring a static-file crawl. Closes the malicious-house scenario: a brand can't unilaterally claim subsidiaries it doesn't own.

  **Cross-protocol Conformance addition to `brand.json`:** when a house publishes a brand-agent advertising `verify_brand_claim` with the relevant claim type, consumers SHOULD prefer the agent's signed response over crawl-based inference. The crawl path remains the fallback when the agent is unreachable or returns `unknown`. The email-notification SHOULD from PR #4505 continues to apply for houses without a brand-agent.

  **Schema additions:**

  - `brand/verification-status.json` — shared status enum
  - `brand/verify-brand-claim-request.json` — schema-level `discriminator: { propertyName: "claim_type" }` with four per-claim-type variants
  - `brand/verify-brand-claim-response.json` — `claim_type` echoed, `status` from the shared enum, per-claim-type `details` object

  **No changes to `brand.json` itself.** Additive — every existing publisher and every existing brand-agent continues to work unchanged. The single-tool design preserves AdCP's tool-count economy: new claim types (e.g., licensed_from, endorsement) are payload-discriminator additions, not new tools.

  Standing licensed relationships as a static brand.json publishing surface (parallel to `brand_refs[]` for ownership) remain out of scope and are tracked as a separate design alongside the rights-protocol team. `verify_brand_claim` exposes the licensed states via the brand-agent's internal records; the static-file substrate that backs them is a future RFC.

- e22385c: Brand protocol gains `verify_brand_claims` — the bulk variant of `verify_brand_claim`. Same four claim types (`subsidiary`, `parent`, `property`, `trademark`), same per-claim semantics, one MCP round-trip and one rate-limit slot for up to 100 claims. Use when a caller (crawler refreshing a brand portfolio, creative-clearance pipeline batch, inventory-onboarding scan) needs to verify many claims against one brand-agent and per-call overhead dominates.

  **Sibling tool, not a mode flag.** `verify_brand_claim` stays as-is for one-off verifications; `verify_brand_claims` is the dedicated bulk surface. Cleaner schemas (no single-vs-bulk discriminator inside one tool), cleaner capability advertisement (each tool is advertised independently in `supported_tasks`), cleaner error semantics (per-result errors don't mix with single-target failures).

  **Order is preserved.** Agents MUST return `results[]` in the same order as the request's `claims[]` (positional zip-by-index). Callers pass a position-indexed batch and consume results by index.

  **Partial-failure semantics.** Per-claim failures (`UNSUPPORTED_CLAIM_TYPE` for one item, `AMBIGUOUS_MATCH` on one trademark query) ride on a per-result `error` field and do NOT fail the batch. Top-level `errors[]` is reserved for batch-level failures (auth, rate-limit, malformed request, over-cap claim count) — when set, `results` is absent. The two are mutually exclusive at the wire.

  **Caching.** Top-level `Cache-Control: max-age` represents the lowest-common max-age across the batch. Per-result staleness varies by status; callers needing finer cache control should split batches by expected volatility or re-verify volatile claims individually.

  **Rate-limiting.** A bulk call consumes one rate-limit slot per call, not per result. A batch of 100 hits the per-`{caller, query-target}` limit once. Agents SHOULD size bulk limits in calls/window when bulk is advertised.

  **Trust model unchanged and unshortened.** Mutual assertion still requires calling both sides — a `subsidiary` result returning `owned` inside a bulk batch still requires a separate `parent` call against the leaf-side agent. Bulk is round-trip economy, not a trust-model shortcut.

  **Schema additions:**

  - `brand/verify-brand-claims-request.json` — `claims[]` array with the per-item discriminator on `claim_type`. Max batch size 100; agents MAY enforce lower.
  - `brand/verify-brand-claims-response.json` — success arm carries `results[]` aligned to the request; per-result success mirrors `verify-brand-claim-response.json` success arm, per-result error carries an `error` field. Error arm carries batch-level `errors[]`.

  **No changes to `verify_brand_claim`.** Single-target tool ships unchanged; the bulk variant is purely additive. Capability advertisement is per-tool — agents MAY ship one, the other, or both. A `supported_claim_types` declaration applies to both tools when both are advertised.

- 6eadf06: spec(versioning): release-precision protocol version negotiation via `adcp_version` envelope field

  Adds `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level field on every request and response. Buyers send their release pin; sellers echo the release they actually served — never the seller's own latest release. Augments the existing `adcp_major_version` (integer) with finer precision and adds response-side echo, which the spec lacked.

  Composed once via `allOf $ref` to the new `core/version-envelope.json` schema (single source of truth across all 127 task schemas — no inline duplication).

  Capabilities response gains `adcp.supported_versions` (release strings, authoritative for negotiation) and `adcp.build_version` (full semver build identifier with optional pre-release and build-metadata per semver §9–§10, advisory only). `VERSION_UNSUPPORTED` error gets a standardized `error.data` shape via the new `error-details/version-unsupported.json` schema; `supported_versions` is required.

  Migration: spec stays SHOULD on both sides through all of 3.x (consistent with the 3.x stability guarantee that fields don't graduate optional → required within a major). The compliance grader carries the adoption pressure: advisory at 3.1, blocking failure at 3.2 for sellers that don't echo `adcp_version` or don't emit `supported_versions` on capabilities. 4.0 promotes the spec to MUST and removes `adcp_major_version`, `adcp.major_versions`, and `extensions.adcp.adcp_version`. Through 3.x, buyers SHOULD dual-emit both `adcp_version` and `adcp_major_version` so legacy 3.x sellers keep negotiating; when the two disagree at the major level the server MUST return `VERSION_UNSUPPORTED`.

  Fully additive on the wire (existing servers ignore `adcp_version` via `additionalProperties: true`). RFC: `specs/version-negotiation.md`.

  **One scoped behavior change in 17 request schemas:** the `allOf $ref` envelope-composition pattern requires permissive `additionalProperties` at root (draft-07 doesn't bypass parent strict-mode through `allOf`). 17 request schemas under `collection/`, `governance/`, `property/`, and `tmp/` previously declared `additionalProperties: false`; this PR flips them to `true` so the envelope's fields are accepted. Strict request validation returns at draft 2019-09 via `unevaluatedProperties: false` (tracked in #3534). The new lint at `tests/lint-version-envelope.test.cjs` enforces the invariant going forward.

- 4ad0e82: Add `video_placement_types` declarations to products and placements, plus a matching `get_products.filters.video_placement_types` discovery filter, using IAB Tech Lab/OpenRTB 2.6 video placement definitions with AdCP-native field names.
- 7a48ee4: Webhooks are signed with the agent's `request-signing` key — there is no separate webhook key purpose. The webhook verifier checklist (step 8) now accepts `adcp_use == "request-signing"` as canonical, with the deprecated `"webhook-signing"` still accepted for backward compatibility (removal tracked in adcontextprotocol/adcp#5555). Operators that want separate key material for webhooks publish a second `"request-signing"` key with a distinct `kid` and sign webhooks with it — key isolation comes from the `kid`, not a distinct `adcp_use`. Any other key-purpose failure — `"response-signing"`/`"governance-signing"`, absent `adcp_use`, or a missing `verify` key_op — is rejected with `webhook_signature_key_purpose_invalid`. `webhook_mode_mismatch` is unchanged and remains reserved for the HMAC-vs-9421 auth-mode selector mismatch.

  The relaxation is one-directional and safe: cross-protocol confusion is prevented by the RFC 9421 `tag` (`adcp/webhook-signing/v1`, part of the signed base, checked at step 3) and mandatory `content-digest` coverage — not by the key-purpose discriminator. A captured request signature carries `tag=adcp/request-signing/v1` and is rejected at step 3, so it can never be replayed as a webhook. The reverse remains forbidden: a webhook-signing key MUST NOT verify a request signature (request verification still requires `adcp_use == "request-signing"` exactly).

  Conformance vectors updated: former negative `webhook-signing/negative/008-wrong-adcp-use` (request-signing key rejected) becomes positive `webhook-signing/positive/008-request-signing-key-reuse` (accepted); a new negative `008-wrong-adcp-use` covers a `response-signing` key, still rejected.

  Semver note: this is `minor` because it widens verifier acceptance and deprecates the old key purpose without removing any wire-compatible signer or verifier behavior. The future removal of `"webhook-signing"` from the accepted webhook key-purpose set is tracked in adcontextprotocol/adcp#5555 and will be a major-version change.

- 6fcedae: Adds webhook receiver envelope conformance coverage for delivery reporting webhooks.

  - Adds `media_buy_delivery` as the task type for persistent delivery-report webhook events.
  - Extends `async-response-data` with the payload-only delivery-report result shape used under `mcp-webhook-payload.result`.
  - Adds receiver replay vectors that accept full MCP webhook envelopes and reject bare `notification_type` delivery results, missing envelope fields, and invalid top-level task statuses.
  - Clarifies docs that reporting webhook signatures cover the exact raw bytes of the full envelope, not a reserialized inner result.

  Closes adcontextprotocol/adcp#5173 and adcontextprotocol/adcp#5174.

- e9a79a0: Migrate prose required-when / cross-field rules to the `x-adcp-validation` extension across `get_adcp_capabilities` (closes #3827). Five fields gain machine-readable normative constraints that the storyboard runner and SDK validators can now enforce programmatically; previously these rules lived only in description prose.

  **Fields migrated:**

  - `request_signing.required_for` — `subset_of: "request_signing.supported_for"` (an operation can't be required without being supported)
  - `request_signing.warn_for` — `disjoint_with: "request_signing.required_for"` plus `subset_of: "request_signing.supported_for"` (mutually exclusive with required_for; both must be subsets of supported)
  - `webhook_signing.supported` — `verifier_constraints.must_equal_when: { value: true, any_of: [...] }` keyed on `media_buy.reporting_delivery_methods` including `webhook` or `media_buy.content_standards.supports_webhook_delivery: true` (closes a downgrade vector — emitting state-changing webhooks unsigned)
  - `identity.key_origins` — `verifier_constraints.purpose_anchoring` mapping each purpose to the signing posture that must be declared elsewhere on the response (e.g., `request_signing` purpose requires non-empty `request_signing.supported_for`/`required_for`)

  **Sub-key vocabulary extended** in `docs/reference/schema-extensions.mdx`:

  - `forbidden_when` (inverse of `required_when`)
  - `disjoint_with` (item-level mutual exclusion across array fields)
  - `subset_of` (item-level subset constraint across array fields)

  Codegen consumers and JSON Schema validators ignore `x-` keys, so the wire format is unchanged. Storyboard runners that don't yet recognize a sub-key MUST skip it and emit an "unrecognized validation rule" warning per the existing convention.

  **Excluded from migration (already enforced natively):**

  - `adcp.idempotency` — the discriminated `oneOf` already requires `replay_ttl_seconds` in the supported branch and forbids it in the unsupported branch.
  - `webhook_signing.algorithms` — the `enum` on each item already enforces the allowlist.

  Backwards compatibility: strictly additive on the wire. Verifiers that ignore `x-adcp-validation` continue to work; the existing prose descriptions still document the rules. Storyboard runners gain enforceable assertions for invariants that were previously prose-only.

### Patch Changes

- 5a73382: Fix: CSRF middleware now exempts the per-tenant training-agent MCP route shape (`/<tenant>/mcp[-strict[-required|-forbidden]]`). Without this, requests to those routes — mounted at root via host-based dispatch on `test-agent.adcontextprotocol.org` — returned 403 `csrf_token_mismatch` before reaching the verifier, even for unsigned negative vectors that should have surfaced `request_signature_required`. The existing path-based exemption list only matched the legacy single-URL shape (`/mcp-strict`) and the AAO mount prefix (`/api/training-agent/`), missing the per-tenant URLs introduced when the strict routes moved to `/<tenant>/mcp-strict`.

  Pattern-matched on path shape rather than hostname because `req.hostname` is derived from `X-Forwarded-Host` under `trust proxy = 1`, which Fly's edge forwards as-received from the client. A hostname-based bypass would have let an attacker spoof `X-Forwarded-Host: test-agent.adcontextprotocol.org` on a cookie-authenticated route and skip CSRF. Path shape isn't client-spoofable.

  Unblocks `adcp grade request-signing https://test-agent.adcontextprotocol.org/<tenant>/mcp-strict` against the live test agent. Closes adcp#2368.

- 89619fb: 3.1.0 docs + scenario sweep — three remaining small fixes batched ahead of GA (2026-05-29):

  - **#4574** Cleanup of stale `list_authorized_properties` references (replaced by `get_adcp_capabilities` portfolio in v3):

    - `static/compliance/source/specialisms/signal-owned/index.yaml` — narrative rewritten to reflect the v3 retirement.
    - `skills/adcp-media-buy/SKILL.md` — table row + dedicated section removed; `get_adcp_capabilities` row updated to mention portfolio surface.
    - `server/src/addie/mcp/adcp-tools.ts` — removed from the ADCP_TASK_REGISTRY map so Addie's MCP routing no longer advertises the retired task.
    - `tests/addie/__snapshots__/adcp-tool-schema-drift.test.ts.snap` — snapshot updated to match.

  - **#4713** Surface 3.1 version negotiation in three docs surfaces previously describing the legacy integer-only contract:

    - `docs/reference/whats-new-in-v3.mdx § Per-request version declaration` — leads with release-precision `adcp_version` + `adcp.supported_versions`; legacy `adcp_major_version` retained as backwards-compatible.
    - `docs/building/by-layer/L0/a2a-guide.mdx` and `mcp-guide.mdx` — agent/server card notes updated with release-precision framing and a cross-link to `versioning.mdx § Version negotiation`.

  - **#4712** `static/compliance/source/universal/error-compliance.yaml` (phase `version_negotiation`) — added a release-precision `VERSION_UNSUPPORTED` probe (`adcp_version: "99.0"`) as the sibling to the existing integer-only probe. Advisory at 3.1; promotes to required at the 3.2 storyboard cut. Closes the gap where an integer-only validator could pass all storyboards while shipping a broken 3.1 buyer experience.

  Three sibling issues closed without code change (already done on main or upstream):

  - #4466 — adagents.mdx `authorization_type` is now `(required)` on main.
  - #3981 — sponsored-intelligence si_get_offering `context_outputs` path is now `offering.offering_id` on main.
  - #3555 — push-notification-config.json `url` description now documents port permissiveness on main.
  - #4519 — refine_products scenario `brief` already removed on main.
  - #4462 — schema's `ttl_sec` is the required field; the commit cited in the issue body was reverted/never landed.
  - #3349 — references `scenarios/signals.js` in adcp-client; spec storyboards already use correct field names.

- dcd78b9: Two coordinated updates ahead of 3.1 beta:

  - **Docs banner switch**: `docs.json` banner content updated from "🎉 AdCP 3.0 is now GA — see what's new" → "🚀 AdCP 3.1 beta is now available — see what's new". Links to `/docs/reference/whats-new-in-3-1`. The 3.0 GA banner had been displayed on docs.adcontextprotocol.org for months and was out of date. AAO main site (`server/public/index.html`) banner intentionally stays on "3.0 GA" — that audience is operators/agencies/members, beta messaging adds confusion without value.

  - **`whats-new-in-3-1.mdx` updates**:
    - **Beta status callout** at top: status is 3.1 beta; spec feature-complete; SDK + grader advisory-only during beta; GA target 2026-05-29; adopters can pin `adcp_version: "3.1-beta"` today.
    - **New "Final-spec clarifications (WG-review batch)" section** covering the 10 normative tightenings from PR #4796 (`4c124545f1`): `PROPOSAL_NOT_FOUND`, forward-compatible `error.code` decoding, `idempotency_key` required on every task request, MCP tool wrapper envelope tolerance, MCP serialization normalization (drops `payload.required`, adds `context` envelope field), idempotency replay returns historical snapshot, `refine[]` finalize-exclusivity, `pending_creatives` status disambiguation, `notices` advisory channel on runner-output-contract.

  The clarifications batch shipped after the original whats-new page was written; this catches the page up to current main.

- e815fc8: Prepare 3.1 release-candidate docs and training surfaces: add a 3.0 to 3.1 migration guide, refresh current RC guidance to `3.1-rc.15`, and advertise the current RC from the training agent while retaining prior RC pins.
- 1ebc729: Add 3.0 storyboard compatibility checks for the training agent and release flow.
- d62358e: Document `generate` as a sibling of `path` on `context_outputs[]` entries in `storyboard-schema.yaml`. Mutual-exclusion with `path` (exactly one required). Supported generators: `uuid_v4` and `opaque_id` (both mint a UUID v4; the two names exist for spec-vs-implementation framing). Aligns the spec-side schema with the runner-side support shipped in adcp-client#1006. Closes #3216.
- 68a9309: Harden brand-registry write path against adversarial parent claims (#3467). The brand-hierarchy auto-link path in `org-filters.ts` walks `brands.house_domain` and gates membership inheritance on `brand_manifest->'classification'->>'confidence' = 'high'`. Pre-fix, every community write surface (`save_brand` MCP tool, `editDiscoveredBrand`, `upsertDiscoveredBrand`) accepted both fields as opaque JSON, so an attacker could submit `house_domain = paying-target.example` plus `brand_manifest = { classification: { confidence: 'high' } }`, then sign in from `@attacker.example` to inherit a WorkOS membership in the paying target. Three bounded fixes at the DB layer in `brand-db.ts`: (1) `classification.*` is stripped from any caller-supplied `brand_manifest` and routed exclusively through a new typed `UpsertDiscoveredBrandInput.classification` field that only the brand-classifier service writes; (2) `house_domain` is canonicalized and validated on every write (rejects control characters, malformed shapes, and self-references); (3) edits preserve the prior trusted `classification` block so a refresh-logos edit doesn't silently drop the classifier's verdict. Regression test in `server/tests/unit/brand-db-house-domain-validation.test.ts` exercises the hostile payload against all three write methods.
- d844dd0: Disable vitest `fileParallelism` for the server suite. The module-level `pool` singleton in `db/index.ts` is shared across tests in a worker — running files in parallel let one file's `afterAll(closeDatabase)` null the pool while a sibling was mid-query, producing "Database not initialized" 500s that looked like transient Anthropic flakes. Closes #3695.
- e22f19a: Security: handle WorkOS `user.deleted` for primary-bound users (#3718).

  When a WorkOS user that is the primary credential on a multi-credential
  identity was deleted (operator action, account closure, or GDPR/CCPA erasure
  webhook), the CASCADE on `identity_workos_users.workos_user_id` dropped the
  binding and left the identity with zero primaries. `attachIdentityId` then
  resolved `primary_workos_user_id` to NULL, skipped the id-swap, and the
  surviving secondary signed in to an empty workspace — a denial-of-service
  against any non-primary user, reachable end-user-initiated via GDPR/CCPA.

  The `user.deleted` handler now promotes the longest-bound surviving secondary
  to primary in a single transaction before the CASCADE fires, mirroring the
  `findSuccessorForPromotion` pattern already used by `deleteMembership`. The
  handler also invalidates the session/JWT cache for both the deleted user and
  the promoted successor to close the 60-second window where a cached id-swap
  could still route reads to the dead binding. Promotion failures emit
  `logger.warn` (auto-routed to `#admin-errors`) plus an explicit
  `notifySystemError` ops alert, then return 200 so WorkOS doesn't retry-storm
  the webhook; the identity is left in a recoverable state for an admin to
  repair.

- fd764a2: Cap response body size on AAO discovery fetches. `@adcp/sdk` now ships native `transport.maxResponseBytes` support (mid-stream abort with `ResponseTooLargeError`), so we pass it to the three `AdCPClient` constructors in `capabilities.ts`: 4 MB for `discoverMCPTools` / `discoverA2ATools` (legitimate large agents reach ~2 MB with 500 tools) and 1 MB for `fetchMeasurementCapabilities`. Closes #3731.

  Known limitation: `getAgentInfo` / `mcpClient.listTools()` in the SDK do not yet route through the size-limit wrapper, so the 4 MB cap on the discovery constructors is dormant until the SDK wraps that path. Tracking upstream at adcontextprotocol/adcp-client#1799.

- d7d105a: Compare `ADMIN_API_KEY` with `crypto.timingSafeEqual` instead of `===`. Length-mismatch path runs a same-length dummy compare to keep total work constant. `Buffer.from(..., 'latin1')` makes the ASCII-only assumption on the key explicit. Closes #4209.
- 97daa5a: Clarify account namespace semantics for `account_id` references. Account-id mode now explicitly covers both seller-defined IDs supplied out-of-band and upstream-managed namespaces discovered through `list_accounts`; sellers MUST expose `list_accounts` when a credential can access more than one account and SHOULD expose a singleton row when a credential can access exactly one account. `sync_accounts` provisioning remains the buyer-declared natural-key path, and sellers MAY echo `account_id` there only if they continue accepting natural-key `AccountRef` values for subsequent calls. Required-account tasks must receive an explicit `AccountRef`; optional account omission is task-local, not a hidden credential-implied default. These statements codify the existing 3.0 account-scoped request expectations without changing the wire shape, fields, enums, or discriminators.

  Refs #4341.

- 9e4378c: Server: fire badge issuance on owner-driven compliance runs.

  The per-version badge fan-out (membership-org resolution + `processAgentBadges` loop across `SUPPORTED_BADGE_VERSIONS`) is extracted into a shared `runBadgeFanOut()` helper in `services/badge-issuance.ts`, and the two owner-driven paths now call it immediately after `recordComplianceRun`:

  - `evaluate_agent_quality` (member-tools) — full comply runs from an agent owner.
  - `POST /api/registry/agents/:url/storyboard/:storyboardId/run` — single-storyboard re-runs from the dashboard.

  The helper reads the latest per-storyboard state from `agent_storyboard_status` (rather than trusting the run's own inputs), so a single-storyboard owner re-run doesn't degrade badges for storyboards it didn't touch.

  Owner-facing impact: an owner who fixes a compliance issue and re-runs sees the badge update on the next page load instead of waiting up to a heartbeat cycle. Heartbeat behavior is unchanged — it still emits the verification-change Slack notification; owner paths skip the notify because the result is already delivered in chat / HTTP response.

  Closes #4376.

- 168b71d: Fix misleading "Professional tier or higher" copy across the public-listing UX. The code accepts four API-access tiers (Professional, Builder, Member, Leader), but error messages, dashboard tooltips, Addie's behavior rules, OpenAPI schema descriptions, and docs all said "Professional tier or higher" — readable as "Professional and tiers more expensive than it" rather than the intended "any paid tier". Addie repeatedly told Builder customers to upgrade to Professional, which is both wrong and a lower-priced tier. Replaces the phrase with explicit tier lists ("Professional, Builder, Member, or Leader" or "paying AAO members") across 11 surfaces. No behavior change.
- a9e292c: Add `server/src/scripts/audit-brand-domain-www-mismatch.ts` — dry-run audit identifying orgs whose past `brand_revisions` were written to a different brand domain than their current `organization_domains.is_primary=true` row (most commonly `www.<domain>` vs `<domain>`). Surfaces the blast radius for issue #4448 (Stage 2 #4159 drift), which manifests as publish-path manifest updates landing on a brand row the user has not previously curated. Read-only; no schema changes; feeds a follow-up backfill decision.
- a4bb6fd: Fix `syncOrganizationDomains` (WorkOS `organization.updated` webhook) so `organizations.email_domain` is sourced from `organization_domains.is_primary=true` rather than `org.domains[0]`. WorkOS's domain-array order is not stable — orgs with a verified root + a `failed` www variant could have WorkOS list www first, overwriting `email_domain` to the wrong value on every webhook fire even though our table's `is_primary` row was correct. Scope3 hit this in prod: `email_domain` had drifted to `www.scope3.com` while `is_primary=true` was on `scope3.com`, causing downstream lookups like `brand-enrichment.ts`'s `WHERE email_domain = $1` to miss the org row entirely. Adds `server/src/scripts/sync-email-domain-from-is-primary.ts` (dry-run + `--apply`) to clear the pre-fix backlog and an integration test pinning the new behavior.
- 0078057: `sync-email-domain-from-is-primary.ts` now classifies drift into three buckets (`null`, `www_drift`, `mismatched`) and only applies the `null` class by default. `www_drift` (the Scope3 class) is opt-in via `--include-www-drift`. `mismatched` is the subsidiary/M&A class (e.g. `linkedin.com` vs `microsoft.com`) and is never auto-fixed — those cases are surfaced for human review and are better modeled via `brands.house_domain` + `brand_domain_aliases` than by overwriting `email_domain`. Applied to prod 2026-05-12: 7 null cases backfilled.
- a9e292c: Add `server/src/scripts/reconcile-brand-domain-www-mismatch.ts` — one-shot reconciliation for the three orgs identified by the #4448 audit (Affinity Answers, BidMachine, Scope3). Per affected org, copies `brand_manifest.agents` from `www.<domain>` into `<domain>` (deduped on agent url), marks the www brand row `manifest_orphaned=true`, and inserts a `brand_domain_aliases` row routing `www.<domain>` → `<domain>` (Scope3 already has the alias and an empty www stub — only the orphan step runs there). Idempotent; dry-run by default; `--apply` to persist. Resolves the publish-path drift introduced when Stage 2 of #4159 (`5163d21425`) moved brand-domain authority to `organization_domains.is_primary` without backfilling orgs whose prior brand curation lived on the www variant.
- c4b9ea8: Fix: XSS in the adagents.json builder when rendering a hostile remote `adagents.json` or agent card. Any admin who validated a domain whose `adagents.json` or A2A agent-card contained script tags / event handlers in `card_data.name`, `validation.errors[*]`, `validation.warnings[*]`, `agent_cards[*].errors`, `agent_url`, or `domain` would have executed attacker-controlled JS in the admin's session.

  Reflections in `displayValidationResults()` and `displayAgentCardsResults()` now route every interpolated field through `escapeHtml()`, including the raw-data `<pre>` block (which previously emitted unescaped JSON, letting an attacker break out with `</pre><script>`).

  Also retires the legacy quick-add creator path (`startCreating()` and `updateUIForCreateOrUpdate()`): the entry-point DOM IDs were already removed when the v3 builder landed, leaving the v2-shape-emitting handlers orphaned. The supported `startManaging()` flow is the only entry point. `resetCreator()` was updated to stop referencing the removed IDs.

  Adds a jsdom-driven regression test that loads the static page, calls the two reflection helpers with hostile payloads (script tags, `<img onerror>`, `</pre>` break-out), and asserts no executable nodes land in the DOM and no global side-effect fires. Closes adcp#4468.

- 04f59d2: Fix migration 476 (`refresh_denormalized_user_email`) which was failing on prod
  deploy with a `idx_person_relationships_email_unique` collision. The naive
  `UPDATE person_relationships SET email = users.email` collided when two
  relationship rows would land on the same email — the symptom of two
  `person_relationships` rows pointing to the same person, or a stale row that
  should have been merged when `users.email` was reassigned. The migration now
  skips rows whose target email is already held by a different
  `person_relationships` row; the in-app read self-heal continues to surface the
  right email at display time, and the residual duplicates are left for separate
  dedup. Unblocks the `Deploy` workflow on `main`, which had been failing on
  release_command since #4481 merged.
- eb14837: Schema bundler: `x-adcp-hoist: true` opt-in marker for canonically shared object schemas. Spec authors set the directive on a source schema's root; the bundler moves the schema to a single root `$defs` entry, replaces every inline occurrence with `$ref`, and strips the directive from bundled output. Opt-in companion to the pure-enum auto-hoist (`hoistDuplicateInlineEnums`), addressing the complex-object case where structural identity ≠ semantic identity (e.g. `BriefAsset` and `VASTAsset` share fields today but represent different lifecycle concepts — auto-hoisting them would lock in coupling the source schemas don't express). No source schemas opt in here; per-type decisions ship in follow-ups. See [Schema Extensions reference](/docs/reference/schema-extensions#x-adcp-hoist) for the directive's contract.
- 642634b: Membership dashboard: surface billing address and membership agreement as first-class actions, independent of the invoice-request flow. The address card writes through a new `PUT /api/organizations/:orgId/billing-address` endpoint; the agreement card reuses the existing `POST /api/organizations/:orgId/pending-agreement` write. Both cards are visible to non-subscriber company orgs so prospects can complete prerequisites before invoicing — previously the only path to enter either was inside the invoice modal, which required both to be set simultaneously.

  `getPendingInvoices` now drops Stripe draft invoices with no line items or zero `amount_due` — abandoned subscription attempts left phantom $0 drafts that surfaced as "pending invoice" and confused users. `/dashboard/membership` now serves `dashboard-membership.html` directly (was 301-redirecting to `/organization#membership`, which has a summary but no invoice management). Closes #4564, #4565, #4573. Refs escalations #347, #348.

- 1ccc37a: Expand the canonical-formats compliance storyboard track for #4591 with seeded
  producer coverage for v1-only, v2-only, custom v2-only, experimental, and
  divergent dual-emission product declarations.

  The training agent now preserves fixture-seeded `format_options`-only products
  without inventing v1 fallbacks, and emits a producer advisory when a dual-emitted
  product's `format_options[].v1_format_ref[]` does not resolve to that product's
  `format_ids[]`. The v5 dispatcher and v6 sales adapter both preserve populated
  success payloads that carry non-fatal `errors[]` advisories.

  The sales training-agent tenant also advertises the seller-level vendor-metric
  optimization capability fields needed to exercise the new vendor-metric
  storyboards instead of capability-skipping them.

  Add #4983 vendor-metric external-catalog precondition coverage as a separate 3.1
  storyboard that accepts either compatibility acceptance or `TERMS_REJECTED`
  rejection when vendor-catalog membership is unproven by the current harness,
  with the future 3.2 true catalog-miss cutover documented in the storyboard narrative.

- f2364d9: Make the `impairment.coherence` terminal-buy carve-out explicit for the health-iff rule. The original lifecycle.mdx text only said terminal-status buys "MAY remain unreported even when a referenced resource is offline" — addressing impairments-list staleness but not the `impairments[]` ↔ `health` biconditional. Read strictly, the biconditional bound every buy regardless of status, which a strict runner could fail on a `completed` buy that legitimately carries stale `health: "impaired"` with an empty `impairments[]`.

  Aligns the spec with the runner pragma already in `@adcp/sdk` 7.6.0 ([adcp-client#1801](https://github.com/adcontextprotocol/adcp-client/pull/1801)): all three rules — forward, inverse, health-iff — relax on terminal-status buys. The runner grades them only against non-terminal buys; the spec text now says the same thing explicitly.

  `lifecycle.mdx § Compliance § Out of scope` extended with the biconditional relaxation. `compliance-catalog.mdx` Cross-resource invariants row mirrors the wording.

  Closes #4635.

- 7db573c: fix(training-agent): validate event_source_id refs in create_media_buy + emit cost_per_acquisition in delivery

  The training agent's `handleCreateMediaBuy` now rejects event-kind optimization goals whose `event_source_id` references were never registered via `sync_event_sources` (INVALID_REQUEST with `error.field` pointing at the offending JSONPath). Without this, the new `media_buy_seller/performance_buy_flow` storyboard scenario (#4642) silently passes phantom ids, defeating the anti-façade check.

  `get_media_buy_delivery` totals now compute `cost_per_acquisition = spend / conversions` when both are positive, matching the delivery contract expected by the same scenario.

- 04799b9: Certification: stop silent completion claims and misleading prereq prompts.

  Two coupled fixes to the cert tool surface and Sage's prompt rule:

  **`complete_certification_module` / `complete_certification_exam`** — every gate-failure return path now starts with a `NOT COMPLETED` sentinel and includes a learner-facing reframe keyed to the gate class (`time`, `evidence`, `state`, `score`). Pairs with a new rule in `addie/rules/constraints.md` that tells Sage to only treat the literal `Module {ID} completed!` / `# Congratulations! The learner passed the capstone!` lines as success, and forbids "complete" / "mastered" / "locked in" / etc. until she sees them. Fixes the failure mode where Sage announced "B2 complete" after the 5-min minimum-session gate had silently rejected her call (real-world example: escalation #341).

  **`start_certification_module`** — `checkPrerequisites` now returns per-prereq status (`{ moduleId, status }[]`). When a missing prereq is `in_progress`, the template directs Sage to surface the open work and offer learner agency ("want to wrap that, or talk through where you're stuck?") instead of offering a placement assessment to skip it. The placement-assessment template is preserved for `not_started` prereqs.

  Closes #4608 and #4647.

- 4d4c9a0: Surface `rejection_reason` on `get-media-buys-response.json#/properties/media_buys/items` — the field existed on `core/media-buy.json` but wasn't typed on the response schema, same gap-class as `health` + `impairments[]` fixed in PR #4685.

  Audit of `core/media-buy.json` against `get-media-buys-response.json` items completed: every other field on `core/media-buy.json` (media_buy_id, account, status, health, impairments, confirmed_at, cancellation, total_budget, packages, invoice_recipient, creative_deadline, revision, created_at, updated_at, ext) is already mirrored on the response items. After this patch, the response schema is complete with respect to the canonical media-buy fields.

  Response-specific additions (currency, start_time, end_time, valid_actions, available_actions, history, augmented packages with delivery snapshots) remain — those are deliberately on the response and not on `core/media-buy.json`.

  Closes #4687.

- 1210435: Fix worker recovery gap on rolling deploys (#4723). PR #3374 added `auto_start_machines = true` + `min_machines_running = 1` to the worker `[[services]]` block, but per Fly docs those flags are only enforced via fly-proxy — and a `[[services]]` block without `[[services.ports]]` doesn't get fly-proxy routing. The settings were inert. If a rolling deploy left the worker `stopped` (flyctl does not always issue `MachineStart` after `MachineUpdate`), nothing brought it back automatically; the watchdog from PR #4358 observed the failure but couldn't recover. Today's incident at 04:31 UTC required a manual `fly machine start`.

  The watchdog now actively recovers: on probe failure it queries the Fly Machines API, finds any worker machines in `stopped` state, and starts them. Started machines surface as a successful probe on the next tick; if start didn't help (real crashloop), failures keep climbing and the alert still fires. Requires `FLY_API_TOKEN` secret on the app — without it, recovery is a no-op and behavior matches PR #4358.

  Also corrects the misleading comment block in `fly.toml` that asserted autostart was wired up.

- ff53133: docs(adagents): add `authorization_type` → companion-field quick-reference table at the top of the Authorization Patterns section, plus a `<Warning>` callout on the `inline_properties` naming exception (companion field is `properties`, not `inline_properties`). Schema `description` strings on the `inline_properties` `oneOf` branch updated to surface the same exception where IDEs and linters display it. "Four patterns" count corrected to "six authorization types" (the two signal-side values were absent from the prose count). Non-normative — no fields, enums, or `required` arrays change.

  Closes #4776.

- 4b2b712: Stop persisting partial assistant turns when an Anthropic stream errors mid-reply. `processMessageStream` now yields a `stream_error` event after deltas have already shipped but before the underlying error throws (`server/src/addie/claude-client.ts`); Slack (`bolt-app.ts`), web (`addie-chat.ts`), and voice (`tavus.ts`) consumers handle it by rendering a recovery banner / SSE event and skipping persistence of the partial turn. The user's last message stays the most recent turn, so a retry or rephrase replays cleanly without a truncated assistant message biasing the resample — fixing the "goldfish" / dropped-context symptom observed during the 2026-05-19 Anthropic incidents. First step of #4797; banner + retry-after + model fallback follow.
- b23d1eb: Add 3.1 compliance storyboards for `reach_window` and `viewability.viewed_seconds` in delivery reporting.

  `reach_buy_flow.yaml` now covers cumulative, period, and rolling `reach_window` delivery rows, including the required `period` shape for period and rolling windows. It also adds a permanent advisory for reach rows that omit `reach_window`, which remain schema-valid but are not safe for buyers to sum or average across reporting periods.

  `delivery_reporting.yaml` now includes a viewability-capable vCPM video buy and verifies that simulated delivery reports surface `viewability.viewed_seconds` alongside measurable impressions, viewable rate, and the viewability standard.

  `comply-test-controller-request.json` and the controller docs now declare typed `simulate_delivery` params for `reach`, `frequency`, `reach_window`, and `viewability` so storyboard examples have a schema-grounded controller contract.

  The training-agent controller now persists those simulated metrics and returns them through `get_media_buy_delivery`, keeping the reference sandbox aligned with the new storyboard coverage.

- b45e693: media-buy: add `PROPOSAL_NOT_FOUND` compliance coverage for unknown proposal references.

  The training agent now returns the canonical `PROPOSAL_NOT_FOUND` error with
  `correctable` recovery for unknown `proposal_id` references in `get_products`
  refine/finalize and `create_media_buy`, and prevalidates proposal refinements
  before applying finalize side effects.

- 7e7a451: Add compliance storyboard coverage for `refine[]` finalize-exclusivity and `MULTI_FINALIZE_UNSUPPORTED`.

  New scenario `media_buy_seller/refine_finalize_exclusivity` tests the three normative negative cases clarified in issue #4107:

  1. Mixed finalize + non-finalize entries in a single `refine[]` call — rejected with `INVALID_REQUEST`.
  2. Non-proposal-scoped finalize entry — rejected with `INVALID_REQUEST` (schema-invalid input).
  3. Multi-proposal finalize — either handled atomically or rejected with `MULTI_FINALIZE_UNSUPPORTED` / `INVALID_REQUEST` (branch set).

- bf5b22a: `sync_accounts notification_configs`: clarify `subscriber_id` as the stable diff key and upsert semantics.

  The existing "declarative replace semantics" language was silent on the match key used when diffing a sent `notification_configs[]` against persisted state. This left implementers to infer that `subscriber_id` is the key — which is the only coherent reading, but the `notification-config.json` field description said "duplicates are rejected with `errors[]`" without scoping that to within-request uniqueness, creating an apparent contradiction.

  **Normative changes (description-only; no wire format change):**

  - `notification-config.json` — `subscriber_id.description`: clarifies that the rejection-on-duplicate rule applies to sending two entries with the same `subscriber_id` within a **single** `sync_accounts` request array. A subsequent `sync_accounts` call that includes an entry whose `subscriber_id` already exists in persisted state **upserts (replaces)** that subscriber's active config — the seller MUST NOT create a duplicate. `subscriber_id` is now explicitly named as the stable match key for the per-account diff.

  - `sync-accounts-request.json` — `notification_configs.description`: adds "using `subscriber_id` as the stable match key" to the declarative-replace sentence, plus an explicit "seller MUST NOT merge the new array with persisted state — entries in persisted state whose `subscriber_id` does not appear in the sent array are removed."

  - `docs/accounts/tasks/sync_accounts.mdx` — prose section on account-level webhook subscriptions updated to reflect the same semantics.

  These semantics match the reference implementation in Salesagent PR #561, which passes against Python SDK 6.1.0 beta models.

  Closes #4977.

- 0ce96be: Add deterministic vendor_metric measurement-catalog-miss coverage for 3.1 storyboards.
- ba7410c: Mirror the current published SDK storyboard compliance bundle into
  `static/compliance/source/` as the spec-owned canonical source, add source
  authority drift checks, and document the storyboard rollout order:
  `spec storyboard change -> reference implementations update -> @adcp/sdk runner
release -> downstream consumers update`.
- c197b73: Clarify progressive disclosure for enriched signal definitions: provider-published signals resolve through `signal_ref` to `adagents.json` and cache with `catalog_etag` or HTTP validators, while rich fields can still be requested inline for exact lookup, custom, or private signals.

  Clarify runtime validation requirements for enriched signal definitions, including draft-07 conditional constraints, data-subject-rights channel requirements, Article 9 checks, federation handling for `countries[]`, and the verification limits of `provider_signed`. Remove signal-level Global Privacy Control handling from the DSR surface; signal definitions do not declare GPC support, and consumers must not infer GPC handling from DSR routing metadata.

- 52bd79c: Add an optional `availability_status` enum to the `si_get_offering` response. It appears on the `offering` object (alongside `expires_at`) and on each `matching_products[]` item (alongside the free-string `availability_summary`), and is defined by a new centralized enum `enums/offering-availability-status.json` (`available`, `limited`, `sold_out`, `expired`, `region_restricted`, `inactive`).

  The value set deliberately matches the SI task page's existing "Unavailable Reasons" vocabulary so the structured enum and the free-string `unavailable_reason` stay coherent. The field is optional and additive: it is not in `required`, both objects already carry `additionalProperties: true`, and the schema is `x-status: experimental`, so existing producers and consumers are unaffected.

  Refs #5264.

- 50bb14a: spec(creative): clarify preview URL durability for generated creative previews.

  Documents that `preview_url` is the browser/MCPUI-renderable resource in AdCP 3.x and must remain dereferenceable for its advertised lifetime: until `expires_at` when present, or until explicit out-of-band revocation when omitted. Also fixes the stale Creative Protocol overview wording that said `expires_at` was always required, which contradicted the current schema and schema test for non-expiring preview URLs.

  This intentionally does not add `asset_ref`, `resource_uri`, or another durable-pointer field to `PreviewRender`; that naming and buyer-visible-vs-agent-internal decision remains a working-group question in #5434.

- 088840d: Improve AAO agent dashboard failure visibility by exposing owner-scoped storyboard diagnostics in the compliance API, highlighting failing and partial storyboard rows in the Test panel, and making declared-specialism chips readable in dark mode.
- 5740802: docs(aao-verified): make the two axes truly orthogonal — Live is no longer a downstream of Spec. The prerequisite framing was wrong: a seller without a sandbox/test endpoint (common for SDK-built agents whose wire format is guaranteed by the SDK, or for production-only platforms that have no test-mode surface) can earn (Live) directly by enrolling a compliance account. The eight observability checks already exercise wire format, filters, lifecycle, and scope introspection through real traffic, which makes a separate simulation pass redundant for that seller. Conversely, a test agent earns (Spec) as a complete claim.

  Updated copy in `docs/building/aao-verified.mdx`:

  - Top-level framing now states the axes are orthogonal, not hierarchical.
  - (Live) eligibility table no longer says "Currently holds (Spec)".
  - "(Live) only" badge reading is now a normal, valid claim — not a "rare and transient" state.
  - Mark semantics list (Live) only as a holding alongside (Spec) only and (Spec + Live).
  - Lifecycle: revoking (Spec) no longer revokes (Live); revoking (Live) no longer touches (Spec).

  Updated `docs/building/conformance.mdx` to match: both marks attest conformance via different evidence (Spec via simulation, Live via real-traffic observability).

  No code changes — the badge model already supported `verification_modes: ['live']` standalone; the only thing that needed fixing was the documentation that incorrectly claimed otherwise.

- c977acd: fix(aao): follow ads.txt redirect chains for managerdomain fallback (#5440)

  Publisher domains whose `/.well-known/adagents.json` is missing can still be
  authorized through the legacy ads.txt `MANAGERDOMAIN` fallback when the manager
  manifest explicitly scopes the publisher. The fallback now follows normal
  ads.txt redirect chains before parsing `MANAGERDOMAIN`, fixing managed-network
  setups where the publisher's `/ads.txt` redirects through a canonical hostname
  and then to a hosted ads.txt file. The adagents docs also clarify that hostname
  redirect chains must end at a `200` JSON file when relying on direct
  well-known deployment.

- ffee34d: Bump `@adcp/sdk` from `^6.19.1` to `^7.0.0`.

  7.0.0 ships the SDK-side fixes for five compliance-harness issues we filed against `adcp-client` ([#1676](https://github.com/adcontextprotocol/adcp-client/issues/1676) – [#1680](https://github.com/adcontextprotocol/adcp-client/issues/1680)) after probing Wonderstruck against the AAO conformance suite:

  - `request-normalizer` no longer fabricates `account` from `brand.domain` on `create_media_buy` — missing `account` now throws `ValidationError` at the client boundary, per the AdCP 3.0 spec and the v2 sunset policy (#1676).
  - `PackageRequest` normalizer throws on the pre-3.0 `product_ids: string[]` and `budget: {total, currency}` shapes — there's no safe translation for these (which id wins? which currency?) so it fails closed (#1677).
  - Webhook storyboards skip cleanly when no `webhook_receiver` is configured instead of sending a relative `push_notification_config.url` and false-failing (#1678).
  - `ComplianceResult.failures[]` now carries the structured `adcp_error` payload + `validation` detail, so heartbeat output reveals real wire-level failures instead of dropping to `error: {}` (#1679).
  - Storyboards whose `required_tools` aren't all present in the agent's discovered toolset are graded `not_applicable` at the storyboard level, surfaced via `storyboards_missing_tools` / `storyboards_not_applicable` on the result root — they no longer cascade `partial` to the track (#1680).

  Net effect for AAO heartbeat output: false-positive passes go away (no more badges issued against fabricated-account requests), false-negative track drops go away (controller-dependent storyboards on agents that don't expose controller stop dragging unrelated tracks to `partial`), and failures become diagnosable from the heartbeat alone instead of needing a separate SDK-level probe.

  Typecheck clean, 873/873 unit tests pass on 7.0.0.

- 12434c4: Add admin Slack support for deterministic outreach logging, persisted conversation learnings, and contact creation.
- e815fc8: Fix Addie conformance result explanations for `missing_test_controller` skips.
  Socket Mode storyboard reports now surface skip reasons and classify controller
  skips as optional deterministic-test-surface coverage gaps rather than missing
  required seller functionality.
- 7e38ca2: Allow static admin API key callers to read registry compliance diagnostics and outbound monitoring data across seller agents, without granting mutating agent-owner operations.
- c9121fc: Stop two recurring `#admin-errors` log streams:

  - `network-consistency-reporter`: null-guard `extractDeclaredProperties` so brand rows with `brand_manifest IS NULL` no longer crash the worker with `Cannot read properties of null (reading 'brands')`. The outer org-selection query now filters `brand_manifest IS NOT NULL`, and the per-org loop drops manifest-less brands before picking `brands[0]`.

  - `announcement-trigger`: surface Slack's `response_metadata.messages` (the only place validation errors name the offending block/field) in the thrown `Error.message`, and add a redacted block-shape summary (per-block type + text/url/alt lengths) to the failure log. Bare `Slack API error: invalid_blocks` lines now carry actionable detail. Capped at 1KB to bound log size for pathological Slack responses, and `imageUrlLength` is only logged when the scheme is `https`. Header text is also clamped to Slack's 150-char `plain_text` cap so over-long `organizations.name` values can't push the header past the limit.

- 4e7e448: Return only mutated packages in `update_media_buy` `affected_packages` while
  preserving full package state in the response `packages` array.
- d0c84e4: fix(registry): per-agent `visibility` is the only listing gate (legacy `member_profiles.is_public` no longer hides public agents)

  `member_profiles.is_public` is the **member-directory** flag (per migration 011: `-- Show in member directory`) and predates per-agent `visibility`. Continuing to gate the agent registry on it silently hid agents whose owners explicitly marked them `public` whenever the parent profile wasn't listed in the member directory — breaking the AAO member-profile UI's "Visibility: Public — Listed publicly and added to brand.json" promise.

  Drops the profile-level `is_public` filter in:

  - `FederatedIndexService.listAllAgents` / `listAllPublishers` / `lookupDomain` / `getStats` (back the public registry surface)
  - `AgentService.listAgents` / `getAgentByUrl` (and the redundant "public agent on private profile → hide" early-continue)
  - `CrawlerService.populateFederatedIndex` (publisher crawl)

  Per-agent `visibility` (`public` / `members_only` / `private`) and per-publisher `is_public` are now authoritative. Profile-level `is_public` continues to gate the `/Members` directory listing only — its documented purpose.

- 1a900c6: Docs typo fix: two "behaviour" → "behavior" in `docs/reference/release-notes.mdx` to match the repo-wide US-spelling convention (158 vs 2 before this fix).

  Opened to smoke-test the new Argus AI PR review workflow (#3488).

- 5a1b629: Caches immutable artifact CDN responses at the Cloudflare edge while keeping movable aliases revalidated.
- 063e317: spec(errors): tighten `AUTH_REQUIRED` prose to warn on retry storms

  `AUTH_REQUIRED` conflates two operationally distinct cases — credentials missing (genuinely correctable) and credentials presented but rejected (terminal — needs human rotation). A buyer agent treating both as `correctable` will retry-loop on revoked tokens, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

  The 3.1 line will eventually split this into `AUTH_MISSING` and `AUTH_INVALID` via #3739. Until that split ships, the prose tightening is the only operational guidance against the retry-storm pattern. The wire code stays `AUTH_REQUIRED` with `recovery: correctable`; the description and `enumMetadata.suggestion` now spell out the two sub-cases and the SHOULD-NOT-auto-retry rule for the rejected-credential case. Agents apply the operational distinction at the application layer by branching on whether credentials were attached to the failing request.

  Updates:

  - `static/schemas/source/enums/error-code.json` — `enumDescriptions.AUTH_REQUIRED` and `enumMetadata.AUTH_REQUIRED.suggestion` rewritten to spell out both sub-cases and the retry-storm risk. The description follows the same summary-then-`Sub-cases (full guidance).` shape already used by `GOVERNANCE_DENIED` / `GOVERNANCE_UNAVAILABLE`, with a cross-reference to `error-handling.mdx#auth_required-sub-cases`.
  - `docs/building/implementation/error-handling.mdx` — adds an `AUTH_REQUIRED sub-cases` Mintlify `<Warning>` callout under the Authentication and Access table; the recovery example switch now derives `requestHadCredentials` locally from `error.request_had_credentials` so a reader pasting the snippet doesn't hit `ReferenceError`.

  Wire format unchanged. No new enum values. No recovery classification change at the structured level. Senders that already emit `AUTH_REQUIRED` keep working; receivers gain the documented sub-case discipline.

  Also drops two stale forward-merge changeset leftovers (`envelope-field-present-check-type`, `fix-asset-union-dedup`) whose work has already shipped to 3.0.x and is also already in-tree on `main` — without this cleanup the next 3.1.0 cut would emit duplicate CHANGELOG entries.

- c17be45: Accept HTTP Basic authentication in the universal `security_baseline` compliance storyboard. Basic credentials now have a dedicated valid/invalid probe path and can satisfy `auth_mechanism_verified` alongside Bearer API keys and OAuth discovery.
- e27cffb: spec: replace the durable catalog event feed with account-level wholesale feed webhooks.

  Wholesale product and signals feed changes are now registered through
  `sync_accounts.accounts[].notification_configs[]`, delivered with denormalized
  `product.*`, `signal.*`, and `wholesale_feed.bulk_change` payloads, and repaired
  through `get_products` / `get_signals` using `if_wholesale_feed_version`.

- cd71e45: Build schema bundles with `core/async-response-refs/` copies so SDK validators
  can pre-register async response refs before compiling
  `core/async-response-data.json` in the next release candidate.

  Refs #5161.

- 8302d1a: Billing address modal: the Country field is now a select of ISO-3166-1 alpha-2 codes instead of a free-text input, matching what the server validator and Stripe `customer.address.country` require. Previously typing "Singapore" produced a generic "Please provide line1, city, state, postal_code, and country (each ≤ 200 chars)" error even when every field was populated, because the validator silently rejected non-alpha-2 values.

  The server now uses `validateBillingAddress(input)` which returns a discriminated `{ok, address|error}` result, so `POST /api/organizations/:orgId/billing/invoice-request` and `PUT /api/organizations/:orgId/billing-address` return the specific failure (`Country must be a 2-letter ISO code (e.g. US, GB, SG)`, `Please provide city, postal code`, etc.) instead of a single misleading message. `sanitizeBillingAddress` is kept as a thin wrapper for backward compatibility.

- f87d027: Docs: implementer guidance for `verify_brand_claim` and consumer-side UI conventions for rejected claims.

  `building-a-brand-agent.mdx` gains a new section, "Adding verify_brand_claim", covering the layered capability on top of the identity tier: capability declaration with `supported_claim_types`, the internal state model (subsidiary portfolio, parent declaration, property registry, trademark registry, pending-claim queue, archive), per-claim-type request validation and response shaping, the public-vs-authorized field split, the `pending_review` aging contract, per-purpose JWK setup (`adcp_use: "response-signing"` separate from `request-signing`), the `{caller_identity, claim_type, claim-target}` rate-limiting pattern with `Retry-After` and prefer-cached-prior-answer behavior, per-status `Cache-Control` recommendations, and a reference pattern for surfacing `pending_review` to the brand's portfolio team. The role table and deployment checklist are extended accordingly.

  A new page, `docs/brand-protocol/ui-guidance.mdx`, collects consumer-side conventions for rendering `disputed` / `not_ours` rejections — DSP inventory shopping, portfolio explorer, creative-clearance, brand-safety pipelines. Covers attribution language (render rejections as the rejecting brand's first-person statement), recovery paths for the rejected leaf publisher (there is no protocol-level appeal — update or remove the claim), audit-trail recommendations (keep the signed envelope), and legal-exposure considerations (the consumer surface owns editorial framing; AdCP delivers the signed answer).

  No schema changes. Both additions are non-normative consumer-side guidance — the canonical normative spec remains the `verify_brand_claim` task page.

- a091c67: Update the brand-rights governance-denied storyboard to assert `rights_status` on the rejected response arm.
- 6da3000: spec(bundling): preserve sub-schema `$id`s when inlining `$ref`s into the bundled tree

  Closes #3868. The pre-resolved `bundled/` tree shipped with every release inlined `$ref`'d sub-schemas without preserving their `$id`s, so validators reading the bundle saw only the response-root `$id`. Pairs with the `schemaId` addition in #3867 — without this fix, `schemaId` on bundled tools would just restate the tool name the adopter already knows.

  **What changes in the published artifact.** Every inlined sub-schema in `dist/schemas/{version}/bundled/**/*.json` now carries the `$id` of the source schema it was inlined from, rewritten to the versioned flat-tree URI. Concretely, inside `bundled/signals/activate-signal-response.json`:

  ```diff
   "activation_key": {
     "title": "Activation Key",
     "type": "object",
  +  "$id": "/schemas/3.1.0/core/activation-key.json",
     "oneOf": [...]
   }
  ```

  Ajv 8 (and any draft-07-conformant validator in non-strict mode) reads these inline `$id`s and emits them in `error.schemaPath` / `error.parentSchema.$id`. SDKs that already implement longest-prefix-match resolution (like `@adcp/sdk`'s TypeScript client) surface the deep sub-schema `$id` on `error.issues[].schema_id` without code changes.

  **Pipeline change** (`scripts/build-schemas.cjs`), four passes added or extended:

  - `resolveRefs` no longer destructures `$id` away when merging an inlined ref into its parent. `$schema` is still dropped (only meaningful at document root). When a parent declares its own `$id` alongside `$ref` (the deprecated-alias pattern, e.g. `signal-pricing-option.json` aliasing `vendor-pricing-option.json`), the parent's `$id` wins so the alias's identity is preserved.
  - `versionInlineSchemaIds` post-pass rewrites every inner `$id` from source form (`/schemas/core/foo.json`) to the versioned flat-tree URI (`/schemas/{version}/core/foo.json`). Idempotent on already-versioned `$id`s; leaves external/relative `$id`s alone.
  - `stripIdsFromSubtreesWithLocalRefs` post-pass deletes `$id` from any subtree whose descendants carry a local `$ref` (`#/...`). The hoist passes (`hoistNestedDefsToRoot`, `hoistDuplicateInlineEnums`) move shared definitions to root `$defs` and rewrite call-sites to `{$ref: "#/$defs/Foo"}` — those fragment refs resolve against the _nearest enclosing `$id`_, so preserving `$id` on a subtree containing them changes the resolution scope and Ajv reports `"can't resolve reference #/$defs/Foo from id <inlined-$id>"`. Stripping the conflicting `$id` yields the document-root scope the local refs need; subtrees free of local refs (e.g. `version-envelope`, `activation-key`) keep their `$id`.
  - `dedupBundledSchemaIds` post-pass is first-wins on identical `$id` values within one document. Same source schema referenced from multiple co-locations (e.g. `version-envelope` in an `allOf`) produces multiple inlined subtrees; Ajv refuses to compile a schema with duplicate `$id`s even in non-strict mode. First-wins anchors the schema's identity at the first occurrence; subsequent occurrences fall back to the nearest enclosing `$id`-bearing ancestor when SDK error reporting walks up.

  **What survives.** 1532 sub-`$id`s across the 81 bundled schemas (avg ~19 per file) — every bundled tool gains deep-`$id` surface area. Notable preserved cases: `version-envelope`, `activation-key`, `account-ref`, `brand-ref`, `context`, `ext`, plus most asset / asset-requirement sub-schemas. Stripped cases: any sub-schema whose subtree gets dedup'd-enum hoists rewritten into it (e.g. `delivery-metrics`, `targeting`, `format`, `catalog`, `pricing-options/price-breakdown`).

  **Tests** in `tests/build-schemas-preserve-subschema-ids.test.cjs` (12 cases): alias-wins, sibling-key precedence, version-stamping post-pass + idempotency + external-`$id` passthrough + array-recursion `isRoot`, strip-on-local-ref + leave-on-absolute-ref, dedup first-wins, root-shadow protection.

  **Compatibility.** No wire-format change. No new validation behavior on any code path. Bundled artifact compiles cleanly under Ajv 8 (`strict: false` recommended for the same reasons it always was — `additionalProperties: true` etc. — but no longer required for duplicate-`$id` reasons specifically). The bytes that change in the published `bundled/` artifact are metadata-only `$id` keywords on subtrees.

- d4b7e74: Add a shallow buyer-track canonical-format primer covering `format_options[]`, `format_kind`, `asset_source`, and buyer handling of canonical-format `FORMAT_*` codes.
- 9ee8082: Add canonical-format coverage to the S2 creative specialist curriculum, including a hands-on authoring lab, glossary entries, and stable success criteria for targeted recertification.

  Foundations and buyer-track learning pages now mention 3.1 `format_options[]` at orientation depth and point learners to S2 for canonical-first validation details.

  Recertification trigger wiring is intentionally deferred to the follow-up issue referenced from the PR; this patch only adds stable criterion IDs and curriculum coverage.

  Also clarifies that `creative_approval_mode` is a discovery declaration for auto-approval-dependent behavior, not a notification or approval workflow.

- fe6d7e6: Add a media-buy canonical-formats scenario that seeds a dual-emitted product and verifies the seeded `get_products` response carries matching v1 `format_ids` and v2 `format_options`.

  Also refresh the canonical get_products response fixture so it satisfies the current 3.1 response envelope and cache-scope requirements.

- 1c50227: Adds explicit cutover tooling for the R2-backed artifact CDN Worker. No package release is needed.
- 88ce610: Wires release and deploy workflows to publish protocol artifacts to the R2-backed CDN bucket. No package release is needed.
- 57e7a2f: Certification: three defense-in-depth follow-ups from the #4657 review.

  - **#4659** — static-guard regex in `cert-not-completed-sentinel.test.ts` now matches multi-line backtick `return` literals (`[\s\S]` with non-greedy bound), so a future contributor can't slip a multi-line rejection past the wrapper-required guard. Added a regression test that synthesises a multi-line offender.
  - **#4660** — added a CI guard test that scans every `.ts` file in `server/src/addie/mcp/` and asserts only `certification-tools.ts` may emit the `Module {ID} completed!` or `# Congratulations! The learner passed the capstone!` success-line prefixes. Prevents a future tool from echoing or summarising prior completions in a way that would trick Sage's rule into announcing success.
  - **#4662** — `createCertificationToolHandlers` now pins `boundUserId` at construction and asserts on every `getUserId()` that the captured user hasn't been swapped. Doc comment on the factory clarifies the handler set MUST NOT be cached across users. Makes any future cross-tenant handler-set reuse fail loud rather than silently leaking state.

- 13ff494: Use generated storyboard context values for idempotency replay keys and assert
  declared specialisms during specialism capability discovery.
- eb65373: Fix compliance reporting for optional-tool skips: storyboard-level `required_tools`
  and step-level `requires_tool` skips now remain untested/not applicable in Addie
  instead of surfacing as failures. Preview creative checks now declare their
  `preview_creative` gate explicitly, and idempotency replay key stability is pinned
  with a source-storyboard regression test.
- c9ca76d: Fix `universal/comply-controller-mode-gate.yaml` lint failure: sample_request was missing the required `account: { sandbox: true }` field. The storyboard tests the live-mode denial path (seller resolves auth → live account → returns FORBIDDEN), which is unrelated to the `account.sandbox` payload claim — but the payload still needs to be schema-valid as defense-in-depth before reaching the per-account gate. Added the `account` block plus an explanatory comment.

  No behavioral change to the storyboard's assertions — the denial path was already being tested correctly; only the schema-drift gate now passes.

- 80ea975: fix(compliance): require content-standards specialism discovery

  Refs #5430. Adds the content-standards specialism claim to the storyboard capability discovery check and clarifies that `media_buy.content_standards` is distinct from the governance specialism declaration.

- 6cb5296: Align controller-seeded pagination and canonical-format storyboards with the controller load-phase gate so agents without `comply_test_controller` skip cleanly at storyboard scope.
- 402062c: Document the `build_creative.evaluator` authentication boundary: evaluator credentials and caller-supplied trust material stay on the transport/account-provisioning channel, off-list evaluator URLs are rejected before outbound calls, accepted evaluator auth failures degrade to seller-default ranking, and the new evaluator-auth storyboard covers direct `agent_url`, nested `feature_agent`, credential-in-payload, accepted-call, and unavailable-evaluator paths.
- 48af987: Add 3.1 creative lifecycle webhook storyboard coverage and training-agent support for account-level creative notification configs.
- b2e3f90: spec(creative): harden the unreleased 3.1 creative-transformer surface — make three already-documented normative rules schema-enforceable, and fix a self-contradictory `leaves_total` formula.

  These refine the 3.1 transformer / `build_creative` multiplicity feature before GA. No new surface; each change makes an existing MUST checkable or corrects a description.

  - **Per-leaf pricing receipt is now enforced when a build reports cost.** `BuildCreativeVariantSuccess` documents that untrafficked best-of-N / fan-out leaves are billed via the inline per-leaf `vendor_cost` _only_ (they never earn a `creative_id`, so never reach `report_usage`), and that the aggregate `vendor_cost` MUST equal the sum of the per-leaf values — but the leaf only required `[build_variant_id, creative_manifest]`, so a paid agent could bill N leaves and return no machine-readable cost for any of them. Added: (a) a branch-level `if (aggregate vendor_cost present) then` each produced leaf requires `vendor_cost` + `currency`; (b) per-leaf `dependencies` so a leaf can't carry a partial receipt (`vendor_cost`↔`currency` co-required; `pricing_option_id` ⇒ both). A genuinely free build omits the aggregate and is unaffected; a CPM-deferred leaf reports `vendor_cost: 0` (a value, not an omission).

  - **`transformer-param.json` `value_source` now binds to its descriptor.** The prose already stated the rules (`inline` ⇒ `allowed_values`; `range` ⇒ `minimum`/`maximum`; `free_text` ⇒ `type: string` and `allowed_values`/`minimum`/`maximum`/`options`/`options_cursor` absent), but nothing enforced them. Added `allOf` `if/then` blocks. `enumerable` is intentionally unconstrained — its `options[]` are returned only when expanded via `expand_params`.

  - **Fixed the `leaves_total` formula.** The `conditions_total` field documented the three-factor product (`items_to_produce × conditions_total × variants_per_item`) while the `leaves_total` field two lines down — and the `BuildCreativeVariantSuccess.leaves_total` description — stated the two-factor product, so an agent computing expected leaves from the field's own description under-counted by a factor of `conditions_total` whenever `signal_conditions` was present. All three now state the conditions factor consistently. Docs (`build_creative.mdx`, `creative-transformers.mdx` migration guide) updated to match.

- 9a6edeb: Update minor and patch npm dependencies for email domain lookup, analytics, email delivery, WebSocket handling, and docs tooling.
- 09cfc8e: deploy.yml resilience: when `flyctl deploy` exits non-zero, probe `https://adcontextprotocol.org/health` before failing. If the app responds 200, treat the deploy as fallback-success (Fly machines API issue, not an app issue), skip Fly-API-dependent gates, and continue. Real app failures still hard-fail. Always capture `flyctl status` / `machines list` / `releases` / `logs` as a workflow artifact on failure for next-turn forensics. Closes #4780.
- de24f51: PR 4 of the #4247 unification stack. Replaces direct reads of
  `agent_contexts.last_test_*` with a view that derives them from
  `agent_compliance_runs` — the canonical source PR #4250 unified onto.

  **What changes.**

  - New column `agent_compliance_runs.triggered_org_id` (nullable). Populated
    by the owner-test write path in `evaluate_agent_quality` using the
    caller's `organizationId`. Heartbeat / manual / webhook writes leave it
    NULL — they don't have an org dimension. Without this column, two orgs
    that own the same agent URL (e.g. staging and prod orgs of one publisher)
    would conflate their test history through a join on `agent_url` alone.
  - New view `agent_context_with_latest_test`: `agent_contexts.*` joined to
    the latest non-dry-run `agent_compliance_runs` row scoped by
    `(triggered_org_id, agent_url)` via `LEFT JOIN LATERAL`, plus a COUNT
    scalar subquery for `total_tests_run`. Surfaces the derived fields as
    `canonical_last_test_*` so the column-rename in the SELECT is explicit.
    When no owner-canonical row exists, the view falls back to the legacy
    `agent_contexts.last_test_*` columns so non-owner `recordTest()` results
    remain visible to saved-agent list callers.
  - `AgentContextDatabase.getByOrganization`, `getById`, `getByOrgAndUrl`
    now SELECT from the view and alias `canonical_last_test_*` →
    `last_test_*` so callers see no shape change.

  **Backward compat.** The legacy `agent_contexts.last_test_*` columns stay.
  Third-party (non-owner) `recordTest()` writes still update them, and the
  view falls back to those fields when no owner-canonical run exists — that's
  the session-scoped audit trail PR 3 of #4247 retained for non-owner runs.
  The columns become dead-letter once `agent_test_history` is dropped (gated
  on the soak windows in #4247) and `recordTest()` retires in the follow-up
  "final cleanup" PR.

  **Semantic shift (last_test_scenario).** For owner test runs,
  `last_test_scenario` now returns `tracks_json[0].track` (e.g.
  `'quality_evaluation'`) rather than the literal string the old
  `recordTest()` write path stored directly. No existing callers branch on
  this value, but downstream consumers that read `last_test_scenario` should
  expect a track name sourced from the canonical run record rather than the
  legacy scenario string.

  **Semantic shift (total_tests_run).** When an owner-canonical run exists,
  `total_tests_run` now returns the count of non-dry-run canonical rows scoped
  to `(triggered_org_id, agent_url)`. When no owner-canonical row exists, it
  falls back to the legacy per-context counter so non-owner saved-agent tests
  remain visible.

  **Index.** `idx_agent_compliance_runs_triggered_org_url_at` on
  `(triggered_org_id, agent_url, tested_at DESC)` (partial, only where
  `triggered_org_id IS NOT NULL`) supports the view's per-org LATERAL lookup
  as a single index scan.

  **Stacked on** #4264 (PR 3) → #4263 (PR 2) → #4250 (PR 1).

- 3022d23: Storyboard: mark all six independent `deterministic_*` phases as `depends_on: []`, and document `Phase.depends_on` in the storyboard schema

  All six phases of the `deterministic_testing` storyboard — `deterministic_account`, `deterministic_media_buy`, `deterministic_creative`, `deterministic_session`, `deterministic_delivery`, `deterministic_budget` — each create their own state in-phase (their own account, media buy, creative, or session via `comply_test_controller`-gated steps) and consume no `$context.*` value produced by an earlier phase. They were exposed to the runner's default cross-phase cascade ("phase depends on all prior phases"), which over-cascaded: when a seller without `si_initiate_session` correctly skipped `deterministic_session/initiate_session` with `missing_tool`, the cascade also tripped `deterministic_delivery` and `deterministic_budget`. The same risk existed for the other three phases on any adopter that legitimately skips an earlier deterministic phase. Explicit `depends_on: []` removes the false dependency in all six.

  Also documents `Phase.depends_on` in `storyboard-schema.yaml` — the field was supported by the runner (introduced in adcp-client#1161) but undocumented in the spec-side schema, which is why this trap kept catching storyboard authors.

  Reported in adcp-client#1711 follow-up.

- 2836f34: Build pipeline: prevent PR #4769-class outages where a runtime asset added to `server/src/**` is missing from the shipping image because the Dockerfile copied it by exact filename. `npm run build` now mirrors every allowlisted non-TypeScript file (`.json`, `.md`, `.sql`, `.txt`, `.csv`, `.yaml`/`.yml`, `.html`, `.xml`) from `server/src/**` into `dist/**` automatically (`scripts/copy-server-assets.cjs`); the Dockerfile drops three redundant per-directory `COPY` lines; and a new CI check (`scripts/copy-server-assets.cjs --check`) fails the build if `dist/` ever diverges from source. No protocol surface change.
- e7c7e96: Restore prod: copy all creative-agent JSON assets in Dockerfile (not just `reference-formats.json`), so `ui-element-formats.json` ships in the runtime image and `task-handlers.ts` boots. No protocol surface change.
- 95a776f: Docs: add the now-required `account.supported_billing` block to the four
  `get_adcp_capabilities` example JSON blocks that declare `media_buy`
  support.

  Since #3750 (`fix(schema): make account.supported_billing conditional on
media_buy protocol`), the response schema requires `account.supported_billing`
  whenever `supported_protocols` contains `media_buy`. Four illustrative
  examples in the docs (`creative/sales-agent-creative-capabilities.mdx`,
  `media-buy/specification.mdx`, `reference/migration/channels.mdx`,
  `reference/migration/geo-targeting.mdx`) were not updated alongside the
  schema and have been failing CI's schema validation step on `3.0.x` HEAD,
  blocking every other patch PR against the branch.

  Each example now includes `"account": { "supported_billing": ["operator",
"agent"] }`, matching the pattern already used in
  `docs/building/integration/accounts-and-agents.mdx`. Documentation only —
  no protocol behavior change.

- 7ee3d29: Retire the 8.7 MB Scope3 publisher seed in migration 206. The migration body becomes a no-op (`SELECT 1`) — the data was a one-shot 2026-02-12 Scope3 BigQuery export of 1,250 publishers / 53,422 properties / 62,440 identifiers that aged into a stale snapshot in every runtime image. Production environments retain the data (the migration already ran months ago; Postgres doesn't re-run applied versions). Fresh installs start with an empty `hosted_properties` table and populate via the normal user-claim and discovery-crawler paths. Drops ~9 MB from every shipped image. Closes #4778.
- 8b7e646: feat(scripts): exercise the AAO directory inverse-lookup in the agent-resolution e2e script.

  `scripts/e2e-resolve-training-agent.ts` now optionally appends a directory inverse-lookup after the 8-step forward chain. Given the resolved agent URL, the script calls `fetchAgentAuthorizationsFromDirectory` (shipped in `@adcp/sdk@7.10.0`) against the AAO's `GET /v1/agents/{agent_url}/publishers` endpoint and prints the publishers whose `adagents.json` authorize the agent.

  - HTTP mode: defaults the directory URL to `<base-url>/api` (where the registry router is mounted in `server/src/http.ts`). Pass `--directory <url>` to point at a different directory, or `--directory none` to skip.
  - In-process mode: skipped (the inline Express app doesn't mount the AAO routes, which require database access).

  Pairs PR #4836 (server endpoint) with the SDK's consumer-side wrapper, giving a runnable demo of the full directory chain. Directory failures are caught and reported but don't fail the script — the forward chain is the primary contract, the inverse lookup is an additive demo.

- 9026544: Enforce the v3 envelope integrity storyboard by adding envelope-scoped absent-field checks for legacy `task_status` and `response_status`, and document the check kind in the runner output contract.
- 3e5eddd: Clarify `signal_agent_segment_id` description in `activate-signal-request.json` and `get-signals-response.json` to prevent confusion with the `signal_id` catalog object. The field accepts only the opaque string returned by `get_signals`, not the structured `SignalID` object. Also removes wrong `signal_id`/`destination`/`options` SDK-compat aliases from the training agent's `activate_signal` tool definition. Refs #3349 — the `adcp-client` scenario fix tracked separately.
- 079c25c: Mark `data-provider-signal-selector.json` with `x-adcp-hoist: true` so the schema bundler deduplicates it via root `$defs` instead of inlining it N times.

  In 3.1.0-beta.x, the `tasks-get-response.json` `result` field references `async-response-data.json` — a union of all task response schemas. When bundled, shared sub-schemas get inlined once per referencing response schema. The duplicate `data-provider-signal-selector` instances (a discriminated `oneOf` with `selection_type` values `all`, `by_id`, `by_tag`) caused `datamodel-code-generator` to fabricate a `Literal['reuse']` discriminator value, raising `TypeError: Value 'reuse' for discriminator 'selection_type' mapped to multiple choices` and blocking the entire Python SDK from importing.

  The bundler already has `hoistMarkedSchemas()` for exactly this case. The `x-adcp-hoist: true` directive is build-time only and is stripped from the emitted bundled schemas — the normative wire contract is unchanged.

- a746adf: fix(db): correct stale catalog planner statistics and debounce health-check alerts.

  `catalog_properties` autoanalyze had never run, leaving the planner statistics frozen near zero (~185 rows) while the table actually held 2.27M. With estimates that wrong, Postgres chose nested-loop/sequential-scan plans sized for a tiny table, so queries that scan the catalog/registry tables (brand enrichment, admin audit, registry reads) ran for tens of seconds.

  - Add migration 505: aggressive per-table autovacuum/analyze tuning for `catalog_properties`, `catalog_identifiers`, and `registry_requests` so statistics can never drift that far again, plus a one-time `ANALYZE`.
  - Debounce the `/health` database probe: a single transient connect timeout during a rolling deploy or Postgres failover no longer pages the error channel; alerting escalates only after consecutive failures. The 503 load-balancer response is unchanged.

- c232af3: Fix phantom `FORMAT_INCOMPATIBLE` error code on `create_media_buy` docs. The code was referenced in the error table and two response examples on `docs/media-buy/task-reference/create_media_buy.mdx` but was never defined in `static/schemas/source/enums/error-code.json`. SDKs that validate `errors[].code` against the published enum would reject responses built from the docs literally.

  Migrated all three references to `UNSUPPORTED_FEATURE` — the enum value whose semantics ("a requested feature or field is not supported by this seller") match the "format not in the product's accepted set" case exactly. The error-table row was also merged with the sibling `UNSUPPORTED_FEATURE` row added in #4845 (which covered the v2 `capability_ids[]` failure modes), so a single row now spans both v1 (`format_ids[]`) and v2 (`capability_ids[]`) format-mismatch cases.

  Closes #4852.

- e2c3635: fix(schema): reconcile $ref sandbox host in product-format-declaration (closes #4862)

  `core/product-format-declaration.json#format_schema.description` contained two conflicting normative statements: the `v1_format_ref` mirror-domain migration block (labeled "3.1") says `creative.adcontextprotocol.org/translated/` is the canonical AAO mirror host and that adopters MUST migrate away from the legacy host; the `$ref` sandboxing clause in the same description still named `mirror.adcontextprotocol.org` as the allowed non-same-origin anchor, causing strict implementations of the sandbox to silently reject `$ref`s hosted under the correct domain.

  **Changes:**

  - `core/product-format-declaration.json` `format_schema.description` — two edits:
    1. **Sandboxing of `$ref` bullet:** `(b) hosted under the AAO mirror namespace (\`https://mirror.adcontextprotocol.org/...\`)` → `(b) hosted under the AAO catalog domain (\`https://creative.adcontextprotocol.org/...\`)`
    2. **AAO mirror trust bullet (end of description):** rename to "AAO catalog trust", replace `mirror.adcontextprotocol.org/*` with `creative.adcontextprotocol.org/*`, update surrounding prose to match.
  - `docs/creative/canonical-formats.mdx` `$ref` sandboxing rule (item b) and "AAO mirror" trust anchor note updated to name `creative.adcontextprotocol.org` and use "AAO catalog domain" terminology.

  No structural schema changes. No new fields, enum values, or MUST requirements — this is a normative-text consistency repair. `mirror.adcontextprotocol.org` was never provisioned; `@adcp/sdk` 7.10 already ships both hosts in `DEFAULT_MIRROR_HOSTS` as a transitional posture and can drop the legacy entry on next release.

  Closes #4862.

- e30c0b6: Fix the training-agent `get_products` handler to reject non-string `brief` values with a structured `INVALID_REQUEST` instead of throwing on `toLowerCase()`.
- d9b0cad: Fix inline creative conformance coverage so the training catalog only dual-emits faithful canonical format projections, the inline creative scenario selects `format_options[]` through `format_option_refs[]`, and inline creatives accepted by library-capable sellers are persisted for later creative lookup.
- f67c0c9: Fix storyboard `field_value_or_absent(status, MediaBuyStatus)` checks that created impossible-to-satisfy constraints alongside `response_schema`.

  `protocol-envelope.json` has `required: ["status"]` typed as the TaskStatus enum. Three storyboard checks across `pending_creatives_to_start.yaml` and `available_actions.yaml` were asserting MediaBuyStatus values ("pending_creatives", "pending_start"/"active", "active") at the envelope `status` key — leaving no valid response shape that could satisfy both `response_schema` and the field assertion. Replaced with `field_value(status, "completed")` matching what protocol-envelope mandates for synchronous success. Also updated two stale narrative prose references from "status: pending_creatives" to "media_buy_status: pending_creatives".

  Fixes #5416.

- ef9946c: fix(compliance): replace phantom_unit with devices in reach_buy_flow rejection step

  The rejection_unsupported_reach_unit phase was using reach_unit: "phantom_unit", which
  is not a valid reach-unit.json enum value. Because the step carries negative_path:
  payload_well_formed, the payload must be schema-valid — but phantom_unit caused schema
  rejection before the seller's capability-checking logic ran, so the test was passing for
  the wrong reason.

  Fix: add metric_optimization.supported_metrics: ["reach"] and
  supported_reach_units: ["households", "individuals"] to the reach_ctv_q2 product fixture,
  replace phantom_unit with "devices" (a valid enum value deliberately absent from the
  fixture's declared units), and rename the step id from
  create_media_buy_with_phantom_reach_unit to create_media_buy_with_unsupported_reach_unit.
  The rejection now comes from the seller's business-logic capability check, which is the
  contract the scenario is designed to exercise.

  Closes #4819.

- b49463d: Patch 3.0 compatibility bundles so the frozen `schema_validation` past-start
  branch-set steps use explicit `contributes_to: past_start_handled` flags instead
  of the newer `contributes: true` shorthand. This avoids older runner paths
  missing a passing branch contribution before the final `assert_contribution`
  check, without ignoring real synthetic assertion failures.
- a512989: Fix SignalCoverageForecast schema validation to reject unknown top-level fields while preserving open scope qualifiers for seller-specific denominator metadata.
- fbdd40d: fix(schema): add required status + task_id to all async submitted sub-schemas, close #4077

  All six async-response-submitted sub-schemas (create-media-buy, update-media-buy, build-creative, sync-catalogs, sync-creatives, get-products) were missing `status: const "submitted"` and `task_id` from their `properties` and `required` arrays. The parent task-response schemas already required both fields in their submitted branches; the sub-schemas were simply inconsistent with the parent contract.

  When `task_id` is omitted from a submitted envelope, jsonschema's deepest-schema-path heuristic picks the wrong union branch and reports a misleading status-enum error (`'submitted' is not one of ['pending_creatives', ...]`) instead of the actionable `required: task_id` violation. This sends implementors hunting through the wrong schemas. Empirically verified (adcp-client-python#570).

  Each sub-schema now mirrors its parent's submitted branch: `status: const "submitted"`, `task_id` (x-entity: task), optional `message`, and optional advisory `errors`. `additionalProperties: true` retained to match all parent schemas. Descriptions updated from "usually empty or just context" to accurately describe the async-task polling contract.

  Non-breaking: any conformant 3.0.0 implementation already emits both fields (the parent union's oneOf already enforces them at the wire level). The IETF errata test is satisfied — no previously-conformant implementation needs to change code.

  Cherry-pick to 3.0.x after merge.

- d7acb9d: Fix `supported_macros` schema validation for standard universal macro names.

  `core/format.supported_macros.items` now uses `anyOf` so universal macro enum
  values such as `MEDIA_BUY_ID`, `CREATIVE_ID`, `CACHEBUSTER`, and `CLICK_URL`
  validate without conflicting with the custom string branch. Fixes #5099.

- bebac78: fix(server): align the WorkOS membership integrity invariant with the local membership cache schema.

  The invariant no longer reads a nonexistent `organization_memberships.status` column when checking cached WorkOS memberships. This keeps the audit from failing before it can report stale local membership rows that should be reconciled by the WorkOS sync.

- b62c407: spec(errors): wire-placement guidance for `GOVERNANCE_DENIED` and `GOVERNANCE_UNAVAILABLE`

  `error-code.json` defined the codes' semantics but didn't say WHERE in the response they appear. Different storyboards interpreted differently — issue #3914 surfaced one mismatch where the brand-rights compliance storyboard expected `expect_error: code: GOVERNANCE_DENIED` even though `acquire_rights` already has a first-class `AcquireRightsRejected` discriminated arm with `reason`. Adopters returning the spec-correct Rejected shape were failing the storyboard.

  The `enumDescriptions` for both codes now state placement explicitly:

  - **`GOVERNANCE_DENIED`** — structured business outcome, not a system error. When the task response defines a structured rejection arm (e.g., `AcquireRightsRejected`), that arm is the canonical denial shape — populate `status: "rejected"` + `reason`, do NOT additionally emit the code in `errors[]` or `adcp_error`, and do NOT flip transport-level failure markers. When the task has no rejection arm (e.g., `create_media_buy` returns the `Error` arm), populate `errors[].code` AND `adcp_error.code` per the two-layer model and DO flip transport markers.
  - **`GOVERNANCE_UNAVAILABLE`** — system error, governance call failed at all. Always populate both layers with the code and flip transport markers. Sellers MUST NOT use a structured rejection arm for unavailability even when the task offers one — the buyer's recovery semantics differ (retry-with-backoff vs. restructure-or-escalate).

  The contrast resolves the question the storyboard mismatch surfaced: thrown adcp_error is reserved for governance-call failure modes (parallel to `GOVERNANCE_UNAVAILABLE`), not for adopter-controlled denials.

  The MUST NOT against dual-emission isn't a behavior change — `AcquireRightsRejected` and `CreativeRejected` already declare `not: { required: [errors] }` at the schema layer, so emitting `errors[]` alongside a rejection arm was already a schema violation. The doc-comment makes the rule discoverable from the error code without changing what conformant senders produce.

  Also adds a parallel storyboard-authoring note in `error-handling.mdx`: when the task response has a discriminated rejection arm, assertions should use `check: field_value, path: "status", value: "rejected"` rather than `check: error_code`. The existing `error_code` guidance is correct for tasks without a rejection arm; the new note covers the rejection-arm path that surfaced via #3914.

  Closes the doc-comment item on #3918; companion to #3914 (storyboard fix is separate work).

- 67953a1: docs(governance): non-normative note on per-finding attribution as the audit surface for internal specialist composition

  Doc follow-up to #3015. The merged "One governance agent per account" rationale already explains that internal specialist review (pharma MLR, brand safety, legal, category) composes inside the configured governance agent. This adds one paragraph naming the audit surface that makes the internal decomposition observable: each entry on `check-governance-response.findings[]` carries `category_id` (agent-internal taxonomy — which specialism flagged it) and `policy_id` (the specific policy that triggered). Buyers and sellers see one consolidated decision; per-finding attribution lets them trace which specialist contributed to a denial or condition without the protocol needing to surface multiple agents.

  The schema's `category_id` description already points readers at the spec for the composition story; this paragraph completes the round-trip — spec points back at `findings[]` as the audit surface. Non-normative; zero schema impact.

  Closes #3433.

- 9ce1a6a: Clarify pre-GA 3.1 RC cleanup notes for removed signal-level GPC and proposal action-mode fields.

  Adds pre-GA adopter guidance for cached `requires_proposal` action-mode values, reinforces that `data_subject_rights.gpc_honored` is not part of signal definitions, and documents that projected `consent_basis` / `art9_basis` values on `get_signals` response rows remain provider-declared signal-definition posture rather than seller-substituted basis.

- de5dfde: Fix hosted compliance target recovery after temporary `adcp.supported_versions`
  declaration regressions. Diagnostic storyboard flows now re-derive the hosted
  target from the agent's live supported versions, preferring `3.1-rc`, then
  `3.1-beta`, then `3.0`; canonical badge-writing flows keep the stable `3.0`
  target when the agent still advertises it and only fall forward when no stable
  target is available. Canonical flows now also revoke stale public `3.0` badges
  when confirmed capabilities no longer advertise `3.0` support.

  Also patch the affected `media_buy_state_machine`,
  `measurement_terms_rejected`, and universal idempotency fixture copies to use
  forward-looking Q3 2026 windows, repair selected prerelease
  `measurement_terms_rejected` idempotency aliases, and fail the compliance build
  when a mutating storyboard step authors a stable or duplicate generated
  `idempotency_key`.

- d16b2ad: fix(compliance): raise hosted full-assessment comply() budget to 600s

  @adcp/sdk 9.0.0-beta.28 applies the per-call `--timeout` (default 120s) as the wall-clock budget for the _entire_ pre-flight `comply()` assessment. A full capability-rich assessment legitimately runs ~117s, so the 120s ceiling graded the most compliant agents "unreachable" with 0 steps and let registry cards go stale silently.

  Adds `HOSTED_FULL_COMPLIANCE_TIMEOUT_MS = 600_000` and threads it through every hosted full-suite `comply()` call site — the compliance heartbeat job, the owner/admin registry-refresh endpoint, the `evaluate_agent_quality` member tool, and the heartbeat-mirroring diagnostic script — replacing the prior 60s/90s/SDK-default values.

  The heartbeat in-progress lock TTL now tracks the worst-case serial batch (batch size × budget) so an agent late in the loop isn't re-picked by an overlapping run.

  This is a hosted-side mitigation; it does not change the SDK's CLI default-timeout behavior (tracked upstream in adcontextprotocol/adcp-client#2221). Revisit the 600s budget when the SDK restores per-call timeout semantics.

- 91f417f: IdentityMatch & frequency capping architecture, with the wire-spec change and the data-flow boundary contract landing as authoritative protocol docs. Counting and policy live in the buyer's impression tracker; the IdentityMatch service consumes only cap-fire events at the boundary.

  **Wire spec changes** (`identity-match-response.json`):

  - Adds `serve_window_sec` (integer, 1–300, default 60) — per-package single-shot fcap window. After serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again. Not a router response cache TTL.
  - Removes `ttl_sec`. Originally documented as a router cache TTL but operationally functioned as a per-package serve throttle. TMP is pre-launch (experimental, pre-3.0.0 GA) and not subject to deprecation cycles, so the field is removed outright.

  **Doc updates:**

  - `docs/trusted-match/specification.mdx` — adds `serve_window_sec` field, removes `ttl_sec`, adds normative conformance invariants for IdentityMatch eligibility (audience intersection; cap-state presence check; active state; audience freshness). Updates the caching section for the new contract.
  - `docs/trusted-match/identity-match-implementation.mdx` (new page) — frequency-cap data flow (boundary contract): the cap-fire event the impression tracker writes into the IdentityMatch cap-state store, and how the IdentityMatch service consumes it at query time. The protocol does not constrain how the impression tracker counts impressions, evaluates windows, or decides when a cap fires — those concerns live entirely in the buyer's impression-tracking pipeline.
  - `docs/trusted-match/buyer-guide.mdx` — updates frequency-cap management to reflect the impression-tracker / IdentityMatch split, and the serve-window contract section.
  - `docs/trusted-match/migration-from-axe.mdx` — adds OpenRTB 2.6 `User.eids[]` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

  **Three-layer model:**

  - Wire spec (normative) — what crosses an agent boundary.
  - Conformance invariants (normative) — backend-agnostic eligibility logic, including a presence check against cap-state.
  - Boundary contract (normative for the cap-state store API) — what events flow from the impression tracker into the IdentityMatch cap-state store. Storage backend is implementer choice; the reference store ships in `adcp-go/targeting/fcap` (Valkey 9 hashes with HSETEX).

  **Cap-state store surface:** `RecordCap(userIdentity, fields, expireAt)` and `IsCapped(userIdentity, field)`, where `field` is `{seller_agent_url, package_id}`. v1 keys cap-state at `(user_identity, seller_agent_url, package_id)`; broader-dimension caps (advertiser, campaign, creative, line item) are a future extension to the boundary contract.

  **Architecture history** preserved at `specs/identitymatch-fcap-architecture.md` — captures design decisions, deferred security/privacy follow-ups, the rollout plan, and consolidated Slack/PR-review threads. Earlier iterations of the design (counter-based exposure tracking, log-based tracking with `impression_id` dedup, `fcap_keys` label model) were unwound — counting, dedup, and policy evaluation depend on buyer-internal concerns the protocol shouldn't constrain.

  All TMP surfaces remain `x-status: experimental`. Per the experimental-status contract, fields on this surface are not subject to deprecation cycles until 3.0.0 GA.

  **Tracked deferred follow-ups** (not in this PR):

  - TMPX harvest → competitor-suppression attack
  - Eligibility-as-audience-membership oracle (honeypot package_ids)
  - Consent revocation between IdentityMatch and impression
  - Side-channel via eligibility deltas
  - `hashed_email` in TMPX leak surface
  - DoS amplification via large `package_ids[]`
  - Cap-state extensions for advertiser/campaign/creative dimensions
  - Identity-graph plug-point in the impression tracker

- 122ee3b: Update the Python lockfile to idna 3.15, including the upstream fix for oversized IDNA input handling.
- 62af2cc: Allow the ads.txt `managerdomain` fallback when a publisher's direct `adagents.json` fetch returns an S3/CloudFront-style `403` `AccessDenied` XML response as well as `404`, while preserving manager-side scoping checks.
- a4e67f0: Stop paging `#admin-errors` on expected per-agent / per-API failures.

  - `/api/discover-agent` now classifies the discovery error via `classifyMCPError` and logs `unreachable` / `wrong_path` (e.g. stale `*.trycloudflare.com` tunnel URLs, agent advertising MCP at a non-standard path) at `warn` with a structured `kind` + actionable `message` in the 502 response. Only `unknown` kinds still escalate via `logger.error`. `TimeoutError` was already a separate branch and is now `warn` too, since it's a per-agent issue rather than a system fault.
  - `lumaFetch` no longer logs `logger.error` on every non-2xx; it just throws. Every call site already logs on catch — `getEventHosts` deliberately at `debug` because hosts API access is best-effort — so 404s from `/event/get-hosts` (events the API key can't see) stop paging. The endpoint, status, and body are now included in the thrown message so callers' single error log still has them.

- a93d2b0: fix(compliance): `measurement_terms_rejected` — UUID-aliased idempotency_keys + spec-aligned narrative

  The `media_buy_seller/measurement_terms_rejected` storyboard shipped hardcoded `idempotency_key` literals on both `create_media_buy` steps. Combined with runner-side dynamic `start_time` substitution (the runner shifts stale dates forward to keep the buy future-dated), this produced **same key + different body** on every run against a long-running seller deployment, arming the spec-mandated `IDEMPOTENCY_CONFLICT` on the seller side. Switch to `$generate:uuid_v4#…` aliases so each run mints fresh keys (matches the established pattern across the storyboard suite).

  Also rewrites the narrative, which previously told implementers the buyer "retries the same `create_media_buy` `idempotency_key` with an adjusted payload" — a direct spec violation — to describe minting a fresh key for the retry.

  Closes #4219. Refs adcontextprotocol/adcp-client#1586.

- a9a306c: Membership dashboard now treats org-level agreement state as the pre-payment source of truth. Standalone agreement acceptance immediately updates the card, checkout skips the redundant agreement modal when the current version is already accepted, and invoice requests hide the agreement checkbox when the current version is already on file. Stale stored agreement versions are rejected server-side so prospects are asked to accept the current agreement before invoicing.
- f9a1edd: Membership upgrade flow now follows the Stripe Customer Portal URL when `/api/checkout-session` returns 409. Previously the dashboard surfaced "Upgrade" buttons for tiers above the org's current sub, but clicking them routed through the checkout intake — which `blockIfActiveSubscription` refuses by design — and the client discarded the `customer_portal_url` from the 409 body, dead-ending the user on a toast like "already on Explorer ($50.00)". `proceedToCheckout` in `dashboard-membership.html` and both checkout entry points in `dashboard.html` now redirect to the returned portal URL so tier changes complete end-to-end.
- 9044bd3: Add stable validation IDs and tighter atomic-success assertions to the refine finalize-exclusivity storyboard so multi-finalize grading failures identify the exact failing assertion in reports.
- 118d760: spec(preview_creative): allow non-expiring preview URLs by making `expires_at` optional

  `preview_creative` responses previously required `expires_at` for single previews and successful batch results, but the spec did not define how agents should represent preview URLs that do not expire. The response schema now allows omitting `expires_at`; documentation clarifies that a present timestamp marks the time after which consumers should treat preview URLs as invalid, while an omitted timestamp means the preview URLs do not expire.

  This relaxes validation for existing non-expiring implementations without changing the meaning of responses that already include `expires_at`. Closes #4453.

- 469b6d3: Add `discriminator: { propertyName }` to 16 `oneOf` unions in `static/schemas/source/` whose variants already declare the same required property as a `const` with distinct string values, and tighten `scripts/audit-oneof.mjs` to assert that any `discriminator.propertyName=X` is backed by every non-ref variant declaring `properties.X` as required const with distinct values.

  Affected schemas: `adagents.json`, `compliance/comply-test-controller-response.json`, `content-standards/artifact.json`, `core/activation-key.json`, `core/creative-item.json`, `core/deployment.json`, `core/destination.json`, `core/optimization-goal.json` (3 unions), `core/requirements/catalog-field-binding.json` (2 unions), `core/signal-pricing.json`, `creative/preview-creative-response.json`, `creative/preview-render.json`.

  Non-breaking: the OpenAPI `discriminator` keyword is ignored by JSON Schema 2020-12 validators that don't recognize it; the existing `const`-property pattern remains the source of truth. Codegen targets that respect the keyword (msgspec, openapi-typescript, datamodel-code-generator) now emit a properly-narrowed union without per-variant casts. Tracking: adcp#3917.

- c09f2e0: Add `discriminator: { propertyName }` to two more `oneOf` unions previously deferred from #3928:

  - `core/pricing-option.json` `#/oneOf` (`pricing_model`) — Ajv resolves the cross-file `$ref` to each `pricing-options/*-option.json` correctly when all schemas are pre-loaded; the deferral was based on a faulty isolated-compile test.
  - `core/format.json` `#/properties/assets/items/oneOf/14/properties/assets/items/oneOf` (`asset_type`) — required `asset_type` on each of the 12 inner variants directly so Ajv's discriminator support can find it without traversing `allOf`.

  The 15-variant outer oneOf at `#/properties/assets/items` is still deferred — it mixes `item_type: "individual"` (14 variants with `asset_type`) and `item_type: "repeatable_group"` (no `asset_type`), so a single discriminator key doesn't cover it without a structural restructure. Tracked separately. Same for the boolean-discriminator unions (`get-adcp-capabilities-response.json` `supported`, `update-content-standards-response.json` `success`) which need an enum migration. Tracking: adcp#3917.

- 9357289: fix(ci): OpenAPI generator merge-preserves hand-authored registry.yaml paths

  PR #4771 added 685 lines of brand-registry endpoint documentation directly to `static/openapi/registry.yaml` because those routes (brand.json, brand-logos upload/list/review, brand ownership, brand wiki, brand-logos moderator queue/preview) are docs-only — the Express routes exist but were never given Zod schemas. The TypeScript Build CI step runs `npm run build:openapi && git diff --exit-code` and treats any drift as a failure, so #4771 was merged with the freshness lint already failing on main and every subsequent PR's CI has been red on the same step.

  Rather than force every adopter to wire Zod schemas before they can ship a docs change, the generator now reads the on-disk yaml and unions its tracked output with anything already there — paths, component schemas, and tag descriptors. Generator output wins on conflicts so Zod-backed paths remain the source of truth; docs-only entries (the brand-registry surface, and any future hand-authored additions) are preserved across regens.

  Brand Logos and Brand Wiki tag descriptions moved into `scripts/generate-openapi.ts`'s `TAG_DESCRIPTIONS` map so they emit in their documented position (between Brand Resolution and Property Resolution) instead of getting appended to the tag list.

  `static/openapi/registry.yaml` carries a 2-line whitespace normalization from the YAML library's standard re-serialization — quoted string forms collapse to unquoted where YAML permits, semantically identical.

- 349acfd: Fix P1 registry and compliance follow-ups: serve public agent registry profile pages, register member portrait tools in Addie runtimes, reuse authenticated format-discovery SDK clients without caching authenticated responses, and add phase-level capability gates for deterministic testing protocol families.
- e6569b5: test(compliance): add a media-buy compatibility storyboard for legacy package correlation without `product_id`.

  The new non-required `media_buy_seller/package_correlation_legacy_fallback` scenario seeds a legacy-shaped media buy whose package omits `product_id` and verifies buyers can recover package correlation through persisted package `context.buyer_ref`.

- 2b26d5b: Mark the `pagination_integrity_creative_formats` storyboard as controller-gated so agents that intentionally omit `comply_test_controller` skip the storyboard at load time instead of cascading into mid-storyboard fixture seeding skips.
- a5614b4: Clarify that brand.json may contain multiple same-type `agents[]` entries when
  they use distinct endpoint URLs, such as one sales-agent URL per publisher
  tenant. Each entry can publish its own static `jwks_uri` shard; dynamic key
  routing is optional rather than required.
- 9a50d4e: verification: cleanup follow-ups after #3524 ships.

  **Docs.** `docs/building/aao-verified.mdx` was last updated for the orthogonal-axes framing (#3536) but didn't mention the per-version model that #3524 just shipped. Updated:

  - New "Per-version badges" section explaining that each badge is identified by `(agent, role, AdCP version)`, agents can hold parallel-version badges, and version-pinned vs. legacy URL behavior.
  - "Display" section now documents both URL shapes (`/badge/{role}.svg` auto-upgrade and `/badge/{role}/{version}.svg` version-pinned), with examples for each.
  - JWT claim block adds `adcp_version` and explicit verifier guidance ("verifiers MUST check `adcp_version` against the AdCP version they care about" — closes the cross-version replay concern raised in the Stage 2 security review).
  - "Registry filter" section gains a "brand.json enrichment" subsection documenting the `aao_verification.badges[]` array, the `roles[]` / `modes_by_role` deprecation notice, and the AdCP 4.0 removal target.

  **Refactor (testability).** `enrichAgentEntries`'s shaping logic was a closure inside the brand.json route handler — unreachable from unit tests. Extracted to `services/aao-verification-enrichment.ts` as `buildAaoVerificationBlock(badges)`. The route handler keeps the JSON traversal and assignment; the builder is a pure function with 14 new unit tests covering empty input, single-badge, multi-version dedupe (caller-ordering preserved), modes_by_role flattening (the "buyer pinned to 3.0 sees the wrong contract" footgun), adcp_version shape filtering (defense in depth), and the deprecation notice content. Code-review nit on PR #3604.

  **Trivia.** `PROTOCOL_LABELS` in `dashboard-agents.html` gained a comment pinning the invariant that label values must not end in "Agent" (otherwise `${protocol} Agent${versionSegment}` would produce "Media Buy Agent Agent 3.1"). DX expert nit from #3603.

  What this PR does NOT change:

  - Wire format on any surface — the brand.json enrichment output is byte-for-byte identical to what shipped in #3604.
  - Panel UX — role grouping and "show all versions" disclosure (#3603) explicitly defer until parallel-version badges land in production and we have real buyer feedback to design against.

- 445a011: Restore 3.0 as the default hosted compliance target and keep public badge
  issuance scoped to the selected stable compliance line. Previously, the 3.1
  beta default could reject 3.0-only agents or leave premature public 3.1 badges
  visible; stale public 3.1 badges are now revoked until that line is GA-ready.
- a20bd60: Switch the 3.1 prerelease train from beta mode to RC mode.

  This is a release-process-only baseline: package and schema metadata move to
  `3.1.0-rc.0` so the GitHub Changesets release workflow can generate the signed
  `3.1.0-rc.1` Version Packages PR.

- a1b89c9: Add `proposal_finalize_asap_timing` storyboard scenario covering `start_time: "asap"` on `create_media_buy`.

  The existing `proposal_finalize` scenario only tested the ISO 8601 date string form. This new scenario
  exercises the spec-defined `"asap"` string literal (from `start-timing.json`), catching wrapper-layer
  rejections that accept ISO dates but reject the asap form before the handler runs. Registered under
  both `sales-guaranteed` and `sales-proposal-mode` specialism indexes.

- 579d205: compliance(storyboard): fix proposal-mode fixture authoring in `sales_proposal_mode` and `media_buy_seller/proposal_finalize`

  Two pre-existing storyboard authoring issues, surfaced by `@adcp/sdk` PR #1603 (which made `create_media_buy` actually exercise proposal-mode end-to-end instead of silently sending `packages` regardless):

  1. **`sales_proposal_mode`** authored `proposal_id: "balanced_reach_q2"` as a literal in two places (refine step + create_media_buy step). The training-agent's seed proposals don't include that id (it seeds `pinnacle_cross_channel`, `viewpoint_multi_screen`, `sparq_social_amplification`, `novamind_ai_audience`). Switched both to `$context.proposal_id` so the storyboard dynamically references whichever proposal the brief returned, matching the pattern `media_buy_seller/proposal_finalize` already uses.

  2. **Both storyboards** now include `io_acceptance` on the `create_media_buy` fixture. AdCP 3.0+ proposals with guaranteed inventory carry an `insertion_order` with `requires_signature: true` after finalization; sellers reject `create_media_buy` against such proposals without `io_acceptance`. The finalize step's `context_outputs` captures `proposals[0].insertion_order.io_id`, and the create_media_buy step references it via `$context.io_id`.

  3. **`sales_proposal_mode`** previously jumped straight from refine to create_media_buy, which kept the proposal in `draft` status. Added a `finalize_proposal` phase between them (matching the pattern in `media_buy_seller/proposal_finalize`) so the proposal transitions to `committed` before acceptance.

  Forward-compatible with both pre-#1603 and post-#1603 SDK behavior — all six tenant matrix runs pass against both. /sales lifts from 258 → 259 steps (the new finalize step counts).

  Patch-eligible per the conformance-additive rule (additive scenarios / fixture corrections that bring storyboards into alignment with the spec's own normative proposal-lifecycle).

- 7390f7f: Prevent protocol tarball signature sidecars from being republished for old
  versions, revalidate CDN sidecars, and verify the published tarball tuple with
  retries in the release workflow.
- 7c63315: docs(provenance): frame provenance as transport, not compliance; warn on `human_oversight` ↔ `disclosure.required` combo

  Three honesty tightenings to the AI provenance and disclosure surface in response to external legal review of the regulatory framing:

  - **`docs/creative/provenance.mdx`**: The intro `<Info>` callout previously read "AdCP's provenance metadata _provides_ the structured, machine-readable disclosure that these regulations require." That overstates what a wire format can do — the legal obligation under EU AI Act Article 50(5) is a user-facing disclosure by the deployer at first exposure, not a transmission obligation on the supply chain. Rewrites to describe AdCP as the transport that carries the signals these regulations rely on, with the legal obligation remaining with the deployer.

  - **`docs/creative/provenance.mdx`**: Adds a `<Warning>` in the Human oversight section noting that `human_oversight` and `disclosure.required` are independent — the protocol does not derive one from the other. Article 50(4) carve-outs for human-edited or human-directed AI output have factual prerequisites the schema cannot evaluate, so asserting `human_oversight: edited` or `directed` does not by itself justify `disclosure.required: false`. Sellers and governance agents may treat the combination as audit-worthy. Closes the obvious abuse vector a hostile reading would name first.

  - **`docs/governance/creative/provenance-verification.mdx`**: Rewrites the Art 50 and SB 942 mapping paragraphs. Art 50 obligations sit on providers (50(2)) and deployers (50(4)/(5)), not the supply chain — the deployer in advertising is typically the advertiser or agency. SB 942 obligations sit on covered platforms (MAU threshold). In both cases, `disclosure.required` is the declaring party's claim, not a determination the protocol makes; a seller relying on `required: false` without verification is relying on a buyer's claim.

  - **`static/schemas/source/core/provenance.json`**: Mirrors the warnings in the `human_oversight` and `disclosure.required` field descriptions so SDK consumers reading the schema get the same framing.

  No wire changes; descriptions and prose only.

- 85401c5: Add an admin publisher `adagents.json` revalidation endpoint that refreshes the cached registry verdict, records validation metadata, and retires stale publisher-origin authorizations when a live recheck fails.
- 9352ac9: Update Puppeteer development tooling to 25.0.4.
- f34ba8b: docs(webhooks): clarify that the **registration channel** determines webhook envelope shape — there is no per-call discriminator. AdCP `push_notification_config` (task arg) always delivers the AdCP `mcp-webhook-payload` envelope; A2A `TaskPushNotificationConfig` (native A2A push registration) always delivers A2A `StreamResponse`-wrapped `Task` / `TaskStatusUpdateEvent` per A2A 1.0 §4.3.3. The two channels are independent and a buyer MAY register both.

  This closes [adcontextprotocol/adcp#4246](https://github.com/adcontextprotocol/adcp/issues/4246) without a schema change. The issue's premise — "sellers default to match inbound transport, buyers need an override field to escape it" — was wrong: each registration channel is already purpose-built for its envelope shape, so the buyer picks the channel that matches the receiver. An A2A sync buyer that wants AdCP-shape webhooks puts `push_notification_config` in the AdCP task args inside the `SendMessage` body — no new field needed; an A2A buyer that wants A2A-shape webhooks registers through A2A's native push mechanism.

  Verified against [a2a.proto §TaskPushNotificationConfig](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto): A2A 1.0's push config has no encoding-negotiation field, confirming that wire shape is fixed per-channel rather than per-registration.

  **`docs/building/by-layer/L3/webhooks.mdx`** — replaces an earlier draft of a "Protocol override" subsection with §"Registration channel determines envelope shape": a two-row table mapping registration channel to delivered envelope, the rationale for channel-as-discriminator over transport-matched, and the typical "A2A sync, AdCP-shape webhooks" case worked example.

- bae9db1: Add universal compliance coverage for the AdCP 3.1 read-tool `idempotency_key` contract.

  The new `read_tool_idempotency` storyboard verifies that representative read
  tasks accept the every-request envelope fields (`idempotency_key`, `context`,
  and `ext`) without strict wrapper rejection, while documenting the 3.1
  omitted-key grace probe that should become a required rejection in the 3.2
  storyboard cut.

- 1d4cd0d: Fix stale email in admin person-detail view and member list after a primary-email swap. `person_relationships.email` and `organization_memberships.email` denormalize `users.email`, but the three write paths that mutate `users.email` (`mergeUsers`, `PUT /api/me/linked-emails/primary`, and the WorkOS `user.updated` webhook) were not all refreshing both denorms — the most common gap was `person_relationships.email`, which is what the admin "person" header reads. Refreshes are now applied in all three paths inside the same transaction as the swap, and a backfill migration (476) repairs the rows that already drifted.
- 56caaf2: Register `verify_brand_claim`, `verify_brand_claims` (bulk), and the shared `verification-status.json` enum in `static/schemas/source/index.json`. The tools and schemas shipped in PRs #4540 and #4603 but the central schema registry was missed — this restores parity with `get_brand_identity`, `get_rights`, etc., for any consumer that reads the registry for discovery (closes #4604).
- 9bfeb9e: Stop posting agent/user input errors to `#admin-errors`. The MCP server catch block now distinguishes `ToolError` (expected — logged at `warn`) from genuine exceptions (logged at `error`), matching the pattern already used in `claude-client.ts`. `POST /api/registry/properties/save` and `POST /api/registry/brands/save` now pre-check `review_status === 'pending'` and return 409, parallel to the existing authoritative-source check, instead of letting the DB throw and bubble up as a 500.
- f74aa81: spec(conformance): rejection-arm vs `errors[]` mutual-exclusion test + storyboard alignment

  Closes #3998. The wire-placement guidance on `GOVERNANCE_DENIED` (shipped to `main` via #3929 and to 3.0.x via #3996) is normative MUST-language: when a task response defines a structured rejection arm (`AcquireRightsRejected`, `CreativeRejected`), the arm IS the canonical denial shape — sellers MUST NOT additionally emit the error code in `errors[]` or `adcp_error`. The schema enforces this with `not: { required: ["errors"] }` on each rejection arm.

  Until now the rule was asserted only in prose. This change adds executable conformance:

  - **`tests/rejection-arm-mutual-exclusion.test.cjs`** — schema-validation conformance check that fails before the storyboards do if the `not: { required: ["errors"] }` constraint regresses on either rejection arm. Asserts both directions: canonical rejection-arm shape (status + reason, no errors[]) accepts; rejection-arm with errors[] populated rejects. Wired into the aggregate `npm test` run.
  - **`brand_rights/governance_denied` storyboard** — assertions corrected to the rejection-arm path. Was asserting `check: error_code, value: "GOVERNANCE_DENIED"` on a task whose canonical denial shape is `status: "rejected"` + `reason`. Now asserts `field_value path: "status" value: "rejected"` plus `field_present path: "reason"`. Closes the storyboard portion of #3914 (storyboard was rejecting spec-correct adopter responses).
  - **`media_buy_seller/governance_denied` storyboard** — narrative tightened to make Case-2 of the rule explicit (no rejection arm → `errors[]` + `adcp_error` populated; transport markers flipped). Cross-references the brand-rights scenario as the Case-1 counterpart.

  Wire format unchanged. Schema constraints unchanged. Pure conformance + documentation: the schema rule was already in place; this change makes it discoverable from a failing test and aligns the existing storyboards with the rule.

- ed925eb: Fixes release artifact publication so Version Packages commits upload protocol assets and R2 artifacts even when Changesets reports no publish output. No package release is needed.
- 9863d4f: Fix release-blocking compliance storyboards by preloading a creative before media buy state-machine pause/resume checks and removing stale proposal flight start dates from proposal probes.
- f37f270: Prevent the release workflow from republishing existing RC protocol assets on later release-relevant merges.
- 47e4280: compliance(request-signing): add negative vector 028 — unsigned `tasks/cancel` JSON-RPC POST → `request_signature_required` (closes #4327)

  Vector 028 grades the `protocol_methods_required_for` namespace introduced in #4326. The runner POSTs an unsigned `{"method":"tasks/cancel",...}` JSON-RPC body to a verifier whose capability declares `required_for: []` and `protocol_methods_required_for: ["tasks/cancel"]`. A correct verifier resolves the JSON-RPC envelope's `method` field, matches it against `protocol_methods_required_for`, and rejects with `request_signature_required`. A verifier that only consults `required_for` (the AdCP-tool namespace) would silently accept — which is the regression this vector locks out.

  Gating: vector 028 is skipped when the agent doesn't declare `protocol_methods_required_for`. When the agent declares the bucket but doesn't enforce it, the vector FAILs (does not SKIP). Same shape as the existing capability-gated negative vectors.

  Conformance harness addition only — no schema changes, no normative spec changes. Patch-eligible per the playbook (additive scenarios are patch-eligible). Cross-namespace match prevention (signed `tools/call` with `params.name: "tasks/cancel"` MUST NOT satisfy `protocol_methods_required_for`) is enforced server-side via the test-agent's `mcpOperationResolver` and unit-tested there; a positive-vector cross-namespace test deferred to a future PR (requires a live signing harness for the positive case).

- 114f244: spec(conventions): reserve `ctx_metadata` as adapter-internal round-trip key

  Reserves the top-level key `ctx_metadata` on AdCP resource objects (Product, MediaBuy, Package, Creative, AudienceSegment, Signal, RightsGrant) as a publisher-to-SDK round-trip cache for adapter-internal state. SDKs MUST strip the key before wire egress and MUST emit a warning-level log entry when stripping, so operators can detect accidental collisions with existing adapter code. Buyers never see this field.

  The convention is non-binding at the wire level — these resources already declare `additionalProperties: true` so existing payloads remain valid. The reservation locks the keyword name before two SDKs converge on it accidentally and ship divergent semantics. PropertyList and CollectionList are out of scope (`additionalProperties: false`) until a follow-up PR widens those schemas.

  Closes #3640.

- b8b890f: Clarify that `revoked_publisher_domains[]` applies to all three authorization-type branches — including `inline_properties`. The schema description and managed-networks.mdx validator-behavior bullet previously enumerated only two of three branches (`publisher_properties` selectors and top-level `properties[].publisher_domain`), leaving `authorized_agents[].properties[].publisher_domain` (the `inline_properties` authorization type) ambiguous. Added `inline_properties` to both enumerations to unblock SDK implementations holding the third branch pending this clarification. Closes #4869.
- 045d57f: Fix: `save_agent` and `PUT /registry/agents/:url/connect` now reject auth tokens containing NUL, CR, or LF bytes with a clear user-facing message, instead of bubbling a Postgres `invalid byte sequence for encoding "UTF8": 0x00` 500 from the `auth_token_hint` TEXT-column write. The hint generator also sanitizes those characters as defense-in-depth. NUL crashes Postgres TEXT-column writes; CR/LF are HTTP header-injection vectors — neither is legitimate in an Authorization header per RFC 7235.
- a091c67: Gate schema-validation temporal checks with per-step `requires_tool: create_media_buy` so agents that do not advertise media-buy creation skip those checks instead of false-failing.
- 7aeca49: chore(deps): bump `@adcp/sdk` to ^6.19.0; drop vector-028 skipVectors workaround

  `@adcp/sdk@6.18.0` added the adversarial builder for conformance vector `028-unsigned-protocol-method-required` ([adcp-client#1644](https://github.com/adcontextprotocol/adcp-client/pull/1644)), which the test-agent's storyboard matrix had been skipping via `skipVectors` since vector 028 landed in [adcp#4335](https://github.com/adcontextprotocol/adcp/pull/4335). `6.19.0` ships the proposal-mode enricher fix ([adcp-client#1649](https://github.com/adcontextprotocol/adcp-client/pull/1649)) that PR #1603's over-application surfaced — required for the storyboard matrix to stay green at SDK 6.18+.

  Vector 028 grades the `protocol_methods_required_for` namespace introduced in [adcp#4326](https://github.com/adcontextprotocol/adcp/pull/4326) — an unsigned `tasks/cancel` JSON-RPC POST against a verifier declaring `protocol_methods_required_for: ["tasks/cancel"]` MUST 401 with `request_signature_required`. The test-agent's strict route already enforces this; this PR closes the loop by removing the local skip so the runner actually exercises the vector.

  Matrix lift (+1 step per tenant from vector 028 grading):

  | Tenant            | Before | After |
  | ----------------- | ------ | ----- |
  | /signals          | 58     | 59    |
  | /sales            | 258    | 260   |
  | /governance       | 102    | 103   |
  | /creative         | 118    | 119   |
  | /creative-builder | 100    | 101   |
  | /brand            | 45     | 46    |

- 8b7e646: chore(deps): bump @adcp/sdk 7.7 → 7.10.2 — catches the spec repo up on the 7.x line.

  Pulls in 7.8's `impairment.coherence` audience-inverse grading + `creative_approvals[]` walk, 7.8's `ctx.input` surface on v6 platform methods (adoption in our v6 shims is a follow-up), 7.9's `pgCtxMetadataStore.resource` round-trip, and 7.10's `fetchAgentAuthorizationsFromDirectory` + typed `AGENT_SUSPENDED`/`AGENT_BLOCKED` codes. 7.10.0/7.10.1 had v2/projection packaging gaps that crashed `/sales` storyboards; both fixed via adcp-client#1909 (catalog) and adcp-client#1917 (registry).

  Spec-side behavior unchanged; storyboard floors held without modification.

- 95fb4ee: Bump `@adcp/sdk` to `9.0.0-beta.23`, update the training agent to import
  `CreativeManifestSchema` from the public `@adcp/sdk/schemas` export, pass
  `context` through the list_transformers tenant tool, advertise `3.1-rc.7`
  support, and remove manual list_transformers storyboard skips now covered by the
  SDK. Align the 3.0 compatibility sales storyboard step floor with the beta.23
  runner's skip accounting.
- a007806: Bump `@adcp/sdk` to `8.1.0-beta.18` so local and CI storyboard runs enforce
  `field_pattern` / `envelope_field_pattern` validations and include required
  task webhook `operation_id` payloads, then teach the training agent to accept
  the current `3.1-rc.4` wire release pin emitted by that runner.
- 5f34101: Bump `@adcp/sdk` to `8.1.0-beta.19` to pick up the storyboard request-builder fix
  (adcp-client #2144, closing #2143): `create_media_buy` flight windows are now
  resolved as a pair, so a frozen-compliance-bundle fixture with a past `start_time`
  and a same-day `end_time` no longer defaults the start forward into
  `start_time > end_time`. Fixes the one-day `Storyboards (3.0-compat /sales)`
  regression where `measurement_terms_rejected` and `media_buy_state_machine` failed
  on the flight's end date (dropping clean storyboards below the floor) on every PR
  and `main` run that landed on that calendar day.
- 9743af1: Bump `@adcp/sdk` to `8.1.0-beta.21` to consume the storyboard request-enrichment clock fix.

  `3.0-compat /sales` began failing on 2026-06-01 with `create_media_buy_replay: IDEMPOTENCY_CONFLICT` (`64 clean`, floor `65`). The idempotency replay test requires the initial and replay `create_media_buy` requests to be byte-identical, but the runner's `resolveMediaBuyWindow` resolved the flight window with a per-call `Date.now()`. Once the frozen 3.0.15 fixture's `start_time` (2026-06-01) went past, the window fell to a now-relative default computed independently in each step → different canonical payload → conflict. This was branch-independent (main re-run today failed identically) and not self-healing.

  `@adcp/sdk@8.1.0-beta.21` (adcp-client #2149, closing #2147) threads a stable per-run clock (`runStartMs`) into `resolveMediaBuyWindow`, so both steps enrich with the same `now` → identical window → byte-identical payload. Verified: typecheck clean and the 3.0-compat storyboard matrix returns to its floor under beta.21.

  beta.21 also pins the SDK to AdCP 3.1.0-rc.6 (adcp-client #2145), so the storyboard runner now negotiates `3.1-rc.6`. The training agent's supported-version allowlist had stopped at `3.1-rc.4` (a latent skew — the repo is already on rc.6), so it rejected the runner with `VERSION_UNSUPPORTED` on the current-source matrix. Added `3.1-rc.6` to both allowlists (`task-handlers.ts`, `tenants/router.ts`), bumped `CURRENT_ADCP_VERSION` to rc.6 so the agent's current/highest-served version matches the repo, and updated the affected unit-test assertions.

- c27e27f: Bump `@adcp/sdk` to `9.0.0-beta.29` so hosted and local storyboard runs pick
  up phase-level `requires_capability` enforcement. Protocol-specific phases in
  universal storyboards now skip as `not_applicable` before dispatch when the
  agent does not advertise the gated capability.

  The training agent now also advertises and accepts the SDK runner's `3.1-rc.14`
  wire pin so local storyboard matrices do not reject current prerelease probes
  with `VERSION_UNSUPPORTED`.

- c9ca76d: Bump `@adcp/sdk` from ^7.3.0 to ^7.6.0. The SDK now registers the `impairment.coherence` storyboard assertion (adcontextprotocol/adcp-client#1801) and emits a `not_applicable` hint for inverse-rule deferred families (#1810), unblocking the wiring on all five specialisms that exercise the cross-resource join — `audience-sync`, `sales-catalog-driven`, `creative-ad-server`, `creative-template`, `creative-generative`. The transient deferral introduced earlier in this PR is reversed.

  Storyboard floors re-baselined to capture the SDK's new storyboards (+2 per tenant typical) and the `/governance` step-skip reclassification (−2 passing steps, +4 clean). Same pattern as the SDK 7.0.0 bump in #4465.

  No spec changes here — this changeset is the tooling enable-step only. The `impairment.coherence` rule, scope, and docs land in `.changeset/2859-impairment-coherence-assertion.md` (minor). Read together.

- 210b8a7: Add SHOULD on `product-format-declaration.json`: sellers SHOULD publish `capability_id` on every `format_options[]` entry — not just when structurally required to break a `format_kind` collision. Without it, V2-mental-model buyers using the `PackageRequest.capability_ids[]` path added in #4845 (and the long-standing `creative-manifest.capability_id`) can't address the entry, fall back to v1 `format_ids[]`, and lose the cross-publisher-stable naming the V2 authoring path was designed to provide.

  Co-located with #4845's buyer-side change so 3.1 release-notes readers see the buyer capability and the seller obligation together. No structural change — capability_id remains optional at the schema level; this is description-text only. The 4.0 cutover will tighten SHOULD → MUST (tracked in #4857).

  Closes #4856.

- 7c0f1ae: Fix event administration for Singapore chapter leads and other eligible committee leaders.

  Luma-synced events now update existing AAO event records, move generated slugs when canonical title/date fields change, and preserve old public URLs through slug redirects. Addie event management is scoped to AgenticAdvertising.org admins or leaders of linked eligible committees, and public old-slug lookups now keep draft and invite-only events hidden before redirecting.

- 4a98e74: docs(skill): document the four implementation-dependent `issues[]` fields callers may see

  `skills/call-adcp-agent/SKILL.md` already documents the three required `issues[]` fields (`pointer`, `keyword`, `variants`) that every conformant validator surfaces. Adds the four optional fields a calling agent will encounter when the seller's validator opts into them — `discriminator`, `schemaId`, `allowedValues`, `hint` — with a one-line preface clarifying these are implementation-dependent (not every validator emits them) and an updated recovery order: read `hint` first when present, then `discriminator`, then walk `variants`.

  Two new rows added to the symptom-fix lookup table for the same fields.

  No wire-format change. Pure documentation: shipping these fields is already a valid validator extension; this just gives callers a curated path through them.

  Surfaced from the @adcp/sdk side after PR #1283 / #1309 added the fields and PR #1268 / #1361 hit recurring drift between the local SDK skill copy (which already documented them) and the upstream bundle (which didn't). With this merged, the SDK's `npm run sync-schemas` no longer rewrites the file out from under contributors.

- 92c8382: docs(creative): social-DPA video catalog pools + catalog-driven single-item render pattern; add `card_video_max_file_size_kb` parity field

  Clarifies that catalog asset pools accept video as a first-class asset group — `core/asset-group-vocabulary.json` already defines `video`, `video_vertical` (9:16), and `video_horizontal` (16:9) pools, and a feed URL mapped via `feed_field` + `asset_group_id` is wrapped as an image _or_ video asset depending on the pool. Documented at the "Typed catalog assets" and "Feed field mappings" anchors in `docs/creative/catalogs.mdx`. Docs-only; the capability already ships (#5272).

  Documents the catalog-driven single-item render pattern — the platform composes one SKU per impression (Meta DPA single-product render, Snap Collection single-item, TikTok Shopping single-SKU) — using the existing `sponsored_placement` `fanout_mode: single_item`, and links the four adapter-contract families page. Extends the existing asset-bundle-vs-catalog-row prose in `docs/creative/canonical-formats.mdx`. Docs-only; addresses the docs half of #5277. The buyer-selection field and double-brace macro token syntax are deliberately out of scope (separate WG decision).

  Adds one optional `card_video_max_file_size_kb` (integer, minimum 1) to `image_carousel.json` as the video twin of the existing `card_image_max_file_size_kb`, so the two per-card file-size caps sit together. Additive optional field on a non-experimental canonical = backward-compatible patch. No codec/container enums or new `card_media_types` vocabulary (#5274).

  Closes #5272, #5274. Addresses docs half of #5277.

- e815fc8: Clarify Sponsored Intelligence sponsored-context accountability docs with provider declaration, host receipt, user-facing disclosure, and audit evidence responsibilities.
- d8af977: Add `stale_response_advisory` universal storyboard verifying STALE_RESPONSE wire placement (advisory in `errors[]` on populated success response, transport stays success). Adds `force_upstream_unavailable` scenario to comply_test_controller request/response schemas so sellers can deterministically exercise stale-cache fallback paths in compliance testing.
- 4150f34: fix(training-agent + compliance): re-baseline storyboard floors after fixing four pre-existing failures on main.

  Main was running at the exact 69-clean floor for `/sales` with 4 storyboards real-failing — any flake on `media_buy_seller/audience_buy_flow`'s phantom-rejection step dropped it below floor. Four bugs, each independent:

  - **`/sales/mcp` (v6 framework) was missing `syncEventSources` and `logEvent`** in `TrainingSalesPlatform`. The SDK framework only advertises platform methods that exist, so `sync_event_sources` / `log_event` steps in `event_dedup_flow` and `performance_buy_flow` were silently skipped — leaving subsequent `create_media_buy` steps with optimization_goals referencing event_sources rejected as "not registered". Wired both methods through to the v5 handlers with brand_domain threaded from `ctx.account.ctx_metadata` (same pattern as `syncAudiences`).
  - **Phantom-rejection steps in `audience_buy_flow` and `performance_buy_flow` were missing `expect_error: true`.** Both steps submit a `create_media_buy` with an intentionally-unregistered id and assert the rejection's error.field; the SDK runner needs the marker to invert pass/fail. Added `expect_error: true` + `negative_path: payload_well_formed`, matching `invalid_transitions`.
  - **`proposal_finalize_asap_timing` rejected with `IO_REQUIRED`.** The scenario narrative claimed `io_acceptance` was "intentionally omitted because requires_signature is false on this proposal" — but the training agent's seeded proposal carries `requires_signature: true`. The scenario's discriminating assertion is `start_time: "asap"`, not the IO gate; including `io_acceptance` keeps the IO gate satisfied so the start-timing form is what's tested. Added `context_outputs` for `io_id` extraction and included `io_acceptance` on the create step.

  After fixes, `/sales` lifts from 69→73 clean (350 passing). Other tenants also lifted from the SDK roll-up and earlier work; floors bumped with 1-clean buffer for flake tolerance:

  | Tenant           | Old floor | New floor | Observed |
  | ---------------- | --------- | --------- | -------- |
  | signals          | 70:111    | 74:111    | 75       |
  | sales            | 69:315    | 72:340    | 73       |
  | governance       | 69:151    | 73:151    | 74       |
  | creative         | 69:169    | 73:169    | 74       |
  | creative-builder | 66:146    | 70:146    | 71       |
  | brand            | 69:96     | 73:96     | 74       |

  Known failing storyboards that did not lift cleanly and are left for follow-up:

  - `media_buy_seller/dependency_impairment` + `dependency_impairment_cardinality` (#4685/#4677): need full impairment-tracking in the TA — creative-status transitions don't currently propagate to `media_buy.impairments[]`, and `update_media_buy` swap-assignment doesn't clear stale entries. Feature work, not a fix.
  - `signed_requests-strict-required` / `signed_requests-strict-forbidden`: vectors signed without (or with) content-digest can't pass a verifier mode that requires (or forbids) it. The SDK grader's `covers_content_digest: 'either'` permissiveness rule doesn't account for the structural incompatibility. Needs SDK-side fix or expanded `skipVectors` list.

  Files:

  - `server/src/training-agent/v6-sales-platform.ts` — `syncEventSources` + `logEvent` wired into `TrainingSalesPlatform.sales`.
  - `static/compliance/source/protocols/media-buy/scenarios/audience_buy_flow.yaml` — `expect_error: true` on phantom-audience step.
  - `static/compliance/source/protocols/media-buy/scenarios/performance_buy_flow.yaml` — `expect_error: true` on phantom-source step.
  - `static/compliance/source/protocols/media-buy/scenarios/proposal_finalize_asap_timing.yaml` — `io_acceptance` on the asap create step + `io_id` context output on finalize.
  - `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh` — floors lifted.

- 32d14c9: Fix two universal storyboard false failures: remove runner-only webhook URL templating from the core idempotency replay requests while preserving webhook replay side-effect coverage in the webhook-emission universal, and spell out the schema-validation past-start contribution flag for runners that do not normalize `contributes: true` shorthand before grading.
- 9989dc2: Clear storyboard lint drift by registering tracker asset types in the creative asset union, supporting `task_completion.*` context-output paths in the static lint, and classifying `sync_audiences` as tenant-scoped.
- ebd12c6: Fix release-blocking storyboard drift: creative lifecycle now verifies that `list_creatives` returns the creative synced earlier, stateful creative account requests declare sandbox mode, and catalog-dependent media-buy/governance storyboards use discovered or fixture-backed product and pricing IDs instead of stale hardcoded identifiers.
- 8edd3f9: fix(compliance): UUID-aliased idempotency_keys across remaining storyboard scenarios

  Extends the [#4218](https://github.com/adcontextprotocol/adcp/pull/4218) precedent (`measurement_terms_rejected`) to the rest of the suite. 15 storyboard steps across 9 scenarios still shipped hardcoded `idempotency_key` literals on state-mutating tasks (`create_media_buy`, `sync_creatives`, `sync_plans`, `update_media_buy`). The runner shifts dynamic `start_time` substitutions forward to keep buys future-dated, so against a long-running seller deployment those static keys collide cross-run with the same key + a different canonical body, arming the spec-mandated `IDEMPOTENCY_CONFLICT` (or, when the seller's emit shape changed between runs, replaying a now-spec-non-compliant cached payload — the production failure mode that surfaced this).

  Switch every remaining literal to `$generate:uuid_v4#<scenario>_<step>` so each storyboard run mints fresh keys and never collides with stale cached state. Affected scenarios: `creative_fate_after_cancellation` (5), `governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery` (3), `invalid_transitions`, `inventory_list_no_match`, `inventory_list_targeting`, `pending_creatives_to_start`.

  Closes #4230.

- 725b241: Clarify that task webhooks are not emitted for synchronous completions and add
  webhook-emission storyboard coverage for the sync-only invariant. Sellers MUST
  NOT replay an inline terminal result to `push_notification_config.url` or invent
  a `task_id`; buyer SDKs may still normalize synchronous responses into local
  callbacks or handlers because those local conveniences are not AdCP webhooks.
  The canonical probe sends an advertised wholesale `get_products` request with
  `push_notification_config` and accepts either a terminal synchronous response
  without `task_id` or a structured well-formed runtime rejection. A Submitted
  async handoff is non-conformant. Any future sync-completion notification mode
  would need an explicit, capability-advertised opt-in.
- dce2a70: Wire `sync_governance` onto the reference agent's `/sales` (`media_buy_seller`) tenant. Every media_buy_seller specialism (sales-guaranteed, sales-non-guaranteed, sales-broadcast-tv, sales-catalog-driven, sales-social, governance-aware-seller) lists `sync_governance` in `required_tools` and calls it against `/sales`, but the tool was only registered on `/signals` — so the "Register governance agents" step failed with `MCP error -32602: Tool sync_governance not found`. The handler is tenant-agnostic; this registers it via `customTools` on `/sales` (mirroring `/signals`) and updates the tool catalog so the drift test reflects both tenants.
- b716da5: feat(training-agent): metric-mode forcing function for clicks / reach / completed_views storyboard scenarios

  The training agent now declares seller-level `media_buy.supported_optimization_metrics` (the honest union across catalog products), validates `reach_unit` against the product's `metric_optimization.supported_reach_units` and `view_duration_seconds` against `metric_optimization.supported_view_durations` on `create_media_buy` (INVALID_REQUEST with literal JSONPath-lite `error.field`), and emits `cost_per_click` plus goal-gated `reach + frequency` / `completed_views + completion_rate` on `get_media_buy_delivery`. Flips three capability-gated storyboards (`clicks_buy_flow`, `reach_buy_flow`, `completed_views_buy_flow`) from `not_applicable` to applicable on the training agent. Same forcing-function shape as #4654 (event_source_id) and #4664 (audience_buy_flow / event_dedup_flow). Manual rollup declaration — adcp-client#1818's auto-derive remains blocked on the SDK exposing the seller-level field.

- 917c8f9: Update Node.js development type definitions to @types/node 24.
- 90e90d3: Update undici to 8.3.0 and keep SSRF-safe dispatchers on the same undici fetch implementation in `safeFetch` and webhook delivery.
- 8b7e646: fix(training-agent): thread `dry_run` and `assignments[]` through v6 platform shims via `ctx.input`.

  The v6 SDK's typed `SalesPlatform.syncCreatives`, `AudiencePlatform.syncAudiences`, and `AccountStore.upsert` signatures destructure the request envelope and pass only the typed first-arg (`creatives[]` / `audiences[]` / `refs[]`) to the platform method — fields like `dry_run` and inline `assignments[]` were dropped on the v6 path while the legacy `/mcp` route preserved them (adcp-client#1842). 7.8 fixed this by exposing the original envelope as `ctx.input: Readonly<Record<string, unknown>>`; this change lifts the dropped fields back out for our v5-shimming v6 platforms.

  Adopted in:

  - `v6-sales-platform.ts` and `v6-creative-platform.ts` and `v6-creative-builder-platform.ts` — `syncCreatives` now threads `dry_run` (suppresses session persistence) and `assignments[]` (writes inline package bindings) through to `handleSyncCreatives`. The v6 response signature returns only `SyncCreativesRow[]`, so assignment results are observable via subsequent `get_media_buys` rather than in the sync response itself.
  - `v6-account-helpers.ts` — `syncAccountsUpsert` threads `dry_run` to `handleSyncAccounts`. `delete_missing` is on the SDK's drop list but the v5 handler doesn't implement it yet, so threading it would be inert — wire when v5 grows support.

  Helper `pickFromInput` in `v6-input-helpers.ts` does the named-field lift; per SDK guidance, `ctx.input` is buyer-controlled and untrusted, so the helper reads only named fields and never logs wholesale.

- e0e03fc: Accept unsubstituted ad-server macros in VAST/DAAST tag URLs.

  `vast-asset.json` and `daast-asset.json` validated the `delivery_type: "url"` branch's `url` field with `format: "uri"` (strict RFC 3986). Real-world tags carry unsubstituted macros — VAST-style `[OMIDPARTNER]` / `[BUNDLEID]` placeholders and `${GDPR_CONSENT}`-style privacy macros — whose square brackets and curly braces are illegal unencoded in an RFC 3986 URI. Any verification-wrapped CTV tag (IAS, DV, MOAT wrappers) therefore failed `create_media_buy` validation even though the tag is valid per the IAB VAST spec, where players substitute macros before treating the string as a URL. Pre-encoding the delimiters is not a workaround: players and verification vendors match the literal macro token, so an encoded `%5BOMIDPARTNER%5D` never gets substituted.

  Both fields now use `format: "uri-template"` (RFC 6570), the same convention `url-asset.json` already uses for AdCP universal macros. RFC 6570 permits `[` / `]` as literal characters and parses `${MACRO}` as a literal `$` followed by a `{MACRO}` expression, so macro-laden tags validate while malformed strings (raw spaces, control characters, unbalanced braces) are still rejected. Schema descriptions now state that buyers MUST NOT pre-encode macro delimiters.

  Known limitation: GAM-style `%%MACRO%%` placeholders still fail (a bare `%` must be percent-encoded under RFC 6570). VAST 4.x official macros use `[MACRO]` and privacy conventions use `${...}`, so the common cases are covered; widening further would mean dropping `format` validation entirely.

  Adds a regression test validating a real verification-wrapped CTV tag against both asset schemas, with a negative case confirming malformed URLs are still rejected.

- a2b814d: Add storyboard coverage for task webhook `operation_id` echo semantics. The webhook-emission universal now sends an explicit `push_notification_config.operation_id` that differs from the runner's URL capture token, validates inbound task webhook payloads against `core/mcp-webhook-payload.json`, and asserts sellers echo the explicit operation id rather than deriving correlation from the opaque receiver URL.

  Clarifies the webhook receiver runner contract and webhook documentation so URL path routing remains a buyer/runner implementation detail while the payload `operation_id` is the wire-level correlation field.

- a9936ec: docs(media-buy): clarify context echo on webhook payload schemas.

  Refs #5131. This adds schema descriptions and example/docs clarification for existing context echo behavior without changing field shapes.

- e860906: Re-apply `docs/reference/whats-new-in-3-1.mdx` cleanly from current main after the original landing (PR #4784) was reverted to restore accidentally-deleted `dist/docs/` versioned snapshots. Content is identical to the original page — comprehensive 3.0 → 3.1 narrative covering 15 headline features synthesized from a full audit of every spec PR merged since 3.0.6.

  Adds two nav entries in `docs.json` under the existing **AdCP 3.0** groups.

  Closes the gap reopened by the revert.

## 3.1.0-rc.15

### Minor Changes

- 85411b1: Add optional `status_as_of` freshness timestamp to `get_media_buys` media-buy objects.

  The field lets sellers identify when a returned media-buy-level `status` was last refreshed from the source of truth, covering cached or rolled-up list reads from curator/storefront aggregators. Sellers omit it or return `null` when status is live or freshness is unknown.

- 2938456: feat(registry): add catalog collections and YouTube channel aliases

  Adds first-class registry catalog collections, collection change-feed events, YouTube channel distribution identifier types, collection sync/distribution lookup APIs, and an admin community collection upsert path. This supports publisher-owned collections distributed through third-party platforms such as YouTube while keeping publisher authorization anchored on the publisher's own domain.

- 7a48ee4: Webhooks are signed with the agent's `request-signing` key — there is no separate webhook key purpose. The webhook verifier checklist (step 8) now accepts `adcp_use == "request-signing"` as canonical, with the deprecated `"webhook-signing"` still accepted for backward compatibility (removal tracked in adcontextprotocol/adcp#5555). Operators that want separate key material for webhooks publish a second `"request-signing"` key with a distinct `kid` and sign webhooks with it — key isolation comes from the `kid`, not a distinct `adcp_use`. Any other key-purpose failure — `"response-signing"`/`"governance-signing"`, absent `adcp_use`, or a missing `verify` key_op — is rejected with `webhook_signature_key_purpose_invalid`. `webhook_mode_mismatch` is unchanged and remains reserved for the HMAC-vs-9421 auth-mode selector mismatch.

  The relaxation is one-directional and safe: cross-protocol confusion is prevented by the RFC 9421 `tag` (`adcp/webhook-signing/v1`, part of the signed base, checked at step 3) and mandatory `content-digest` coverage — not by the key-purpose discriminator. A captured request signature carries `tag=adcp/request-signing/v1` and is rejected at step 3, so it can never be replayed as a webhook. The reverse remains forbidden: a webhook-signing key MUST NOT verify a request signature (request verification still requires `adcp_use == "request-signing"` exactly).

  Conformance vectors updated: former negative `webhook-signing/negative/008-wrong-adcp-use` (request-signing key rejected) becomes positive `webhook-signing/positive/008-request-signing-key-reuse` (accepted); a new negative `008-wrong-adcp-use` covers a `response-signing` key, still rejected.

  Semver note: this is `minor` because it widens verifier acceptance and deprecates the old key purpose without removing any wire-compatible signer or verifier behavior. The future removal of `"webhook-signing"` from the accepted webhook key-purpose set is tracked in adcontextprotocol/adcp#5555 and will be a major-version change.

### Patch Changes

- eb65373: Fix compliance reporting for optional-tool skips: storyboard-level `required_tools`
  and step-level `requires_tool` skips now remain untested/not applicable in Addie
  instead of surfacing as failures. Preview creative checks now declare their
  `preview_creative` gate explicitly, and idempotency replay key stability is pinned
  with a source-storyboard regression test.
- c27e27f: Bump `@adcp/sdk` to `9.0.0-beta.29` so hosted and local storyboard runs pick
  up phase-level `requires_capability` enforcement. Protocol-specific phases in
  universal storyboards now skip as `not_applicable` before dispatch when the
  agent does not advertise the gated capability.

  The training agent now also advertises and accepts the SDK runner's `3.1-rc.14`
  wire pin so local storyboard matrices do not reject current prerelease probes
  with `VERSION_UNSUPPORTED`.

## 3.0.18

### Patch Changes

- 64ce06c: Prevent optional creative preview skips from cascading into false storyboard failures.

## 3.0.17

### Patch Changes

- e1255d6: Use generated storyboard context values for idempotency replay keys so the
  initial, replay, and conflict requests share one UUID while the fresh-key path
  uses a distinct generated UUID.
- 7954f34: Fix compliance reporting for optional-tool skips: storyboard-level `required_tools`
  and step-level `requires_tool` skips now remain untested/not applicable in Addie
  instead of surfacing as failures. Preview creative checks now declare their
  `preview_creative` gate explicitly.
- c6131e7: Fix two universal storyboard false failures: remove runner-only webhook URL templating from the core idempotency replay requests while preserving webhook replay side-effect coverage in the webhook-emission universal, and spell out the schema-validation past-start contribution flag for runners that do not normalize `contributes: true` shorthand before grading.

## 3.0.16

### Patch Changes

- Backport compliance storyboard fixes for idempotency webhook placeholders, past-start reject-or-adjust handling, initialized security probes, RFC 9421 webhook receiver URLs, and media-buy state transitions.
- c57bcd8: Backport the proposal-finalize storyboard gate to 3.0.x so sellers that do not declare `media_buy.supports_proposals: true` skip the proposal lifecycle scenario instead of receiving false-negative compliance failures, and refresh the idempotency storyboard flight dates so the 3.0.x runner preserves byte-identical replay payloads.
- 895f74a: spec(tmp): add required `seller_agent_url` to `context_match_request`.

  The context-match request now carries `seller_agent_url`, matching the identity-match request's field shape and placement (PR #3687). The resolution semantics are deliberately actor-specific, not a mirror: on the context path the **provider** resolves the active package set it has **synced** for the asking seller, whereas on the identity path the **buyer agent** resolves the set it has **registered**. When `package_ids` is omitted, evaluation runs against that seller's full active set; a `seller_agent_url` the provider has not synced packages for MUST return an empty offer set rather than fall back to another seller's set.

  This reverses the prior decision (PR #3063's seller-attribution section) that kept seller identity off `context_match_request`. That section argued the provider already holds the sync-time `seller_agent` binding so the request field is redundant, and that putting seller on the context path opens a request-time filtering vector. In practice a provider serves many sellers and needs the asking seller's identity on the wire to scope its active-set resolution without a deployment-pinned constant — the same need the buyer agent has on the identity path, even though the actor and the set it resolves against differ. The decorrelation argument does not apply: `seller_agent_url` is a single stable value identifying the asking seller, identical for every user on a placement and carrying no user identity, so it adds no per-user signal that context and identity requests could be correlated on. The package-set decorrelation guarantee constrains per-user-varying data (`package_ids`), which is unchanged.

  Required, consistent with identity-match. `context_match_request` is `x-status: experimental`, so the added required field is permitted pre-stable.

  Files:

  - `static/schemas/source/tmp/context-match-request.json` — `seller_agent_url` property (string, uri) added to `properties` and to `required`.
  - `docs/trusted-match/specification.mdx` — §Seller Attribution "Placement rationale", the Router participant row, and the "What This Is Not" bullet rewritten so the normative text matches: both request types carry `seller_agent_url`; the package-side `seller_agent` remains attribution-only; neither may be used as a per-user filter.
  - `docs/trusted-match/{index,buyer-guide,context-and-identity,ai-mediation}.mdx` and `docs/trusted-match/surfaces/{web,mobile,ctv,ai-assistants,retail-media}.mdx` — request examples updated with `seller_agent_url`.
  - `tests/example-validation-simple.test.cjs` — both context-match request fixtures updated.

## 3.0.15

### Patch Changes

- f78f37c: Patch the 3.0.x compliance fixtures for the reported AgenticAdvertising.org
  compliance suite failures: `media_buy_state_machine` and
  `measurement_terms_rejected` now use forward-looking Q3 2026 windows, the
  universal idempotency missing-key vector no longer depends on a same-day May
  flight, the state-machine fixture keeps the existing 3.0.x `status` response
  assertions, and the compliance build rejects stable or duplicate generated
  idempotency keys on mutating storyboard steps.
- 6e4dfdd: Match the 3.1 line's upcoming-event day calculation in member context prompts
  so events exactly five days out do not intermittently render as four days.

## 3.0.14

### Patch Changes

- e23dc24: Accept HTTP Basic authentication in the universal `security_baseline` compliance storyboard. Basic credentials now have a dedicated valid/invalid probe path and can satisfy `auth_mechanism_verified` alongside Bearer API keys and OAuth discovery.

## 3.0.13

### Patch Changes

- d35ccf0: Backport MCP transport clarification to `v3_envelope_integrity` storyboard (3.0.x).

  Adds the MCP-specific note (already present on main) explaining that `status` must
  appear at the top level of `structuredContent` and is distinct from the
  task-body schema (`get-adcp-capabilities-response.json`). Addresses the
  confusion reported in #4832: `response_schema` passes because the task schema
  intentionally omits protocol envelope fields; `envelope_field_present` for
  `status` is the separate, correct enforcement layer. Also updates the `expected`
  block header from "Response envelope:" to "Response envelope (all transports):"
  to match main-branch wording.

  The `field_absent` TODO comments for `task_status`/`response_status` are unchanged —
  those await `field_absent` runner support in adcp-client (tracked separately).
  The SDK gap (SDK 7.7.0 not emitting `status` on `get_adcp_capabilities`) is a
  sibling-repo concern also tracked separately.

- b2f9ce3: Docs: add the now-required `account.supported_billing` block to the four
  `get_adcp_capabilities` example JSON blocks that declare `media_buy`
  support.

  Since #3750 (`fix(schema): make account.supported_billing conditional on
media_buy protocol`), the response schema requires `account.supported_billing`
  whenever `supported_protocols` contains `media_buy`. Four illustrative
  examples in the docs (`creative/sales-agent-creative-capabilities.mdx`,
  `media-buy/specification.mdx`, `reference/migration/channels.mdx`,
  `reference/migration/geo-targeting.mdx`) were not updated alongside the
  schema and have been failing CI's schema validation step on `3.0.x` HEAD,
  blocking every other patch PR against the branch.

  Each example now includes `"account": { "supported_billing": ["operator",
"agent"] }`, matching the pattern already used in
  `docs/building/integration/accounts-and-agents.mdx`. Documentation only —
  no protocol behavior change.

- b605ef8: IdentityMatch & frequency capping architecture, with the wire-spec change and the data-flow boundary contract landing as authoritative protocol docs. Counting and policy live in the buyer's impression tracker; the IdentityMatch service consumes only cap-fire events at the boundary.

  **Wire spec changes** (`identity-match-response.json`):

  - Adds `serve_window_sec` (integer, 1–300, default 60) — per-package single-shot fcap window. After serving the user one impression on each eligible package within this window, the publisher MUST re-query Identity Match before serving from those packages again. Not a router response cache TTL.
  - Removes `ttl_sec`. Originally documented as a router cache TTL but operationally functioned as a per-package serve throttle. TMP is pre-launch (experimental, pre-3.0.0 GA) and not subject to deprecation cycles, so the field is removed outright.

  **Doc updates:**

  - `docs/trusted-match/specification.mdx` — adds `serve_window_sec` field, removes `ttl_sec`, adds normative conformance invariants for IdentityMatch eligibility (audience intersection; cap-state presence check; active state; audience freshness). Updates the caching section for the new contract.
  - `docs/trusted-match/identity-match-implementation.mdx` (new page) — frequency-cap data flow (boundary contract): the cap-fire event the impression tracker writes into the IdentityMatch cap-state store, and how the IdentityMatch service consumes it at query time. The protocol does not constrain how the impression tracker counts impressions, evaluates windows, or decides when a cap fires — those concerns live entirely in the buyer's impression-tracking pipeline.
  - `docs/trusted-match/buyer-guide.mdx` — updates frequency-cap management to reflect the impression-tracker / IdentityMatch split, and the serve-window contract section.
  - `docs/trusted-match/migration-from-axe.mdx` — adds OpenRTB 2.6 `User.eids[]` cross-walk for buyers bridging from OpenRTB-shaped pipelines.

  **Three-layer model:**

  - Wire spec (normative) — what crosses an agent boundary.
  - Conformance invariants (normative) — backend-agnostic eligibility logic, including a presence check against cap-state.
  - Boundary contract (normative for the cap-state store API) — what events flow from the impression tracker into the IdentityMatch cap-state store. Storage backend is implementer choice; the reference store ships in `adcp-go/targeting/fcap` (Valkey 9 hashes with HSETEX).

  **Cap-state store surface:** `RecordCap(userIdentity, fields, expireAt)` and `IsCapped(userIdentity, field)`, where `field` is `{seller_agent_url, package_id}`. v1 keys cap-state at `(user_identity, seller_agent_url, package_id)`; broader-dimension caps (advertiser, campaign, creative, line item) are a future extension to the boundary contract.

  **Architecture history** preserved at `specs/identitymatch-fcap-architecture.md` — captures design decisions, deferred security/privacy follow-ups, the rollout plan, and consolidated Slack/PR-review threads. Earlier iterations of the design (counter-based exposure tracking, log-based tracking with `impression_id` dedup, `fcap_keys` label model) were unwound — counting, dedup, and policy evaluation depend on buyer-internal concerns the protocol shouldn't constrain.

  All TMP surfaces remain `x-status: experimental`. Per the experimental-status contract, fields on this surface are not subject to deprecation cycles until 3.0.0 GA.

  **Tracked deferred follow-ups** (not in this PR):

  - TMPX harvest → competitor-suppression attack
  - Eligibility-as-audience-membership oracle (honeypot package_ids)
  - Consent revocation between IdentityMatch and impression
  - Side-channel via eligibility deltas
  - `hashed_email` in TMPX leak surface
  - DoS amplification via large `package_ids[]`
  - Cap-state extensions for advertiser/campaign/creative dimensions
  - Identity-graph plug-point in the impression tracker

## 3.0.12

### Patch Changes

- d8d5cfa: Add `comply_controller_mode_gate` universal storyboard and `acme-outdoor-live` test kit.

  New storyboard exercises the live-account denial path for `comply_test_controller`:
  a seller that exposes the controller must return `FORBIDDEN` when called by a
  live-mode (non-sandbox) principal. Optional phase for two-deployment sellers;
  required for single-endpoint sellers that implement per-account gating.
  Closes #4028.

- 6ed6bed: Fix `account.supported_billing` schema: require it only when `media_buy` is in `supported_protocols`, not unconditionally for all agents. Adds root-level `allOf` if/then guard following the existing `sync-plans-request.json` pattern. Non-media-buy agent authors should note that `supported_billing` was previously enforced on any `account` block — SDKs using code generators that drop draft-07 `if/then` (openapi-typescript, zod-to-json-schema, quicktype) should add a runtime guard to require `supported_billing` when `account` is present and `media_buy` is declared.
- 4e9738c: spec(compliance): document `force_scenario_unsupported` — UNKNOWN*SCENARIO on force*\* controller steps grades not_applicable

  Sellers that implement `comply_test_controller` but have not implemented a specific `force_*` scenario arm (e.g., `force_create_media_buy_arm`) correctly return `{success: false, error: UNKNOWN_SCENARIO}`. The storyboard narrative in `create_media_buy_async.yaml` already said this grades `not_applicable` — that narrative was normative English. The runner contract, however, had no machine-readable enforcement layer for force\_\* scenarios (only `fixture_seed_unsupported` for auto-injected seed phases), so conforming runners were implementing FAILED instead of not_applicable.

  Patch-eligibility justification (IETF errata test, playbook lines 261-265): the storyboard's own normative narrative text already required not_applicable; any runner grading FAILED was non-conforming against that existing MUST. This change adds the machine-readable form of a rule that was already in force. A conformant 3.0.0 implementation of the surrounding behavior would already have honored the narrative — the schema text closing the gap is an errata clarification, not a new requirement.

  Changes:

  - `storyboard-schema.yaml`: adds `force_scenario_unsupported` alongside `fixture_seed_unsupported`, with a normative MUST: detect the tuple (comply*test_controller IS present, resolved payload scenario begins with `force*`, response {success: false, error: UNKNOWN_SCENARIO}) and grade not_applicable before evaluating declared validations. Documents detection order to prevent misgrading absent-tool cases.
  - `runner-output-contract.yaml`: adds `fixture_seed_unsupported`, `force_scenario_unsupported`, and `unresolved_scenario_reference` as recognized narrower detail values under canonical reason `not_applicable`, with the encoding MUST for `force_scenario_unsupported`.

  No storyboard YAML changes — `create_media_buy_async.yaml`'s narrative was already correct; this closes the machine-readable gap the runner was missing. Runner implementation fix tracked in adcp-client (sibling-repo).

  Closes #4226.

- cf13380: TMP Identity Match: add required `seller_agent_url` to the request and make
  `package_ids` optional.

  **Why.** The buyer's identity-match service already keeps the authoritative
  set of active packages it has registered per seller. Carrying that set on
  every request was redundant and forced publishers to enumerate ALL active
  packages on every call to avoid the set-correlation attack on Context
  Match. Identifying the seller by URL lets the buyer resolve the package
  set itself.

  **Changes to `static/schemas/source/tmp/identity-match-request.json`.**

  - New required field `seller_agent_url` (`string`, `format: uri`). The
    seller agent's API endpoint URL. Compared using the AdCP URL
    canonicalization rules, consistent with `seller_agent.agent_url` on
    `AvailablePackage` and `agent_url` in `adagents.json`.
  - `package_ids` is now optional. When omitted, the buyer evaluates against
    the full active set registered for `seller_agent_url`. When provided,
    the ALL-active-packages rule still applies — partial sets remain a
    correlation risk.
  - Top-level description updated to reflect both modes.

  **Spec changes alongside the schema.**

  - Reversed prior stance forbidding seller identity on `identity_match_request`. The "What This Is Not" / SellerAgentRef guidance has been narrowed to apply only to `context_match_request`.
  - Added a fail-closed rule: when `seller_agent_url` matches no seller for which the buyer has registered active packages, the buyer MUST return an empty `eligible_package_ids`, not fall back to another seller's set.
  - Defined precedence when both `seller_agent_url` and `package_ids` are present: buyer evaluates against the intersection of its registered active set and `package_ids`; unknown IDs are silently dropped (not error-surfaced) so the response cannot leak registry membership.
  - Reframed the package-set-decorrelation invariant as **statistical independence of `package_ids` from the current placement**, with two acceptable modes: all-active and fuzzed (random sample padded with synthetic non-existent IDs that the buyer silently drops). The page-specific subset remains forbidden.
  - Strengthened temporal decorrelation: random delay alone leaks the pairing through ordering. Publishers SHOULD also randomize whether Context Match or Identity Match is sent first — each opportunity SHOULD have a roughly equal probability either way.

  **Privacy boundary.** `seller_agent_url` identifies the seller agent, not
  the user; no leakage across the identity boundary. Routers do NOT strip
  it (unlike `country`) — buyers need it to resolve the package set.

  **Backwards compatibility.** Breaking for the experimental TMP schema
  (`x-status: experimental`): callers MUST now send `seller_agent_url`. The
  relaxation of `package_ids` is non-breaking on its own — previously valid
  requests remain valid as long as they also include `seller_agent_url`.

## 3.0.11

### Patch Changes

- e03978d: Collapse the `key_reuse_conflict` phase of `universal/idempotency.yaml` into
  `replay_same_payload` as a fourth step. The conflict step deliberately shares
  the `$generate:uuid_v4#replay_key` alias with the replay steps so the seller
  receives one cached entry that the conflict request probes with a different
  body. With adcp-client#1658's phase-boundary alias reset, the conflict step
  must live in the same phase as the replay steps — a separate phase mints a
  fresh UUID and the seller treats the request as new, defeating the
  IDEMPOTENCY_CONFLICT assertion. Companion to adcp-client#1657 / #1658; no
  behavior change for sellers, only restructures the storyboard so the runner
  fix is safe to land.

## 3.0.10

### Patch Changes

- fa86695: Convert the 12 remaining static `idempotency_key` literals across error, governance,
  signal, schema-validation, and creative-ad-server storyboard scenarios to
  `$generate:uuid_v4#<alias>` form. Closes the static-key sweep for the 3.0.x line so
  storyboard re-runs against any spec-compliant seller no longer collide with the
  seller's idempotency cache after deploys. 3.0.x port of #4231; closes #4344 on the
  patch line.

## 3.0.9

### Patch Changes

- 753dbe3: Propagate account discovery MUST from `required-tasks.mdx` into `accounts/overview.mdx`. Every seller agent must expose at least one of `list_accounts` or `sync_accounts` — this restates the existing `required-tasks.mdx` MUST in the surface-level overview where implementors look first. No wire shape change.
- 5d2e7be: Fix stale HMAC-as-recommended framing in reporting-webhook.json, auth-scheme.json, and create-media-buy-request.json's artifact_webhook; add RFC 9421 default guidance to call-adcp-agent SKILL.md. Description-only fixes aligning these surfaces with the existing push-notification-config.json framing (HMAC is the deprecated fallback, RFC 9421 is the default). No wire format changes.

## 3.0.8

### Patch Changes

- 8f82d46: fix(compliance): UUID-aliased idempotency_keys across remaining storyboard scenarios

  Extends the [#4218](https://github.com/adcontextprotocol/adcp/pull/4218) precedent (`measurement_terms_rejected`) to the rest of the suite. 15 storyboard steps across 9 scenarios still shipped hardcoded `idempotency_key` literals on state-mutating tasks (`create_media_buy`, `sync_creatives`, `sync_plans`, `update_media_buy`). The runner shifts dynamic `start_time` substitutions forward to keep buys future-dated, so against a long-running seller deployment those static keys collide cross-run with the same key + a different canonical body, arming the spec-mandated `IDEMPOTENCY_CONFLICT` (or, when the seller's emit shape changed between runs, replaying a now-spec-non-compliant cached payload — the production failure mode that surfaced this).

  Switch every remaining literal to `$generate:uuid_v4#<scenario>_<step>` so each storyboard run mints fresh keys and never collides with stale cached state. Affected scenarios: `creative_fate_after_cancellation` (5), `governance_approved`, `governance_conditions`, `governance_denied`, `governance_denied_recovery` (3), `invalid_transitions`, `inventory_list_no_match`, `inventory_list_targeting`, `pending_creatives_to_start`.

  Closes #4230.

## 3.0.7

### Patch Changes

- 866abe2: docs(creative): tighten type column in the `list_creatives` filtering options table to match `core/creative-filters.json`. `accounts` now shows `AccountRef[]` (was `array`), `format_ids` shows `FormatID[]` (was `format_id[]`, matching the casing used in `list_creative_formats`, `get_products`, and `create_media_buy`), and `statuses` links to `CreativeStatus` rather than the under-specified `string[]`. Docs only — no schema or wire-format change. Patch-eligible per the non-normative-docs rule in `.agents/playbook.md`.
- b2f7a3d: fix(compliance): `measurement_terms_rejected` — UUID-aliased idempotency_keys + spec-aligned narrative

  The `media_buy_seller/measurement_terms_rejected` storyboard shipped hardcoded `idempotency_key` literals on both `create_media_buy` steps. Combined with runner-side dynamic `start_time` substitution (the runner shifts stale dates forward to keep the buy future-dated), this produced **same key + different body** on every run against a long-running seller deployment, arming the spec-mandated `IDEMPOTENCY_CONFLICT` on the seller side. Switch to `$generate:uuid_v4#…` aliases so each run mints fresh keys (matches the established pattern across the storyboard suite).

  Also rewrites the narrative, which previously told implementers the buyer "retries the same `create_media_buy` `idempotency_key` with an adjusted payload" — a direct spec violation — to describe minting a fresh key for the retry.

  Closes #4219. Refs adcontextprotocol/adcp-client#1586.

## 3.0.6

### Patch Changes

- 91b6e2c: spec(errors): wire-placement guidance for `GOVERNANCE_DENIED` and `GOVERNANCE_UNAVAILABLE`

  `error-code.json` defined the codes' semantics but didn't say WHERE in the response they appear. Different storyboards interpreted differently — issue #3914 surfaced one mismatch where the brand-rights compliance storyboard expected `expect_error: code: GOVERNANCE_DENIED` even though `acquire_rights` already has a first-class `AcquireRightsRejected` discriminated arm with `reason`. Adopters returning the spec-correct Rejected shape were failing the storyboard.

  The `enumDescriptions` for both codes now state placement explicitly:

  - **`GOVERNANCE_DENIED`** — structured business outcome, not a system error. When the task response defines a structured rejection arm (e.g., `AcquireRightsRejected`), that arm is the canonical denial shape — populate `status: "rejected"` + `reason`, do NOT additionally emit the code in `errors[]` or `adcp_error`, and do NOT flip transport-level failure markers. When the task has no rejection arm (e.g., `create_media_buy` returns the `Error` arm), populate `errors[].code` AND `adcp_error.code` per the two-layer model and DO flip transport markers.
  - **`GOVERNANCE_UNAVAILABLE`** — system error, governance call failed at all. Always populate both layers with the code and flip transport markers. Sellers MUST NOT use a structured rejection arm for unavailability even when the task offers one — the buyer's recovery semantics differ (retry-with-backoff vs. restructure-or-escalate).

  The contrast resolves the question the storyboard mismatch surfaced: thrown adcp_error is reserved for governance-call failure modes (parallel to `GOVERNANCE_UNAVAILABLE`), not for adopter-controlled denials.

  The MUST NOT against dual-emission isn't a behavior change — `AcquireRightsRejected` and `CreativeRejected` already declare `not: { required: [errors] }` at the schema layer, so emitting `errors[]` alongside a rejection arm was already a schema violation. The doc-comment makes the rule discoverable from the error code without changing what conformant senders produce.

  Also adds a parallel storyboard-authoring note in `error-handling.mdx`: when the task response has a discriminated rejection arm, assertions should use `check: field_value, path: "status", value: "rejected"` rather than `check: error_code`. The existing `error_code` guidance is correct for tasks without a rejection arm; the new note covers the rejection-arm path that surfaced via #3914.

  Closes the doc-comment item on #3918; companion to #3914 (storyboard fix is separate work).

- 91b6e2c: spec(conventions): reserve `ctx_metadata` as adapter-internal round-trip key

  Reserves the top-level key `ctx_metadata` on AdCP resource objects (Product, MediaBuy, Package, Creative, AudienceSegment, Signal, RightsGrant) as a publisher-to-SDK round-trip cache for adapter-internal state. SDKs MUST strip the key before wire egress and MUST emit a warning-level log entry when stripping, so operators can detect accidental collisions with existing adapter code. Buyers never see this field.

  The convention is non-binding at the wire level — these resources already declare `additionalProperties: true` so existing payloads remain valid. The reservation locks the keyword name before two SDKs converge on it accidentally and ship divergent semantics. PropertyList and CollectionList are out of scope (`additionalProperties: false`) until a follow-up PR widens those schemas.

  Closes #3640.

- e4af188: docs(skill): document the four implementation-dependent `issues[]` fields callers may see

  `skills/call-adcp-agent/SKILL.md` already documents the three required `issues[]` fields (`pointer`, `keyword`, `variants`) that every conformant validator surfaces. Adds the four optional fields a calling agent will encounter when the seller's validator opts into them — `discriminator`, `schemaId`, `allowedValues`, `hint` — with a one-line preface clarifying these are implementation-dependent (not every validator emits them) and an updated recovery order: read `hint` first when present, then `discriminator`, then walk `variants`.

  Two new rows added to the symptom-fix lookup table for the same fields.

  No wire-format change. Pure documentation: shipping these fields is already a valid validator extension; this just gives callers a curated path through them.

  Surfaced from the @adcp/sdk side after PR #1283 / #1309 added the fields and PR #1268 / #1361 hit recurring drift between the local SDK skill copy (which already documented them) and the upstream bundle (which didn't). With this merged, the SDK's `npm run sync-schemas` no longer rewrites the file out from under contributors.

## 3.0.5

### Patch Changes

- a4bd513: spec(capabilities): relax `identity.additionalProperties` to `true` on `get-adcp-capabilities-response`

  Forward-compat fix for 3.0.x. The `identity` object was schema-closed (`additionalProperties: false`), so any operator that adopted a forward-compatible field — notably `identity.brand_json_url` from #3690, which was always intended to be readable by 3.0-pinned implementers without a schema bump — would have its capabilities response rejected by strict 3.0 validators (e.g., `@adcp/sdk`'s `createAdcpServer` default).

  Mirrors the `additionalProperties: true` already shipped on `main` post-#3690. Strictly additive: the closed property list (`per_principal_key_isolation`, `key_origins`, `compromise_notification`) is unchanged; receivers that ignore unknown fields keep working; receivers that look for new identity fields gain forward-compat without waiting for a 3.x bump.

  The forward-compat narrative in `security.mdx` ("3.0-pinned implementers can adopt the field today without bumping") depends on this relaxation being live in shipped schemas — without it, the spec advice contradicts the schema.

- d98c9e4: spec(storyboard-schema): add optional storyboard-level `default_agent` field

  Closes #3894. Adds an optional top-level `default_agent: <key>` field to the storyboard authoring schema (`static/compliance/source/universal/storyboard-schema.yaml`).

  `default_agent` is the logical name (`sales`, `governance`, `creative`, etc.) the multi-agent runner falls back to when a step has no `step.agent` override and the tool has no unique specialism claimant in the runtime agents map. Resolved against the `agents` option passed to `runStoryboard({ agents: {…} })` — see adcp-client#1066 and adcp-client#1355.

  The runner already accepts `default_agent` via run-options. This change lets storyboard authors encode the topology intent in YAML once, rather than re-asserting `--default-agent sales` on every CI invocation. Cross-domain tools (`sync_creatives`, `list_creative_formats`, `comply_test_controller`) become deterministic without per-step `agent:` overrides.

  Strictly additive and backward-compatible:

  - Single-agent runs ignore the field (precedent: `requires_scenarios`, `controller_seeding`).
  - Existing 3.0.x storyboards keep working unchanged.
  - Pre-existing run-options `default_agent` keeps the lower-precedence fallback slot.

  Resolution order (runner contract):

  1. Step-level `agent:` override.
  2. Unique specialism claimant in the runtime agents map.
  3. Storyboard-level `default_agent` (this field).
  4. Run-options `default_agent`.
  5. Fail-fast (`unrouted_step`).

  Mirrors the `provides_state_for` precedent (#3775) for adding optional storyboard-schema fields on 3.0.x — small, additive authoring affordances that adopters need today and that don't bind 3.0 wire shape.

## 3.0.4

### Patch Changes

- 78b1dc4: spec(errors): tighten `AUTH_REQUIRED` prose to warn on retry storms (3.0.x prose-only backport of #3739)

  `AUTH_REQUIRED` conflates two operationally distinct cases — credentials missing (genuinely correctable) and credentials presented but rejected (terminal — needs human rotation). A buyer agent treating both as `correctable` will retry-loop on revoked tokens, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

  The 3.1 line splits this into `AUTH_MISSING` and `AUTH_INVALID` (#3739). 3.0.x cannot adopt the split — adding new enum values violates the maintenance line's semver rules. This change is the prose-only backport: the wire code stays `AUTH_REQUIRED` with `recovery: correctable`, but the description and `enumMetadata.suggestion` now spell out the two sub-cases and the SHOULD-NOT-auto-retry rule for the rejected-credential case. SDKs running against 3.0.x sellers can apply the operational distinction at the application layer.

  Updates:

  - `static/schemas/source/enums/error-code.json` — `enumDescriptions.AUTH_REQUIRED` and `enumMetadata.AUTH_REQUIRED.suggestion` rewritten to call out both sub-cases and the retry-storm risk; cross-references the 3.1 split.
  - `docs/building/implementation/error-handling.mdx` — adds an `AUTH_REQUIRED sub-cases` callout under the Authentication and Access table; updates the example switch to branch on whether credentials were attached.

  Wire format unchanged. No new enum values. No recovery classification change at the structured level. Senders that already emit `AUTH_REQUIRED` keep working; receivers gain the documented sub-case discipline.

  Closes the 3.0.x portion of #3730. The full split lands in 3.1.0 via #3739.

- 78b1dc4: spec(error): standardize VALIDATION_ERROR `issues[]` as a normative field on `core/error.json`

  Closes #3059. Adds an optional top-level `issues` array to the standard error envelope, normalizing what `@adcp/client` (and prospectively `adcp-go` / `adcp-client-python` / hand-rolled sellers) already need for multi-field validation rejections.

  **Why minor**: new optional field on a published schema (`core/error.json`). Existing senders/receivers stay conformant — the field is additive. Receivers that ignore unknown fields keep working; receivers that look for it gain a richer pointer map without parsing `message` text.

  **Shape**: each entry is `{ pointer (RFC 6901), message, keyword, schemaPath? }`. `schemaPath` MAY be omitted in production to avoid fingerprinting `oneOf` branch selection on adversarial payloads.

  **Backward compatibility with `field` (singular)**: when both are present, sellers SHOULD set `field` to `issues[0].pointer`. Pre-3.1 consumers reading only `field` get the first failure; 3.1+ consumers prefer the top-level `issues`.

  **`details.issues` mirror**: sellers MAY mirror `issues[]` into `details.issues` for backward compat with consumers reading from `details`. New consumers should prefer top-level.

  Updates:

  - `static/schemas/source/core/error.json` — adds `issues` property with item shape
  - `docs/building/implementation/error-handling.mdx` — adds `issues` to the error-envelope field table; clarifies `field`/`issues` interaction

- 78b1dc4: spec(manifest): publish `manifest.json` + structured `enumMetadata` to stop SDK drift (adcp#3725) — 3.0.x backport

  Hand-cherry-picked from #3738 onto 3.0.x. The original `enumMetadata` block on `main` references three error codes (`SCOPE_INSUFFICIENT`, `READ_ONLY_SCOPE`, `FIELD_NOT_PERMITTED`) that don't exist in 3.0.x's enum; this version trims those entries so the structured metadata covers exactly the 45 codes 3.0.x ships. The build-time lint enforces that coverage invariant — there is no way to silently drift `enumMetadata` away from the published `enum`.

  Patch-bump rationale: pure additive metadata block on a published schema, plus a new buildable artifact. No new wire fields, no enum value additions, no breaking changes for any conformant 3.0 agent.

  Adds two additive artifacts to every released schema bundle:

  1. **`enums/error-code.json` gains an `enumMetadata` block.** Every error code now carries structured `recovery` (correctable | transient | terminal) and `suggestion` fields. SDKs MUST consume this block instead of parsing `Recovery: X` prose out of `enumDescriptions`. A build-time lint rejects any drift between the structured value and the prose. Root cause for adcp-client#1135 (17 missing codes, 3 wrong recovery classifications shipped in TS SDK for over a year).
  2. **`manifest.json` at `/schemas/{version}/manifest.json` (and `/schemas/latest/manifest.json` for nightly codegen).** Single canonical artifact listing every tool (with `protocol`, `mutating`, `request_schema`, `response_schema`, `async_response_schemas`, `specialisms`), every error code (with `recovery`, `description`, `suggestion`), an `error_code_policy` block (defining `default_unknown_recovery` so SDKs handle non-spec codes from non-conforming sellers correctly), and every storyboard specialism (with `protocol`, `entry_point_tools`, `exercised_tools`). Validates against `/schemas/{version}/manifest.schema.json`. Generated deterministically from existing source — no new authored content. Lets SDKs derive their internal tool/error tables from one place at codegen time instead of hand-transcribing the spec.

  `mutating` is derived using the same classifier the idempotency-key lint enforces (single source of truth — manifest and lint can never disagree). The read-only verb pattern was tightened in the process: it now anchors at the start so tools like `create-collection-list` and `delete-property-list` are no longer mis-classified as read-only because they happen to contain `-list-` mid-name. `search-` was added as a read-only verb.

  Specialisms expose two distinct tool sets per #3725 review feedback: `entry_point_tools` (the curated minimal contract from `index.yaml.required_tools` — what the spec asserts implementers MUST ship) and `exercised_tools` (the full surface — union of own phases and every linked scenario, derived by walking `phases[].steps[].task` and resolving `requires_scenarios`). SDK authors should size their tool registration against `exercised_tools` to ensure they handle every call the conformance kit will make.

  Migration: SDKs targeting 3.0.x continue to work unchanged — `enumDescriptions` and the existing `index.json` are retained verbatim. SDKs targeting 3.1+ should switch to `enumMetadata` for error recovery and `manifest.json` for tool/specialism enumeration. The prose "Recovery: X" sentence embedded in each `enumDescriptions` value is stripped from the manifest's per-code `description` to avoid double-encoding; it remains in `enumDescriptions` for the human-readable narrative until a future minor formally deprecates it. Until then, the lint guarantees both surfaces stay synchronized.

- 78b1dc4: spec(url-asset): add SHOULD on `url_type`, role-based fallback, and mechanism-vs-purpose clarification (#2986 step 2)

  `url_type` was optional with no fallback rule, so a conformant URL asset that omitted it left receivers guessing — buyers would either pick a default mechanism (with bad blast-radius if a clickthrough fired as a pixel) or refuse to render. Two parallel vocabularies (`url-asset-type` mechanism: 3 values; `url-asset-requirements.role` purpose: 6 values) compounded the confusion because the docs treated them as the same thing.

  This change:

  - Adds a top-level description on `url-asset` stating senders SHOULD include `url_type` on every URL asset, and defining the receiver fallback: when `url_type` is absent, receivers SHOULD fall back to the format's `url-asset-requirements.role` (clickthrough/landing_page → `clickthrough` mechanism; \*\_tracker roles → `tracker_pixel`); when neither is present, receivers MAY reject rather than guess.
  - Updates the `url_type` property description to frame it explicitly as the receiver's invocation mechanism, and points at the role fallback for senders that omit it.
  - Updates `url-asset-requirements.role` description to call out the mechanism-vs-purpose distinction (a `click_tracker` slot validly accepts a `tracker_pixel` URL).
  - Rewrites `docs/creative/asset-types.mdx` URL Asset section, replacing the old "you only need to supply the `url` value" guidance and the incorrect enum list (`impression_tracker`/`video_tracker`/`landing_page` — those were the requirement-side `role` values, not `url_type` values) with the actual `clickthrough`/`tracker_pixel`/`tracker_script` enum, the SHOULD note, and the role fallback table.

  Wire format unchanged. Existing senders that already include `url_type` are unaffected. Senders that omit `url_type` continue to validate but now have explicit receiver semantics; in 4.0 we plan to make `url_type` required (separate change). Closes step 2 of the rollout proposed on adcp#2986.

## 3.0.3

### Patch Changes

- a83a2aa: docs(creative-channels): replace invalid `"url_type": "tracker"` with `"url_type": "tracker_pixel"` in display, audio, carousels, and DOOH channel docs to match the `url-asset-type.json` enum (`clickthrough` / `tracker_pixel` / `tracker_script`). Addresses adcp#2986 step 1 (3.0.x docs cleanup). Wire format unchanged — the published schema enum already excluded `"tracker"`, so the channel docs were emitting an invalid value sellers could not validate against.
- dabd223: Add optional `provides_state_for: <step_id> | <step_id>[]` field to the storyboard step schema, declaring that a stateful step's pass establishes equivalent state for the named peer step(s) in the same phase. Pairs with the cascade-skip mechanism in `@adcp/sdk` 6.5.0+: when a peer step would otherwise grade `missing_tool` or `missing_test_controller`, the substitute waives the cascade and the runner grades the peer with skip reason `peer_substituted` (new in `runner-output-contract.yaml`).

  **Storyboard schema (`static/compliance/source/universal/storyboard-schema.yaml`):** documents the field next to `contributes_to`, including the all-of array semantics, same-phase-only constraint, target-stateful / substitute-stateful requirement, and acyclic-peer-graph rule.

  **Runner output contract (`static/compliance/source/universal/runner-output-contract.yaml`):** adds the `peer_substituted` skip reason to `skip_result.reasons` with detail format `"<this_step_id> state provided by <peer_phase_id>.<peer_step_id>"`. Kept distinct from `peer_branch_taken` (branch-set routing) and `not_applicable` (coverage gap).

  **Specialism YAML (`static/compliance/source/specialisms/sales-social/index.yaml`):** declares `provides_state_for: sync_accounts` on the `list_accounts` step in `account_setup`. Lets explicit-mode social platforms (Snap, Meta, TikTok) — which intentionally pre-provision advertiser accounts out-of-band and expose only `list_accounts` — graduate from `1/9/0` to `9/10` on the `sales_social` storyboard once the SDK cache refreshes against this version.

  **Build-time validation (`scripts/lint-storyboard-provides-state-for.cjs`, `tests/lint-storyboard-provides-state-for.test.cjs`):** new lint rule wired into `build-compliance.cjs` covering shape, self-reference, unknown target, cross-phase reference, target-stateful, substitute-stateful, and direct-cycle violations. Source tree passes with the one new declaration above.

  Pure additive change; existing storyboards without the field keep their current cascade behavior. Backports to the 3.0.x line per adcontextprotocol/adcp#3734.

  Closes #3734.

## 3.0.2

### Patch Changes

- 9dcf7aa: Add `envelope_field_present` check type to the storyboard schema and update `v3-envelope-integrity.yaml` to use it for the `status` presence assertion. The new check type walks `protocol-envelope.json` rather than the step's `response_schema_ref`, eliminating the static-analysis `VERIFIER_UNREACHABLE` gap in adcp-client's storyboard-drift verifier. Requires adcp-client#1045.
- 9dcf7aa: Promote the shared asset-variant `oneOf` union to a canonical `core/assets/asset-union.json` schema. Both `creative-asset.json` and `creative-manifest.json` now reference this single file instead of inlining identical `oneOf` arrays. This eliminates the `VASTAsset1`, `DAASTAsset1`, `BriefAsset1`, and `CatalogAsset1` codegen artifacts emitted by `json-schema-to-typescript` when the same union is encountered through multiple parent schemas. Wire format and validation semantics are unchanged.

## 3.0.1

See [release notes](docs/reference/release-notes.mdx#version-301) for the curated narrative — 3.0.1 is a stable-surface no-op for 3.0-conformant agents. Skills bundle in `/protocol/3.0.1.tgz`, normative clarifications, additive fields on experimental surfaces (governance, TMP) per the experimental-status contract, and one docs-level deprecation (`get_signals` top-level `max_results`).

### Patch Changes

- 10aa2b3: Cut **3.0.1** to ship `skills/` in the protocol tarball and fix path drift in `skills/call-adcp-agent/SKILL.md`. Closes #3116, #3117.

  **Why a patch bump (not a re-cut at 3.0.0):** the protocol tarball is the SDK distribution surface. `3.0.0.tgz` was published 2026-04-22, before #3097 hoisted `skills/`. Re-cutting at the same version would mean a new SHA-256 at the same stable URL — incompatible with content-addressed pipelines, supply-chain attestations, and the cosign signature bound to the original content. Pre-merge expert review (protocol + security) recommended bumping to preserve immutability and produce a fresh signed release through the normal `release.yml` path.

  **What's in 3.0.1:**

  - `skills/` bundled in `/protocol/3.0.1.tgz` (the seven protocol-managed skills: `call-adcp-agent` + the per-protocol `adcp-{brand,creative,governance,media-buy,si,signals}`)
  - `manifest.contents.skills` enumerated for SDK sync scripts to detect
  - `skills/call-adcp-agent/SKILL.md` — replace four hardcoded `dist/schemas/<version>/bundled/...` references with discovery-first phrasing that doesn't assume an SDK layout
  - `docs/protocol/calling-an-agent.mdx` — sister content fix

  **What does NOT change:** every schema, every task definition, every wire-format detail in 3.0.0 carries over identically to 3.0.1. The bump is for the bundle/skill axis, not the protocol-spec axis.

  **SDK action:** bump `ADCP_VERSION` from `3.0.0` to `3.0.1` to receive the canonical skills via your existing sync flow. JS-side wiring is in [adcontextprotocol/adcp-client#965](https://github.com/adcontextprotocol/adcp-client/pull/965); Python and Go follow-ups tracked in [adcp-client-python#274](https://github.com/adcontextprotocol/adcp-client-python/issues/274) and [adcp-go#91](https://github.com/adcontextprotocol/adcp-go/issues/91).

- a7dbe65: docs(brand): specify normative request-validation clauses for `acquire_rights` (closes #2680, #2681)

  Two campaign-field validations on `acquire_rights` were sensible-but-unspecified in 3.0, leaving implementers to disagree on identical requests:

  1. **Expired campaign window.** Brand agents MUST reject with `INVALID_REQUEST` and `field: "campaign.end_date"` when `campaign.end_date` is in the past at the time of the request. Issuing a zero-duration grant is almost always a buyer-side bug; deterministic rejection is more useful than silent expiry. Unlike `create_media_buy` (where `any_of` supports time-shifting a flight forward), rights grants attach to the requested period and cannot be retroactively shifted, so reject-only is the correct contract.

  2. **CPM-priced rights under a governed plan.** When the request carries an intent-phase `governance_context` token (the buyer's plan is governed) and the selected pricing option has `model: "cpm"`, brand agents MUST reject with `INVALID_REQUEST` and `field: "campaign.estimated_impressions"` when that field is omitted or `0`. When provided, projected commitment is `(pricing_option.price / 1000) × campaign.estimated_impressions` evaluated in `pricing_option.currency`. If `pricing_option.currency` differs from the plan's budget currency, the agent MUST reject with `field: "pricing_option_id"` — currency conversion is not specified. If the projected commitment exceeds remaining plan budget, the agent MUST reject with `field: "campaign.estimated_impressions"`. Non-CPM pricing options commit the flat amount regardless of volume; agents MUST NOT require `estimated_impressions` for governance projection on those.

  Added a new "Request validation" section to `docs/brand-protocol/tasks/acquire_rights.mdx` and tightened the field descriptions on `static/schemas/source/brand/acquire-rights-request.json` for `campaign.end_date` and `campaign.estimated_impressions` so the validation contract is discoverable from both the task reference and the schema.

  Patch-eligible: docs-only clarification of behavior the spec already implied. No schema shape changes (only description text); no new error codes (`INVALID_REQUEST` is already standard). The `governance_context` anchor and the `(price / 1000) × impressions` projection formula reference fields that exist on the published 3.0 schemas — this PR does not introduce new wire surface, only normative interpretation.

- 926b079: feat(compliance): add seed_creative_format scenario and list_creative_formats pagination

  Adds `seed_creative_format` to `comply_test_controller` so the compliance harness can pre-populate a deterministic, size-controlled set of creative formats for pagination-integrity storyboards. `comply_test_controller` is a conformance-harness surface, not a core-protocol task — additive enum extensions on it bump at patch level under AdCP semver.

  **Schema changes (comply-test-controller-request.json, comply-test-controller-response.json):** `seed_creative_format` added to the `scenario` enum in both files. The request schema gains a `params.format_id` string field (required when `scenario = seed_creative_format`) and the response schema's `list_scenarios` enum is extended to match.

  **Training-agent implementation:** `seed_creative_format` is handled in `handleComplyTestController` before the SDK dispatcher. Seeded formats are stored in a new `session.complyExtensions.seededCreativeFormats` map and replace the static catalog when non-empty for `list_creative_formats` responses.

  **Pagination:** `handleListCreativeFormats` now applies cursor-based pagination (matching the `list_creatives` pattern) and is session-aware to read seeded formats. Non-compliance callers continue to see the full static catalog with pagination applied.

  **Storyboard:** `pagination-integrity-creative-formats.yaml` exercises the cursor↔has_more invariant on `list_creative_formats` by seeding two formats and walking pages at `max_results=1`.

  Non-breaking: adds a new enum value and optional param. Sellers that don't implement `seed_creative_format` will return `UNKNOWN_SCENARIO`; the storyboard's `controller_seeding: true` signals that support is required for this storyboard to pass. Existing callers of `list_creative_formats` are unaffected — pagination fields are additive to the response.

  Closes #3108.

- ae7eae2: Add optional `mode` field to `get_plan_audit_logs` audit entries, recording the governance mode (enforce/advisory/audit) active at check time. Surfaces the enforcement posture that produced each decision, closing a gap where audit and enforce modes produced identical-looking trails.
- 46439c4: **Apply the AdCP URL canonicalization rule to brand.json agent URLs.**

  Follow-up to #3067 — the canonicalization reference page now exists,
  and `seller-agent-ref`, `adagents.json` `authorized_agents[].url`,
  `format-id`, and `provider-registration` all link to it. `brand.json`
  declares additional agent URLs that fall in the same identifier-
  comparison class but weren't covered:

  - `brand_agent_entry.url` — the brand-declared agent endpoint (MCP or
    A2A) used by callers resolving "is this the agent that signed this
    artifact?" or matching against a discovery cache.
  - `brand_agent.url` — the brand agent MCP endpoint reference.
  - `rights_agent.url` — the rights agent MCP endpoint reference.

  All three now reference the AdCP URL canonicalization rules at
  `docs/reference/url-canonicalization` so two URLs differing only in
  case, default port, or percent-encoded unreserved characters compare
  equal during agent resolution.

  `logo.url`, `data_subject_contestation.url`, asset-library `url`, and
  the brand's primary `url` are _not_ identifier-comparison keys (they
  point at human-facing pages or asset CDN endpoints), so they were
  left unchanged.

  `jwks_uri` (line 627) is a fetch target for JWKS download, not an
  identifier-comparison key — receivers HTTP-GET the URL as declared
  without comparing it to anything. Not in scope for this rule.

  No schema shape changes. Descriptions only.

- 1cd99c2: Make the `task_status` / `response_status` prohibition from #3021 machine-enforceable at the schema level. Adds a `not: { anyOf: [{ required: [task_status] }, { required: [response_status] }] }` constraint on `protocol-envelope.json` (matching the existing idiom in `catchment.json`) so any JSON Schema validator rejects envelopes that dual-emit legacy status fields — no runner-specific primitive required. The prose MUST NOT in the envelope `status` description remains for human readers; the constraint is what validators act on. Closes #3041 at the spec layer. Runtime conformance (storyboard `field_absent` primitive + `@adcp/client` implementation) is tracked separately.
- ea8e282: Add `title` to all `oneOf` branches in `format.json`'s `assets[]` array so codegen tools (json-schema-to-typescript, datamodel-code-generator, oapi-codegen) produce named, discriminated per-asset-type interfaces instead of collapsing them to an untyped union. Adds titles `IndividualImageAsset` … `IndividualCatalogAsset` and `RepeatableGroupAsset` at the top level, plus `GroupImageAsset` … `GroupWebhookAsset` for the nested branches inside `repeatable_group.assets[]`. Purely annotation-level; no validation or wire-format change.
- cecca44: Deprecates top-level `max_results` on `get_signals` and pins `pagination.max_results` precedence.

  `get-signals-request.json` carried two independent pagination fields — a legacy top-level `max_results` (no cap, no default, predates the pagination envelope) and the standard `pagination` envelope (`pagination.max_results`, max: 100, default: 50). The schema was silent on which wins when both are present.

  This change adds a MUST-level precedence rule: when both fields are present, agents MUST honor `pagination.max_results`. It also deprecates the top-level field with guidance for sellers receiving it without a pagination envelope. The top-level `max_results` will be removed in AdCP 4.0.

  All other paginated read endpoints (`get_products`, `list_creatives`, `list_creative_formats`, `get-collection-list`, `get-property-list`, `get-media-buy-artifacts`, `tasks-list`) carry only `pagination` — this brings `get_signals` into alignment.

  Non-breaking: adds description-level deprecation and normative prose. No type, structure, or required-field changes. Existing callers unaffected; sellers adding the conflict check gain new conformance grounding.

- 00c1574: Add `mode` to `check_governance` response schema and fix `binding`→`check_type` drift in training agent audit entries.

  `check-governance-response.json` now declares the optional `mode` field (enforce/advisory/audit) that the training agent was already emitting, letting counterparties and regulators distinguish `approved`-with-finding decisions made under `enforce` from those made under `audit`. The training agent audit log handler no longer emits the non-canonical `binding` field (which caused schema-validation failures on the strict `entries[]` schema); it now emits `check_type: "intent"|"execution"` per the existing schema contract. The schema carries `x-status: experimental`. Audit-entry `mode` is added separately by #3160.

- ff95642: Clarify `policies_evaluated` description in `check-governance-response.json` and `get-plan-audit-logs-response.json`. The previous wording ("Registry policy IDs...") was incomplete and misleading: governance agents also record inline `policy_id`s from `custom_policies` in this field, and a consumer reading the description literally could write a parser that filters them out. The new wording names both sources. Both schemas carry `x-status: experimental`. Description-only clarification; no type, enum, or wire change.
- 20a8310: Mark `governance-mode.json` enum as `x-status: experimental` and clarify the per-check semantics of the audit-entry `mode` field.

  The enum is referenced exclusively from experimental schemas (`check-governance-response.json`, `get-plan-audit-logs-response.json` `entries[]`); annotating it explicitly prevents the enum from being treated as stable while its consumers are still experimental. The `entries[].mode` description is tightened to clarify that the field reflects the mode active for that specific check, distinct from a future `governed_actions[].mode` (which would describe the action's current mode and may differ if the plan has been re-synced since).

- 3027c39: feat(schema): hoist 4 duplicate inline enum literal sets into shared `enums/` definitions (closes #3144)

  Several inline string-literal unions in the AdCP source schemas had byte-identical value sets across multiple parent schemas but no shared `$ref`, causing the TypeScript SDK to emit per-parent duplicate exports (`Account_PaymentTermsValues`, `GetAccountFinancialsSuccess_PaymentTermsValues`, etc.) when a single canonical `PaymentTermsValues` is what consumers expect.

  **New shared enum files added** (4 new `$id`-bearing schemas in `static/schemas/source/enums/`):

  - `payment-terms.json` — `["net_15","net_30","net_45","net_60","net_90","prepay"]`
  - `audio-channel-layout.json` — `["mono","stereo","5.1","7.1"]`
  - `media-buy-valid-action.json` — `["pause","resume","cancel","update_budget","update_dates","update_packages","add_packages","sync_creatives"]`
  - `rights-billing-period.json` — `["daily","weekly","monthly","quarterly","annual","one_time"]`

  **Schemas updated to use `$ref`** (10 files; wire format unchanged in all cases):

  - `core/account.json`, `account/sync-accounts-request.json`, `account/sync-accounts-response.json`, `account/get-account-financials-response.json` → `payment_terms` now refs `enums/payment-terms.json`
  - `core/assets/audio-asset.json`, `core/assets/video-asset.json` → `channels`/`audio_channels` now ref `enums/audio-channel-layout.json`
  - `media-buy/create-media-buy-response.json`, `media-buy/update-media-buy-response.json` → `valid_actions` items now ref `enums/media-buy-valid-action.json`
  - `brand/rights-terms.json`, `brand/rights-pricing-option.json` → `period` now refs `enums/rights-billing-period.json`

  **Not changed:** `core/insertion-order.json` `payment_terms` (`["net_30","net_60","net_90","prepaid","due_on_receipt"]` — different set, kept inline).

  Non-breaking: replacing inline `{"type":"string","enum":[...]}` with a `$ref` to an equivalent standalone schema produces an identical JSON Schema subgraph; all existing validators behave identically. Source-schema refactor only; bundled wire format is unchanged — patch-eligible.

  After a `npm run sync-schemas` in `adcp-client`, the SDK will emit single canonical exports (`PaymentTermsValues`, `AudioChannelLayoutValues`, etc.) and should ship deprecated re-export aliases for any per-parent names that were in a published release.

- feed616: Hoist 13 duplicate inline enum sets into shared `enums/` definitions (follow-up to #3148).

  Adds `match-type`, `collection-kind`, `frame-rate-type`, `scan-type`, `gop-type`, `moov-atom-position`, `binary-verdict`, `account-scope`, `governance-decision`, `billing-party`, `feature-check-status`, `snapshot-unavailable-reason`, and `travel-time-unit` as standalone `$id`-bearing enum files. Updates 21 source schemas to `$ref` these files instead of repeating the inline definitions. Source-schema refactor only; bundled wire format is unchanged in all cases.

- 4614f4d: Clarify that v3 agents MUST NOT emit legacy status fields (`task_status`, `response_status`, or any alias) alongside the v3 `status` field. Adds a migration checklist row, a conformance warning in the task-lifecycle reference, and extends the protocol envelope schema's `status` description with the prohibition. Closes #2987.
- 90ad0dd: Add `x-status: experimental` to all 9 TMP schemas and `core/seller-agent-ref.json` (exclusively referenced by TMP), completing the experimental-status contract already declared for `trusted_match.core` in `get_adcp_capabilities` and `experimental-status.mdx`. Mirrors the existing pattern on all 11 sponsored-intelligence schemas. Enables validators, doc generators, and tooling to identify TMP as an experimental surface. No wire-format or field changes.
- f1e8340: **TMP: explicit seller-agent attribution on AvailablePackage.**

  Add `seller_agent: { agent_url, id? }` to the Trusted Match Protocol
  AvailablePackage schema, making seller identity explicit on every
  package cached by a TMP provider. The canonical identifier is the
  seller's agent URL as declared in the property publisher's
  `adagents.json` `authorized_agents[].url`; the reserved `id` slot is
  forward-compatible with a future registry-assigned opaque identifier.

  - **`/schemas/core/seller-agent-ref.json`** — new shared schema
    mirroring the `{agent_url, id?}` shape used by `format-id` and
    `ProviderEntry`.
  - **`/schemas/tmp/available-package.json`** — `seller_agent` added as
    a required field. Lands as a patch under the experimental-surface
    contract (`experimental_features: trusted_match.core`, which allows
    breaking changes between 3.x releases with advance notice); sellers
    syncing `AvailablePackage` payloads need to populate it going
    forward.
  - **`/schemas/tmp/offer.json`** — optional `seller_agent` echo so
    publisher-side log pipelines can attribute offers to sellers
    without round-tripping to the media-buy store. Non-authoritative:
    the cached package binding remains source of truth; routers MAY
    stamp the field on merge when providers omit it.
  - **`/schemas/tmp/error.json`** — adds `seller_not_authorized` error
    code for sync-time rejection when `seller_agent.agent_url` is not
    present in the property publisher's adagents.json
    `authorized_agents[].url` list.
  - **`docs/trusted-match/specification.mdx`** — new "Package Sync"
    section defines the sync contract, the SHOULD-level adagents.json
    validation flow, explicit per-actor responsibilities (seller
    agent, publisher, router, provider), and the "what this is not"
    boundary (not a request-time filter, not a sellers.json bridge,
    not a cryptographic attestation). Offer and Error tables updated
    accordingly; definitions table gains a **Seller agent** entry.

  Seller identity lives on the cached `AvailablePackage`, not on
  `context_match_request` or `identity_match_request`. Providers —
  which have no access to a media-buy store — need provenance on the
  wire they actually receive; putting it on the request would either
  duplicate the sync-time binding or open a path for request-time
  seller filtering that re-introduces the identity- and
  allocation-leakage failure modes that package-set decorrelation
  exists to prevent. Publishers and routers can derive seller identity
  from `media_buy_id` against their own stores; providers cannot.

  TMP remains experimental under AdCP 3.x — schema additions here
  follow the experimental-surface contract and do not bump the stable
  AdCP major. The `SellerAgentRef.id` slot and optional `ext` namespace
  leave room to layer signed seller claims or an AAO-assigned opaque
  identifier without a rename later.

- aa71ebc: **URL canonicalization: one authoritative reference for every URL-as-identifier comparison in AdCP.**

  The canonicalization algorithm previously lived only under the request-signing profile in `docs/building/implementation/security.mdx`, but AdCP compares URLs as identifiers in many other places — TMP seller authorization (`seller_agent.agent_url` vs `authorized_agents[].url`), TMP provider resolution (`ProviderEntry.agent_url`), `format-id.agent_url` equivalence, and signal/feature agent lookups in `adagents.json`. Schemas today said "exactly as declared," which reads as byte-equality; two URLs that differ only in case, default port, or percent-encoded unreserved characters would silently miss the match.

  This change moves the algorithm to a first-class reference page and links every consuming surface to it, so the same canonicalization binds everywhere.

  - **New `docs/reference/url-canonicalization.mdx`** — the authoritative home of the 8-step algorithm (RFC 3986 §6.2.2 + §6.2.3, UTS-46 Nontransitional IDN pin, IPv6 zone-identifier rejection, enumerated malformed-authority cases), a "where it applies" table covering signing / TMP seller authorization / TMP provider resolution / `adagents.json` lookups / `format-id` / `authoritative_location` indirection, a "signing profile extensions" note for the transport-only bits, and a common-pitfalls list.
  - **`docs/building/implementation/security.mdx`** — `@target-uri` section now cites the reference page instead of restating the eight steps. Keeps only the signing-specific extensions (HTTP/2 `:authority` derivation, dual-header rejection, `request_target_uri_malformed` error, cross-vhost replay gate). Removes the drift risk between two copies.
  - **`static/schemas/source/core/seller-agent-ref.json`** — `agent_url` description replaces "exactly as declared" with canonicalization-based comparison. Also drops the "in production" weasel on HTTPS — the scheme requirement is now unconditional.
  - **`static/schemas/source/adagents.json`** — all six `url` descriptions updated: the four `authorized_agents[].url` variants, plus the two signals-authorization variants (`signal_ids`, `signal_tags`) and the property-features variant.
  - **`static/schemas/source/core/format-id.json`** — `agent_url` description updated to require canonicalization.
  - **`static/schemas/source/tmp/provider-registration.json`** — `endpoint` description extends the existing SSRF/DNS-rebinding language with a canonicalization rule for provider-registry de-duplication.
  - **`docs/trusted-match/specification.mdx`** — TMP Sync-Time Validation step 2 links canonicalization rules explicitly and adds an explicit `https://`-only rejection (non-HTTPS seller URLs get `seller_not_authorized`, closing the scheme-mismatch bypass). ProviderEntry table row links the canonicalization rules for provider comparison.
  - **`docs.json`** — reference page added to both primary and legacy sidebars adjacent to `versioning` (other interop-rules references).

  No schema shape changes. Descriptions only. Schema link style follows the repo convention (`See docs/<path>` bare, no backticks or leading slash).

- 9ff83de: feat(compliance): v3 envelope integrity universal storyboard

  Adds `static/compliance/source/universal/v3-envelope-integrity.yaml` — a universal storyboard (applies to all agent interaction models) that asserts the v3 `status` field is present on the response envelope and that the legacy v2 `task_status` / `response_status` field names are absent.

  Schema-level enforcement of the prohibition is provided separately by `envelope-forbid-legacy-status-fields.md` (top-level `not: { anyOf: [{ required: [task_status] }, { required: [response_status] }] }` on `protocol-envelope.json`). This changeset is the runtime/storyboard counterpart.

  The explicit envelope-root field-absence assertions are wired as TODO `field_absent` checks pending runner support in `@adcp/client`; the immediate enforcement path remains the schema-level constraint, which any schema-aware validator detects without runner-specific primitives. Closes #3041 at the storyboard layer.

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
