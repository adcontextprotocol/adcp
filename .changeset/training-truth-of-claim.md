---
---

feat(training-agent): truth-of-claim verifier — closes #3802

Completes the provenance enforcement work landed in #3792. Adds the seller-side truth-of-claim verifier that calls `get_creative_features` against the seller's `accepted_verifiers` allowlist, reconciles the result against the buyer's `digital_source_type` claim, and emits `PROVENANCE_CLAIM_CONTRADICTED` with audit-safe `error.details` when the verifier refutes the claim.

`server/src/training-agent/task-handlers.ts`:
- `handleGetCreativeFeatures` — governance-agent-shaped handler returning deterministic AI-detection results. Detection encoded in the creative manifest's asset URL pattern (substring `ai-generated-true` / `ai_gen_true` → `ai_generated: true`; `ai-generated-false` / `ai_gen_false` → `false`). When neither URL pattern matches, derives from buyer-claimed `digital_source_type` via the canonical AI_TRUE_DST set. Storyboards drive contradiction outcomes from the fixture without per-test stateful bookkeeping.
- `runProvenanceVerifier` — in-process verifier-call helper invoked by `enforceProvenancePolicy` after the structural-rejection cascade. Selects buyer-nominated verifier when on-list, falls back to first on-list entry (with `substituted_for` audit trail). Threshold: `ai_generated=true` with confidence ≥ 0.9 against a non-AI claim → contradiction.
- `enforceProvenancePolicy` is now async; emits `PROVENANCE_CLAIM_CONTRADICTED` with `error.details` constrained to the `error-code.json` allowlist: `{ agent_url, feature_id, claimed_value, observed_value, confidence, substituted_for? }`.

`v6-sales-platform.ts` / `v6-creative-platform.ts`:
- Thread `ctx.account.ctx_metadata.brand_domain` through the `syncCreatives` shim. Without this fix, the v6→v5 shim landed in #3713 was stripping brand from the args, causing `sessionKeyFromArgs` to route to `open:default` while seeded `creative_policy` lived on `open:<brand>`. Result: `aggregateCreativePolicy` returned null and the entire enforcement cascade silently no-opped. Fix restores conformance for `media_buy_seller/provenance_enforcement` (which had been silently passing post-#3713 because no rejection was firing) and unblocks the new `media_buy_seller/provenance_truth_of_claim`.

`static/compliance/source/protocols/media-buy/scenarios/provenance_truth_of_claim.yaml`:
- Fleshed out from skeleton to full 3-phase scenario: discover_verifier → reject_contradicted_claim (asset URL `ai-generated-true.jpg` triggers verifier verdict that contradicts `digital_capture` claim → `PROVENANCE_CLAIM_CONTRADICTED` with audit-safe details) → accept_consistent_claim (asset URL `ai-generated-false.jpg` confirms claim → accepted).

Removed from `KNOWN_FAILING_STORYBOARDS` in `server/tests/manual/run-storyboards.ts`.

Local conformance on `/creative` tenant:
- `media_buy_seller/provenance_enforcement` ✓ 6P / 1S / 0N/A
- `media_buy_seller/provenance_truth_of_claim` ✓ 3P / 1S / 0N/A

Refs: #3468, #3777, #3792, #3713.
