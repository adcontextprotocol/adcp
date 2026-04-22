---
---

Add a storyboard lint that validates every step's `sample_request` against its declared `schema_ref`. Closes the structural gap surfaced by adcp#2763 — specialism fixtures could drift from their schemas (and from parallel protocol fixtures) because nothing statically validated payloads against the schemas they named.

The lint strips runtime substitutions (`$context.*`, `$generate:*`, `$test_kit.*`) into schema-typed placeholders before ajv validation, and skips negative-test steps that assert error codes. Ships with a known-issues allowlist that grandfathers 46 pre-existing drift steps so the lint can block new drift today; follow-up PRs will remove entries as they fix the underlying fixtures. Regenerate the allowlist with `node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist` after a real fix — never hand-edit to silence a new violation.
