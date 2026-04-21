---
---

feat(docs+compliance): implementer DX — troubleshooting guide, known-ambiguities doc, idempotency probe fix (#2607, #2608)

Adds two implementer-facing docs pages and an opt-out on the idempotency missing-key vector.

`universal/idempotency.yaml` — the `create_media_buy_missing_key` step now declares `omit_idempotency_key: true`, which tells the runner to skip both its own `applyIdempotencyInvariant` and the SDK's auto-inject. Without the flag the reference `@adcp/client` SDK injects an `idempotency_key` before dispatch and the vector never probes the missing-key rejection path. The SDK already supports this opt-out (`Step.omit_idempotency_key`, wired through `skipIdempotencyAutoInject` in `task-map.js`); the missing piece was the storyboard declaration. `storyboard-schema.yaml` documents the field alongside the other step-level directives.

`docs/building/implementation/storyboard-troubleshooting.mdx` — error pattern → root cause → fix reference. Sections cover unknown fixtures, RFC 9421 signature challenges, `errors[]` vs `adcp_error` envelope drift, context echo failures, capability-vector mismatches, `requireAuthenticatedOrSigned` composition, and `INVALID_STATE` vs `INVALID_TRANSITION` vocabulary.

`docs/building/implementation/known-ambiguities.mdx` — open spec gaps with workarounds. Entries are removed as underlying issues close (#2389 past_start already closed; #2603/#2604/#2606/#2607 pending). Both pages cross-linked from `validate-your-agent.mdx` under a new "When a storyboard fails" section.

docs.json nav registration covers both Implementation Patterns groups (duplicate arrays exist; both were updated).
