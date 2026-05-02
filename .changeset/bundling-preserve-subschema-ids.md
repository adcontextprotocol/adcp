---
"adcontextprotocol": patch
---

spec(bundling): preserve sub-schema `$id`s when inlining `$ref`s into the bundled tree

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

**Pipeline change** (`scripts/build-schemas.cjs`):

- `resolveRefs` no longer destructures `$id` away when merging an inlined ref into its parent. `$schema` is still dropped (only meaningful at document root). When a parent declares its own `$id` alongside `$ref` (the deprecated-alias pattern, e.g. `signal-pricing-option.json` aliasing `vendor-pricing-option.json`), the parent's `$id` wins so the alias's identity is preserved.
- A new `versionInlineSchemaIds` post-pass walks the bundled tree and rewrites every inner `$id` from the source form (`/schemas/core/foo.json`) to the versioned flat-tree URI (`/schemas/{version}/core/foo.json`). The root `$id` is left to the existing bundled-prefix rewrite. Idempotent on already-versioned `$id`s, and leaves external/relative `$id`s alone.
- New tests in `tests/build-schemas-preserve-subschema-ids.test.cjs` cover the alias-wins case, sibling-key precedence, the version-stamping post-pass, idempotency, and the array-recursion `isRoot` propagation.

**Compatibility — non-strict-mode requirement.** Same sub-schema referenced from multiple co-locations produces multiple inline `$id`s with the same value within one document. JSON Schema draft-07 permits this; Ajv 8 in non-strict mode (the published-bundle consumption pattern) treats them as describing the same schema. The SDK consumer guidance is normatively documented in `docs/building/implementation/error-handling.mdx#validator-internals-fields-on-issues`:

- Ajv: `new Ajv({ strict: false })`
- `santhosh-tekuri/jsonschema` (Go): disable strict-mode duplicate-`$id` checks
- Python `jsonschema`: last-`$id`-wins is the default — no change required

Without this configuration, bundled-tree validation will throw a duplicate-`$id` error at compile time. The flat tree (under `/schemas/{version}/...` without the `bundled/` prefix) does not have this constraint — `$ref`s remain as references, no inlining, no duplicates.

No wire-format change. No new validation behavior on any code path. The bytes that change in the published `bundled/` artifact are metadata-only `$id` keywords on subtrees (3618 sub-`$id`s across the 81 bundled schemas).
