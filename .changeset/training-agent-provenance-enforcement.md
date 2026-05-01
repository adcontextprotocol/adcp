---
---

feat(training-agent): implement provenance enforcement for creative_policy (#3777)

Implements `creative_policy.{provenance_required, provenance_requirements, accepted_verifiers}`
enforcement in the training agent so the `creative_sales_agent/provenance_enforcement`
conformance storyboard passes.

**`handleGetProducts`:** seeded products (from `comply_test_controller seed_product`) are
now included in responses via `overlaySeededProducts`. Seeded products that score zero on
brief-mode keyword matching are prepended to the result so storyboard field-value checks
can inspect their `creative_policy` fields.

**`handleSyncCreatives`:** structural enforcement derived from seeded products'
`creative_policy` runs before persisting each creative:
1. Verifier allowlist check (PROVENANCE_VERIFIER_NOT_ACCEPTED) — fires first per spec
   "cross-check before any outbound call" requirement
2. PROVENANCE_REQUIRED — no provenance object when `provenance_required: true`
3. Field-level checks with short-circuit: PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING,
   PROVENANCE_DISCLOSURE_MISSING, PROVENANCE_EMBEDDED_MISSING

Per-creative failures use `action: 'failed'` with `errors[]` (already in sync-creatives-response.json
schema); the creative is not persisted to session state.

Removes `creative_sales_agent/provenance_enforcement` from `KNOWN_FAILING_STORYBOARDS`.

Note: `sync_creatives` has no `product_id` field, so per-product enforcement is not possible.
The implementation uses union semantics across all seeded products' verifier allowlists — a
known training-agent simplification documented in a code comment. In single-product storyboards
(the typical case) union === intersection.

Note: `.github/workflows/training-agent-storyboards.yml` thresholds (`min_clean_storyboards`,
`min_passing_steps`) need a human bump — the routine cannot edit `.github/**`.

Closes #3777.
