---
---

fix(schemas): make the `publisher_domain` vs `publisher_domains[]` split on `publisher-property-selector.json` a structural discriminator instead of an `allOf` + `not` XOR constraint.

**Why.** PR #4504 introduced the compact `publisher_domains[]` fanout form and enforced the XOR via `allOf: [ { not: { required: ["publisher_domain", "publisher_domains"] } }, { anyOf: [ { required: ["publisher_domain"] }, { required: ["publisher_domains"] } ] } ]` inside the `all` and `by_tag` selection_type branches. Ajv validates this correctly at runtime, but downstream TypeScript codegen (`json-schema-to-typescript`, used by `@adcp/client`) does not model constraint-based XOR — the generated type flattens to `{ publisher_domain?: string; publisher_domains?: string[]; … }` (losing the XOR entirely, compiles with both / neither present) or emits numbered duplicates when the same sub-shape gets re-referenced (the `PublisherPropertySelector1` pattern this SDK has already hit). Either way, adopters lose the type-safety the `selection_type` discriminated union otherwise gives them. Issue #4624.

**What changes.** The selector is now a top-level `oneOf` of two structurally distinct shapes:

- **Single-publisher selector** — `required: ["publisher_domain", "selection_type"]`, inner `discriminator: { propertyName: "selection_type" }` with `oneOf` over `all` / `by_id` / `by_tag`.
- **Fanout selector** — `required: ["publisher_domains", "selection_type"]`, inner `discriminator: { propertyName: "selection_type" }` with `oneOf` over `all` / `by_tag`. `by_id` is structurally absent (property IDs are publisher-scoped; fanning a fixed ID set across publishers would silently authorize wrong inventory).

XOR is now enforced by structure: a payload with both `publisher_domain` and `publisher_domains` matches both branches of the outer `oneOf` and fails; a payload with neither matches no branch and fails. The `allOf`/`not`/`anyOf` clauses are removed.

**Validation-equivalent.** Every payload that was valid under the prior shape is still valid; every payload that was invalid is still invalid. Confirmed against a smoke matrix of 14 cases (3 single variants × valid, 2 fanout variants × valid, 9 invalid cases including fanout `by_id`, both fields present, neither field present, missing required arrays, empty / duplicate `publisher_domains`). No adopter migration required.

**Codegen wins.** TS, Python, and Go SDK generators now produce a clean `PublisherPropertySelector = SinglePublisherSelector | FanoutSelector` union, each itself a discriminated union on `selection_type`. The "`by_id` is single-only" rule becomes structural rather than prose-in-description. `additionalProperties: true` is preserved on each branch — extensions still ride along.

**Caveat for OpenAPI-discriminator-aware tooling.** The outer Single-vs-Fanout split discriminates on *which publisher field is present* (`publisher_domain` vs `publisher_domains`), not on a single shared property value. TS narrowing handles this cleanly (`'publisher_domain' in x`); the inner `selection_type` discriminator still works on each subtype. Tools that dispatch only on a named-property `discriminator` (Swagger UI, some Pydantic codegens) will treat the outer level as a structural union rather than a property-keyed one. `scripts/audit-oneof.mjs` classifies it as `narrowable` — baseline updated to reflect the new entry.

**Best landed pre-version-cut.** The compact form currently ships only on `/schemas/latest/`; no tagged release pins the old shape yet. Doing this as a patch is cheaper than retrofitting later.

Files changed: `static/schemas/source/core/publisher-property-selector.json`, `scripts/oneof-discriminators.baseline.json`.

Closes #4624.
