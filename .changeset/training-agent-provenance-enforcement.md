---
---

feat(training-agent): implement provenance enforcement (closes #3777)

Bring the reference training agent up to the spec landed in #3468:

- `handleGetProducts` now overlays `comply_test_controller`-seeded products onto the response so storyboard-seeded `creative_policy.{provenance_required, provenance_requirements, accepted_verifiers}` fields round-trip through `get_products`. Previously only `handleCreateMediaBuy` saw seeded fixtures.
- `backfillProductDefaults` fills in spec-required Product fields (`name`, `description`, `publisher_properties`, `format_ids`, `pricing_options`, `reporting_capabilities` and its required sub-fields) for fixture-seeded products that historically only carried fields `create_media_buy` validation needed. Closes the response-schema gap that surfaced once seeded products began round-tripping through `get_products`.
- `handleSyncCreatives` enforces `creative_policy` from session-seeded products with the structural-rejection family on `error-code.json`:
  - `PROVENANCE_REQUIRED`
  - `PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING`
  - `PROVENANCE_DISCLOSURE_MISSING`
  - `PROVENANCE_EMBEDDED_MISSING`
  - `PROVENANCE_VERIFIER_NOT_ACCEPTED` — buyer-supplied `verify_agent.agent_url` cross-checked against the seller's `accepted_verifiers` allowlist (canonicalized) before any outbound call. Off-list URLs reject without contacting them.
- Per-creative failures emit `action: 'failed'` + per-creative `errors[]` with `field`/`recovery`. The `SyncCreativeResult` interface gains the `failed` action variant and an optional `errors[]` field.
- Truth-of-claim (`PROVENANCE_CLAIM_CONTRADICTED`, requires calling `get_creative_features` against an on-list verifier) is out of scope for this initial implementation — the structural codes are sufficient to make the conformance scenario pass and exercise the wire contract.

Removes `media_buy_seller/provenance_enforcement` from `KNOWN_FAILING_STORYBOARDS` in `server/tests/manual/run-storyboards.ts` (it now passes 5/5 steps in both legacy and framework modes). Bumps `min_clean_storyboards` (53→65) and `min_passing_steps` (388→444 legacy, 401→462 framework) in `.github/workflows/training-agent-storyboards.yml` to reflect the new clean baselines.

Updates the storyboard fixture (`media_buy_seller/provenance_enforcement`) with a unique product name/description so brief-mode scoring places it at `products[0]`, and switches per-creative error assertions to `field_value` paths since the spec sync_creatives shape carries failures per-item, not at the top-level errors envelope.

Refs: #3468, #3777.
