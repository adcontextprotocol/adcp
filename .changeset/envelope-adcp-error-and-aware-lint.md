---
"adcontextprotocol": minor
---

spec(envelope): add `adcp_error` to `protocol-envelope.json` + envelope-aware lint resolution

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
