---
---

feat(training-agent): implement provenance enforcement (closes #3777)

Brings the reference training agent up to the spec landed in #3468, with the cleanup work surfaced in expert review.

**`handleGetProducts`** now overlays `comply_test_controller`-seeded products onto the response so storyboard-seeded `creative_policy.{provenance_required, provenance_requirements, accepted_verifiers}` fields round-trip through `get_products`. Previously only `handleCreateMediaBuy` saw seeded fixtures. Both code paths now go through `overlaySeededProducts`, so the backfill is applied symmetrically; restricted to seeded-product IDs only so the cached catalog singleton stays untouched.

**`backfillTrainingProductDefaults`** fills in spec-required Product fields (`name`, `description`, `publisher_properties`, `format_ids`, `pricing_options`, `reporting_capabilities` and its required sub-fields) for fixture-seeded products that historically only carried fields `create_media_buy` validation needed.

**`handleSyncCreatives`** enforces `creative_policy` from session-seeded products with the structural-rejection family on `error-code.json`:

- `PROVENANCE_REQUIRED`
- `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING`
- `PROVENANCE_DISCLOSURE_MISSING`
- `PROVENANCE_EMBEDDED_MISSING`
- `PROVENANCE_VERIFIER_NOT_ACCEPTED` — buyer-supplied `verify_agent.agent_url` cross-checked (canonicalized) against the seller's `accepted_verifiers` allowlist before any outbound call. Off-list URLs reject without the seller contacting them, closing the buyer-controlled-URL trust gap from #3468.

Per-creative failures emit `action: 'failed'` + per-creative `errors[]` with `field` and `recovery: 'correctable'`. The `SyncCreativeResult` interface gains the `failed` action variant and an optional `errors[]` field. Buyer-controlled strings (`verify_agent.agent_url`, `creative_id`) are sanitized (C0/C1 strip + length cap) before interpolation into `TaskError.message` and `error.field` to defend against log/transcript poisoning.

The cascade is stable and documented on `enforceProvenancePolicy`: `PROVENANCE_REQUIRED` → `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING` → `PROVENANCE_DISCLOSURE_MISSING` → `PROVENANCE_EMBEDDED_MISSING` → `PROVENANCE_VERIFIER_NOT_ACCEPTED`. `aggregateCreativePolicy` documents the deliberate asymmetry: requirement booleans are intersected (most-restrictive wins, gates compose), `accepted_verifiers` are unioned (allowlist semantics).

Truth-of-claim (`PROVENANCE_CLAIM_CONTRADICTED`, requires calling `get_creative_features` against an on-list verifier) is out of scope for this initial implementation — the structural codes are sufficient to exercise the wire contract end to end. Tracked at #3802 with a skeleton storyboard at `media_buy_seller/provenance_truth_of_claim` registered in `KNOWN_FAILING_STORYBOARDS`.

**Conformance:** new compliance scenario at `static/compliance/source/protocols/media-buy/scenarios/provenance_enforcement.yaml` walks the structural-rejection contract end to end across six phases: discover requirement → reject no-provenance → reject missing digital_source_type → reject off-list verifier → reject missing disclosure → accept corrected resubmission. Storyboard ID `media_buy_seller/provenance_enforcement` (the `creative_sales_agent` storyboard category was retired as part of this PR — see commit history; `creative-reception.yaml` moved to `media_buy_seller/creative_reception` scenario, also non-breaking since `creative_sales_agent` was never in the protocol's specialism enum).

Removes `media_buy_seller/provenance_enforcement` from `KNOWN_FAILING_STORYBOARDS` (the entry was added when the spec landed in #3468 ahead of the reference implementation; this PR closes that gap). Bumps `min_clean_storyboards` 53→65 and `min_passing_steps` 388→446 (legacy) / 401→464 (framework) in `.github/workflows/training-agent-storyboards.yml`. The pre-existing 53/388/401 floors had drifted below the actual `origin/main` baseline of 64/439/457; the real lift from this PR is +1 storyboard / +7 steps from the new six-phase scenario.

**Follow-ups:** #3802 tracks `PROVENANCE_CLAIM_CONTRADICTED` truth-of-claim; #3803 tracks storyboard-conformance test-infra (required-clean allowlist, `errors[*]` predicate, pre-push hook); #3823 tracks the broader specialism-taxonomy consolidation (deprecate `sales-proposal-mode` into `sales-guaranteed`, drop phantom storyboard-schema enum entries, per-spec-version source trees before 3.1 GA).

Refs: #3468, #3777, #3792.
