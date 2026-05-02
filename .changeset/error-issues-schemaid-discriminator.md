---
"adcontextprotocol": minor
---

spec(error): canonicalize `schema_id` + `discriminator` on `core/error.json#issues[]`; unify the validator-internals production-emit stance with carve-outs

Closes #3867. Adds two optional fields to every `issues[]` item on the standard error envelope and harmonizes production-emit guidance across the three validator-internals fields (`schemaPath`, `schema_id`, `discriminator`) — including normative carve-outs for cases where the public-spec replay rationale doesn't apply.

**Why minor**: pure additive optional fields on a published schema. Existing senders/receivers stay conformant — both fields ride the wire today through `additionalProperties: true` via `@adcp/sdk`'s TypeScript client (adcp-client#1307), which is what motivated canonicalization. Cross-SDK consumers (Python, Go) couldn't rely on the field names without a spec entry.

**`schema_id`** — the `$id` of the rejecting (sub-)schema. For tools served from the flat tree (modular, with `$ref`s preserved), this lands on the deepest published sub-schema (e.g. `/schemas/3.1.0/core/activation-key.json`) so the adopter can navigate directly to the failing variant. For tools served from the bundled tree, `$id` preservation during bundling (companion change in `scripts/build-schemas.cjs`, also closing #3868) lets `schema_id` reach the same deep sub-schema; consumers reading bundles produced before that fix see the response-root `$id` instead, which still names a valid published schema. Snake_case to match the rest of the error envelope (`retry_after`, etc.); the older `schemaPath` (camelCase) is retained for 3.0.x backward compatibility and renamed to `schema_path` in a future major.

**`discriminator`** — array of `{property_name, value}` pairs identifying the const-discriminated variant the validator selected from values present in the payload. The inner field is named `property_name` (not `field`) to avoid collision with the top-level `error.field` (JSONPath-lite pointer to the offending payload location), and to align directly with OpenAPI 3.x `discriminator.propertyName`. Compound discriminators (e.g. `audience-selector`'s `(type, value_type)`) produce multiple entries; entry order MUST follow declaration order in the rejecting schema's `properties` block.

The discriminator semantics are tightened to avoid leaking validator implementation details:

- Sellers MUST populate only when the rejecting schema is a const-discriminated `oneOf` / `anyOf` AND the discriminator property is present in the payload — emission on partial-match inference would fingerprint the seller's validator (Ajv vs Python `jsonschema` vs `gojsonschema` diverge on tie-breaking).
- Sellers MUST omit `discriminator` when zero variants survive validation; omission is the agent's signal that the validator could not localize a target variant.
- The wire field reports the value the caller sent — not a validator inference — so it is deterministic across implementations.

**Validator-internals production-emit stance.** The earlier prose on `schemaPath` (`SHOULD NOT emit on production-facing endpoints — leaks which oneOf branch the validator selected, a probe oracle for adversarial callers`) is incompatible with shipping `discriminator` and `schema_id`, both of which expose the same "validator's chosen variant" surface. The resolution: the public-spec rationale wins **with explicit carve-outs**, replacing the blanket SHOULD-NOT.

The base rationale: schemas are published at adcontextprotocol.org and bundled with every SDK, so when the rejecting element is in the public spec, an adversary can replay the same validator locally against the same payload and derive branch selection from the payload alone — the wire field carries no information the adversary can't compute.

The carve-outs (normatively documented in `error-handling.mdx`):

- **Private extensions.** Sellers running schemas with custom `oneOf` branches, server-only sub-schemas, or enum subsets layered via `additionalProperties: true` MUST NOT emit `schema_id`, `schemaPath`, or `discriminator` when the rejecting element is not in the published spec. Replay-locally is structurally inapplicable.
- **Version skew.** Sellers validating against a pre-release or post-release schema MUST NOT emit a `schema_id` whose `$id` is not in the published bundle for the version named in `get_adcp_capabilities`.
- **Custom keywords.** `keyword` MUST be drawn from the JSON Schema Draft 7 / 2020-12 vocabulary; validator-specific custom keywords MUST NOT be emitted on the wire.
- **Probe terseness.** Sellers MAY scope all three fields to dev/sandbox responses on rate-limited production endpoints to keep envelopes terse, even when the carve-outs above don't apply. Field omission is always conformant.

Updates:

- `static/schemas/source/core/error.json` — adds `schema_id` (string) and `discriminator` (array of `{property_name, value}`) properties under `issues.items.properties`; rewrites the `schemaPath` description to drop the SHOULD-NOT framing and point at the unified production-emit stance.
- `docs/building/implementation/error-handling.mdx` — adds a `Validator-internals fields on issues` subsection covering field semantics, `schema_id` resolution path (HTTPS canonical / SDK-bundled / bundled-tree caveat / validator strict-mode requirement), discriminator semantics, and the four carve-outs.

**Open question carried in the PR description, not blocked on this changeset**: should `discriminator` be an object map (`{type: "audience", value_type: "ids"}`) instead of an array of pairs? The array shape matches what `@adcp/sdk` already emits and what #3867 proposes; the object map is more ergonomic for compound-discriminator consumers (`if (d.type === "audience")` vs `.find(d => d.property_name === "type")`). Resolved as array for v3.1; revisit before v4.
