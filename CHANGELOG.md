# Changelog

## 3.1.0-beta.0

### Minor Changes

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

- 556edf3: Extend `check:platform-agnostic` lint to cover enum and const values; fix `brand.json` platform-agnosticism violation.

  **Lint extension (`tests/check-platform-agnostic.cjs`):** adds enum/const-value scanning alongside the existing property-name check. Uses a path-qualified `ENUM_VALUE_ALLOWLIST` so the same vendor token can be legitimate in one enum (e.g., `roku` in `enums/genre-taxonomy.json`) but a violation in another. Pre-compiles vendor-token regexes. Skips `examples` arrays (user-data samples, not normative definitions). Title/description text intentionally excluded — vendor names in prose are permitted per spec-guidelines.

  **Schema fix (`static/schemas/source/brand.json`):** removes the single-value enum `["openai_agentic_checkout_v1"]` from `product_catalog.agentic_checkout.spec` and replaces it with a free-form `string`. The enum encoded a specific vendor's checkout API version as a normative discriminator, violating the platform-agnosticism rule in `docs/spec-guidelines.md`. Non-breaking: existing data using `"openai_agentic_checkout_v1"` remains valid.

  **Note:** `openai_product_feed` in `brand.json`'s `feed_format` enum is contested (see #2439): one expert treats it as a violation; another treats it as a canonical feed-schema identifier parallel to `google_merchant_center`. It is allowlisted pending @bokelley's decision.

  Closes #2439.

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

