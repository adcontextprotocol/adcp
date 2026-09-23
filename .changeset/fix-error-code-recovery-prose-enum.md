---
"adcontextprotocol": patch
---

Correct three `enums/error-code.json` prose recovery tags that named a value outside the closed `recovery` enum. `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE`, `PIXEL_TRACKER_LOSSY_DOWNGRADE` and `PIXEL_TRACKER_UPGRADE_INFERRED` ended their `enumDescriptions` with `Recovery: warning`, but `core/error.json` closes `recovery` to `transient` / `correctable` / `terminal`, and all three carry `correctable` in `enumMetadata` — which the block's own `$comment` makes the normative authority the prose MUST match. Prose now reads `Recovery: correctable — non-fatal advisory, do not auto-retry`, preserving the non-fatal semantics without inventing an enum member. Extends `tests/error-recovery-vectors.test.cjs` to hold `error-code.json` to the same prose/metadata agreement already asserted for `request-signing-error-code.json`. No schema shape or wire-behaviour change.
