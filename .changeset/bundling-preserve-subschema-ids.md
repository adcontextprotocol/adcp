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

**Pipeline change** (`scripts/build-schemas.cjs`), four passes added or extended:

- `resolveRefs` no longer destructures `$id` away when merging an inlined ref into its parent. `$schema` is still dropped (only meaningful at document root). When a parent declares its own `$id` alongside `$ref` (the deprecated-alias pattern, e.g. `signal-pricing-option.json` aliasing `vendor-pricing-option.json`), the parent's `$id` wins so the alias's identity is preserved.
- `versionInlineSchemaIds` post-pass rewrites every inner `$id` from source form (`/schemas/core/foo.json`) to the versioned flat-tree URI (`/schemas/{version}/core/foo.json`). Idempotent on already-versioned `$id`s; leaves external/relative `$id`s alone.
- `stripIdsFromSubtreesWithLocalRefs` post-pass deletes `$id` from any subtree whose descendants carry a local `$ref` (`#/...`). The hoist passes (`hoistNestedDefsToRoot`, `hoistDuplicateInlineEnums`) move shared definitions to root `$defs` and rewrite call-sites to `{$ref: "#/$defs/Foo"}` — those fragment refs resolve against the *nearest enclosing `$id`*, so preserving `$id` on a subtree containing them changes the resolution scope and Ajv reports `"can't resolve reference #/$defs/Foo from id <inlined-$id>"`. Stripping the conflicting `$id` yields the document-root scope the local refs need; subtrees free of local refs (e.g. `version-envelope`, `activation-key`) keep their `$id`.
- `dedupBundledSchemaIds` post-pass is first-wins on identical `$id` values within one document. Same source schema referenced from multiple co-locations (e.g. `version-envelope` in an `allOf`) produces multiple inlined subtrees; Ajv refuses to compile a schema with duplicate `$id`s even in non-strict mode. First-wins anchors the schema's identity at the first occurrence; subsequent occurrences fall back to the nearest enclosing `$id`-bearing ancestor when SDK error reporting walks up.

**What survives.** 1532 sub-`$id`s across the 81 bundled schemas (avg ~19 per file) — every bundled tool gains deep-`$id` surface area. Notable preserved cases: `version-envelope`, `activation-key`, `account-ref`, `brand-ref`, `context`, `ext`, plus most asset / asset-requirement sub-schemas. Stripped cases: any sub-schema whose subtree gets dedup'd-enum hoists rewritten into it (e.g. `delivery-metrics`, `targeting`, `format`, `catalog`, `pricing-options/price-breakdown`).

**Tests** in `tests/build-schemas-preserve-subschema-ids.test.cjs` (12 cases): alias-wins, sibling-key precedence, version-stamping post-pass + idempotency + external-`$id` passthrough + array-recursion `isRoot`, strip-on-local-ref + leave-on-absolute-ref, dedup first-wins, root-shadow protection.

**Compatibility.** No wire-format change. No new validation behavior on any code path. Bundled artifact compiles cleanly under Ajv 8 (`strict: false` recommended for the same reasons it always was — `additionalProperties: true` etc. — but no longer required for duplicate-`$id` reasons specifically). The bytes that change in the published `bundled/` artifact are metadata-only `$id` keywords on subtrees.