- 1154e9d: feat(schema): add `Submitted` arm to per-tool response `oneOf` for `update_media_buy`, `build_creative`, and `sync_catalogs` (#3392)

  AdCP 3.0 shipped `*-async-response-submitted.json` schemas for 6 HITL tools but only 2 of 6 per-tool `xxx-response.json` schemas included the `Submitted` arm in their top-level `oneOf`. This left SDK codegen unable to generate typed `*Task` HITL methods for the 4 missing tools.

  This changeset fixes 3 of the 4 gaps (the `get_products` case is flagged for human review — see #3392):

  - `update-media-buy-response.json` — adds `UpdateMediaBuySubmitted` arm (`status: "submitted"` + `task_id`); updates `UpdateMediaBuyError.not` to exclude the submitted state
  - `build-creative-response.json` — adds `BuildCreativeSubmitted` arm; updates `BuildCreativeError.not` to exclude the submitted state
  - `sync-catalogs-response.json` — adds `SyncCatalogsSubmitted` arm; updates `SyncCatalogsError.not` to exclude the submitted state

  Non-breaking: existing `Success | Error` consumers are unaffected. Buyers gain a new permitted response shape and SDK codegen can produce typed HITL methods for these three tools.

  Note: the fix uses the same inline arm pattern as `create-media-buy-response.json` and `sync-creatives-response.json` — not `$ref` to the `*-async-response-submitted.json` schemas (those are task-completion artifact payloads for the webhook path, not the initial-response discriminated arm).

  Closes partial scope of #3392.

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

- f23c966: Add `search_brands` task to the brand protocol.

  Provides a natural-language brand discovery verb for IP desks that need to find brands on an agent's roster before they have a known `brand_id`. Returns lightweight brand stubs (public identity tier) that feed directly into `get_brand_identity` or `get_rights` without an extra identity-resolution round-trip.

  New schemas (experimental): `search-brands-request.json`, `search-brands-response.json`. New task type `search_brands` added to stable `task-type.json` enum.

  Closes #3480.

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

- b44996f: spec(manifest): publish `manifest.json` + structured `enumMetadata` to stop SDK drift (adcp#3725)

  Adds two additive artifacts to every released schema bundle:

  1. **`enums/error-code.json` gains an `enumMetadata` block.** Every error code now carries structured `recovery` (correctable | transient | terminal) and `suggestion` fields. SDKs MUST consume this block instead of parsing `Recovery: X` prose out of `enumDescriptions`. A build-time lint rejects any drift between the structured value and the prose. Root cause for adcp-client#1135 (17 missing codes, 3 wrong recovery classifications shipped in TS SDK for over a year).
  2. **`manifest.json` at `/schemas/{version}/manifest.json` (and `/schemas/latest/manifest.json` for nightly codegen).** Single canonical artifact listing every tool (with `protocol`, `mutating`, `request_schema`, `response_schema`, `async_response_schemas`, `specialisms`), every error code (with `recovery`, `description`, `suggestion`), an `error_code_policy` block (defining `default_unknown_recovery` so SDKs handle non-spec codes from non-conforming sellers correctly), and every storyboard specialism (with `protocol`, `entry_point_tools`, `exercised_tools`). Validates against `/schemas/{version}/manifest.schema.json`. Generated deterministically from existing source — no new authored content. Lets SDKs derive their internal tool/error tables from one place at codegen time instead of hand-transcribing the spec.

  `mutating` is derived using the same classifier the idempotency-key lint enforces (single source of truth — manifest and lint can never disagree). The read-only verb pattern was tightened in the process: it now anchors at the start so tools like `create-collection-list` and `delete-property-list` are no longer mis-classified as read-only because they happen to contain `-list-` mid-name. `search-` was added as a read-only verb.

  Specialisms expose two distinct tool sets per #3725 review feedback: `entry_point_tools` (the curated minimal contract from `index.yaml.required_tools` — what the spec asserts implementers MUST ship) and `exercised_tools` (the full surface — union of own phases and every linked scenario, derived by walking `phases[].steps[].task` and resolving `requires_scenarios`). SDK authors should size their tool registration against `exercised_tools` to ensure they handle every call the conformance kit will make.

  Migration: SDKs targeting 3.0.x continue to work unchanged — `enumDescriptions` and the existing `index.json` are retained verbatim. SDKs targeting 3.1+ should switch to `enumMetadata` for error recovery and `manifest.json` for tool/specialism enumeration. The prose "Recovery: X" sentence embedded in each `enumDescriptions` value is stripped from the manifest's per-code `description` to avoid double-encoding; it remains in `enumDescriptions` for the human-readable narrative until a future minor formally deprecates it. Until then, the lint guarantees both surfaces stay synchronized.

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

- f6af651: spec(url-asset): add SHOULD on `url_type`, role-based fallback, and mechanism-vs-purpose clarification (#2986 step 2)

  `url_type` was optional with no fallback rule, so a conformant URL asset that omitted it left receivers guessing — buyers would either pick a default mechanism (with bad blast-radius if a clickthrough fired as a pixel) or refuse to render. Two parallel vocabularies (`url-asset-type` mechanism: 3 values; `url-asset-requirements.role` purpose: 6 values) compounded the confusion because the docs treated them as the same thing.

  This change:

  - Adds a top-level description on `url-asset` stating senders SHOULD include `url_type` on every URL asset, and defining the receiver fallback: when `url_type` is absent, receivers SHOULD fall back to the format's `url-asset-requirements.role` (clickthrough/landing_page → `clickthrough` mechanism; \*\_tracker roles → `tracker_pixel`); when neither is present, receivers MAY reject rather than guess.
  - Updates the `url_type` property description to frame it explicitly as the receiver's invocation mechanism, and points at the role fallback for senders that omit it.
  - Updates `url-asset-requirements.role` description to call out the mechanism-vs-purpose distinction (a `click_tracker` slot validly accepts a `tracker_pixel` URL).
  - Rewrites `docs/creative/asset-types.mdx` URL Asset section, replacing the old "you only need to supply the `url` value" guidance and the incorrect enum list (`impression_tracker`/`video_tracker`/`landing_page` — those were the requirement-side `role` values, not `url_type` values) with the actual `clickthrough`/`tracker_pixel`/`tracker_script` enum, the SHOULD note, and the role fallback table.

  Wire format unchanged. Existing senders that already include `url_type` are unaffected. Senders that omit `url_type` continue to validate but now have explicit receiver semantics; in 4.0 we plan to make `url_type` required (separate change). Closes step 2 of the rollout proposed on adcp#2986.

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

- 6eadf06: spec(versioning): release-precision protocol version negotiation via `adcp_version` envelope field

  Adds `adcp_version` (release-precision semver string, e.g. `"3.0"`, `"3.1"`, `"3.1-beta"`) as a top-level field on every request and response. Buyers send their release pin; sellers echo the release they actually served — never the seller's own latest release. Augments the existing `adcp_major_version` (integer) with finer precision and adds response-side echo, which the spec lacked.

  Composed once via `allOf $ref` to the new `core/version-envelope.json` schema (single source of truth across all 127 task schemas — no inline duplication).

  Capabilities response gains `adcp.supported_versions` (release strings, authoritative for negotiation) and `adcp.build_version` (full semver build identifier with optional pre-release and build-metadata per semver §9–§10, advisory only). `VERSION_UNSUPPORTED` error gets a standardized `error.data` shape via the new `error-details/version-unsupported.json` schema; `supported_versions` is required.

  Migration: spec stays SHOULD on both sides through all of 3.x (consistent with the 3.x stability guarantee that fields don't graduate optional → required within a major). The compliance grader carries the adoption pressure: advisory at 3.1, blocking failure at 3.2 for sellers that don't echo `adcp_version` or don't emit `supported_versions` on capabilities. 4.0 promotes the spec to MUST and removes `adcp_major_version`, `adcp.major_versions`, and `extensions.adcp.adcp_version`. Through 3.x, buyers SHOULD dual-emit both `adcp_version` and `adcp_major_version` so legacy 3.x sellers keep negotiating; when the two disagree at the major level the server MUST return `VERSION_UNSUPPORTED`.

  Fully additive on the wire (existing servers ignore `adcp_version` via `additionalProperties: true`). RFC: `specs/version-negotiation.md`.

  **One scoped behavior change in 17 request schemas:** the `allOf $ref` envelope-composition pattern requires permissive `additionalProperties` at root (draft-07 doesn't bypass parent strict-mode through `allOf`). 17 request schemas under `collection/`, `governance/`, `property/`, and `tmp/` previously declared `additionalProperties: false`; this PR flips them to `true` so the envelope's fields are accepted. Strict request validation returns at draft 2019-09 via `unevaluatedProperties: false` (tracked in #3534). The new lint at `tests/lint-version-envelope.test.cjs` enforces the invariant going forward.

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

- 5740802: docs(aao-verified): make the two axes truly orthogonal — Live is no longer a downstream of Spec. The prerequisite framing was wrong: a seller without a sandbox/test endpoint (common for SDK-built agents whose wire format is guaranteed by the SDK, or for production-only platforms that have no test-mode surface) can earn (Live) directly by enrolling a compliance account. The eight observability checks already exercise wire format, filters, lifecycle, and scope introspection through real traffic, which makes a separate simulation pass redundant for that seller. Conversely, a test agent earns (Spec) as a complete claim.

  Updated copy in `docs/building/aao-verified.mdx`:

  - Top-level framing now states the axes are orthogonal, not hierarchical.
  - (Live) eligibility table no longer says "Currently holds (Spec)".
  - "(Live) only" badge reading is now a normal, valid claim — not a "rare and transient" state.
  - Mark semantics list (Live) only as a holding alongside (Spec) only and (Spec + Live).
  - Lifecycle: revoking (Spec) no longer revokes (Live); revoking (Live) no longer touches (Spec).

  Updated `docs/building/conformance.mdx` to match: both marks attest conformance via different evidence (Spec via simulation, Live via real-traffic observability).

  No code changes — the badge model already supported `verification_modes: ['live']` standalone; the only thing that needed fixing was the documentation that incorrectly claimed otherwise.

- 063e317: spec(errors): tighten `AUTH_REQUIRED` prose to warn on retry storms

  `AUTH_REQUIRED` conflates two operationally distinct cases — credentials missing (genuinely correctable) and credentials presented but rejected (terminal — needs human rotation). A buyer agent treating both as `correctable` will retry-loop on revoked tokens, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

  The 3.1 line will eventually split this into `AUTH_MISSING` and `AUTH_INVALID` via #3739. Until that split ships, the prose tightening is the only operational guidance against the retry-storm pattern. The wire code stays `AUTH_REQUIRED` with `recovery: correctable`; the description and `enumMetadata.suggestion` now spell out the two sub-cases and the SHOULD-NOT-auto-retry rule for the rejected-credential case. Agents apply the operational distinction at the application layer by branching on whether credentials were attached to the failing request.

  Updates:

  - `static/schemas/source/enums/error-code.json` — `enumDescriptions.AUTH_REQUIRED` and `enumMetadata.AUTH_REQUIRED.suggestion` rewritten to spell out both sub-cases and the retry-storm risk. The description follows the same summary-then-`Sub-cases (full guidance).` shape already used by `GOVERNANCE_DENIED` / `GOVERNANCE_UNAVAILABLE`, with a cross-reference to `error-handling.mdx#auth_required-sub-cases`.
  - `docs/building/implementation/error-handling.mdx` — adds an `AUTH_REQUIRED sub-cases` Mintlify `<Warning>` callout under the Authentication and Access table; the recovery example switch now derives `requestHadCredentials` locally from `error.request_had_credentials` so a reader pasting the snippet doesn't hit `ReferenceError`.

  Wire format unchanged. No new enum values. No recovery classification change at the structured level. Senders that already emit `AUTH_REQUIRED` keep working; receivers gain the documented sub-case discipline.

  Also drops two stale forward-merge changeset leftovers (`envelope-field-present-check-type`, `fix-asset-union-dedup`) whose work has already shipped to 3.0.x and is also already in-tree on `main` — without this cleanup the next 3.1.0 cut would emit duplicate CHANGELOG entries.

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

- b62c407: spec(errors): wire-placement guidance for `GOVERNANCE_DENIED` and `GOVERNANCE_UNAVAILABLE`

  `error-code.json` defined the codes' semantics but didn't say WHERE in the response they appear. Different storyboards interpreted differently — issue #3914 surfaced one mismatch where the brand-rights compliance storyboard expected `expect_error: code: GOVERNANCE_DENIED` even though `acquire_rights` already has a first-class `AcquireRightsRejected` discriminated arm with `reason`. Adopters returning the spec-correct Rejected shape were failing the storyboard.

  The `enumDescriptions` for both codes now state placement explicitly:

  - **`GOVERNANCE_DENIED`** — structured business outcome, not a system error. When the task response defines a structured rejection arm (e.g., `AcquireRightsRejected`), that arm is the canonical denial shape — populate `status: "rejected"` + `reason`, do NOT additionally emit the code in `errors[]` or `adcp_error`, and do NOT flip transport-level failure markers. When the task has no rejection arm (e.g., `create_media_buy` returns the `Error` arm), populate `errors[].code` AND `adcp_error.code` per the two-layer model and DO flip transport markers.
  - **`GOVERNANCE_UNAVAILABLE`** — system error, governance call failed at all. Always populate both layers with the code and flip transport markers. Sellers MUST NOT use a structured rejection arm for unavailability even when the task offers one — the buyer's recovery semantics differ (retry-with-backoff vs. restructure-or-escalate).

  The contrast resolves the question the storyboard mismatch surfaced: thrown adcp_error is reserved for governance-call failure modes (parallel to `GOVERNANCE_UNAVAILABLE`), not for adopter-controlled denials.

  The MUST NOT against dual-emission isn't a behavior change — `AcquireRightsRejected` and `CreativeRejected` already declare `not: { required: [errors] }` at the schema layer, so emitting `errors[]` alongside a rejection arm was already a schema violation. The doc-comment makes the rule discoverable from the error code without changing what conformant senders produce.

  Also adds a parallel storyboard-authoring note in `error-handling.mdx`: when the task response has a discriminated rejection arm, assertions should use `check: field_value, path: "status", value: "rejected"` rather than `check: error_code`. The existing `error_code` guidance is correct for tasks without a rejection arm; the new note covers the rejection-arm path that surfaced via #3914.

  Closes the doc-comment item on #3918; companion to #3914 (storyboard fix is separate work).

- 469b6d3: Add `discriminator: { propertyName }` to 16 `oneOf` unions in `static/schemas/source/` whose variants already declare the same required property as a `const` with distinct string values, and tighten `scripts/audit-oneof.mjs` to assert that any `discriminator.propertyName=X` is backed by every non-ref variant declaring `properties.X` as required const with distinct values.

  Affected schemas: `adagents.json`, `compliance/comply-test-controller-response.json`, `content-standards/artifact.json`, `core/activation-key.json`, `core/creative-item.json`, `core/deployment.json`, `core/destination.json`, `core/optimization-goal.json` (3 unions), `core/requirements/catalog-field-binding.json` (2 unions), `core/signal-pricing.json`, `creative/preview-creative-response.json`, `creative/preview-render.json`.

  Non-breaking: the OpenAPI `discriminator` keyword is ignored by JSON Schema 2020-12 validators that don't recognize it; the existing `const`-property pattern remains the source of truth. Codegen targets that respect the keyword (msgspec, openapi-typescript, datamodel-code-generator) now emit a properly-narrowed union without per-variant casts. Tracking: adcp#3917.

- c09f2e0: Add `discriminator: { propertyName }` to two more `oneOf` unions previously deferred from #3928:

  - `core/pricing-option.json` `#/oneOf` (`pricing_model`) — Ajv resolves the cross-file `$ref` to each `pricing-options/*-option.json` correctly when all schemas are pre-loaded; the deferral was based on a faulty isolated-compile test.
  - `core/format.json` `#/properties/assets/items/oneOf/14/properties/assets/items/oneOf` (`asset_type`) — required `asset_type` on each of the 12 inner variants directly so Ajv's discriminator support can find it without traversing `allOf`.

  The 15-variant outer oneOf at `#/properties/assets/items` is still deferred — it mixes `item_type: "individual"` (14 variants with `asset_type`) and `item_type: "repeatable_group"` (no `asset_type`), so a single discriminator key doesn't cover it without a structural restructure. Tracked separately. Same for the boolean-discriminator unions (`get-adcp-capabilities-response.json` `supported`, `update-content-standards-response.json` `success`) which need an enum migration. Tracking: adcp#3917.

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

- f74aa81: spec(conformance): rejection-arm vs `errors[]` mutual-exclusion test + storyboard alignment

  Closes #3998. The wire-placement guidance on `GOVERNANCE_DENIED` (shipped to `main` via #3929 and to 3.0.x via #3996) is normative MUST-language: when a task response defines a structured rejection arm (`AcquireRightsRejected`, `CreativeRejected`), the arm IS the canonical denial shape — sellers MUST NOT additionally emit the error code in `errors[]` or `adcp_error`. The schema enforces this with `not: { required: ["errors"] }` on each rejection arm.

  Until now the rule was asserted only in prose. This change adds executable conformance:

  - **`tests/rejection-arm-mutual-exclusion.test.cjs`** — schema-validation conformance check that fails before the storyboards do if the `not: { required: ["errors"] }` constraint regresses on either rejection arm. Asserts both directions: canonical rejection-arm shape (status + reason, no errors[]) accepts; rejection-arm with errors[] populated rejects. Wired into the aggregate `npm test` run.
  - **`brand_rights/governance_denied` storyboard** — assertions corrected to the rejection-arm path. Was asserting `check: error_code, value: "GOVERNANCE_DENIED"` on a task whose canonical denial shape is `status: "rejected"` + `reason`. Now asserts `field_value path: "status" value: "rejected"` plus `field_present path: "reason"`. Closes the storyboard portion of #3914 (storyboard was rejecting spec-correct adopter responses).
  - **`media_buy_seller/governance_denied` storyboard** — narrative tightened to make Case-2 of the rule explicit (no rejection arm → `errors[]` + `adcp_error` populated; transport markers flipped). Cross-references the brand-rights scenario as the Case-1 counterpart.

  Wire format unchanged. Schema constraints unchanged. Pure conformance + documentation: the schema rule was already in place; this change makes it discoverable from a failing test and aligns the existing storyboards with the rule.

- 114f244: spec(conventions): reserve `ctx_metadata` as adapter-internal round-trip key

  Reserves the top-level key `ctx_metadata` on AdCP resource objects (Product, MediaBuy, Package, Creative, AudienceSegment, Signal, RightsGrant) as a publisher-to-SDK round-trip cache for adapter-internal state. SDKs MUST strip the key before wire egress and MUST emit a warning-level log entry when stripping, so operators can detect accidental collisions with existing adapter code. Buyers never see this field.

  The convention is non-binding at the wire level — these resources already declare `additionalProperties: true` so existing payloads remain valid. The reservation locks the keyword name before two SDKs converge on it accidentally and ship divergent semantics. PropertyList and CollectionList are out of scope (`additionalProperties: false`) until a follow-up PR widens those schemas.

  Closes #3640.

- 4a98e74: docs(skill): document the four implementation-dependent `issues[]` fields callers may see

  `skills/call-adcp-agent/SKILL.md` already documents the three required `issues[]` fields (`pointer`, `keyword`, `variants`) that every conformant validator surfaces. Adds the four optional fields a calling agent will encounter when the seller's validator opts into them — `discriminator`, `schemaId`, `allowedValues`, `hint` — with a one-line preface clarifying these are implementation-dependent (not every validator emits them) and an updated recovery order: read `hint` first when present, then `discriminator`, then walk `variants`.

  Two new rows added to the symptom-fix lookup table for the same fields.

  No wire-format change. Pure documentation: shipping these fields is already a valid validator extension; this just gives callers a curated path through them.

  Surfaced from the @adcp/sdk side after PR #1283 / #1309 added the fields and PR #1268 / #1361 hit recurring drift between the local SDK skill copy (which already documented them) and the upstream bundle (which didn't). With this merged, the SDK's `npm run sync-schemas` no longer rewrites the file out from under contributors.

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
