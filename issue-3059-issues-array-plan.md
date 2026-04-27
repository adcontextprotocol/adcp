# Issue 3059: normalize `adcp_error.issues[]` into `core/error.json`

## Confirmed interpretation

Yes: the issue's core claim is supported by the current repo state.

- The authoritative schema source at `static/schemas/source/core/error.json` does **not** currently define a top-level `issues` field.
- The released copy at `dist/schemas/3.0.0/core/error.json` also does **not** define it.
- Buyer-facing protocol docs already instruct buyers to read top-level `adcp_error.issues[]`, including `issues[].pointer`, `issues[].keyword`, and `issues[].variants[]`.
- Agent skill docs also already teach the same recovery flow from `adcp_error.issues[]`.

That means `issues[]` is already acting as a de facto extension in the ecosystem and in this repo's agent guidance, while the normative schema still omits it. Normalizing it into `core/error.json` is the right shape of change if the goal is to align the spec with current buyer behavior before implementations diverge.

## Important nuance

The repo does **not** show this as an already-normalized schema field. What exists today is:

- normative omission in the source schema
- buyer guidance that already depends on the field
- an open triage thread on issue #3059 that explicitly leaves several details unresolved

So the implementation should be treated as a spec/schema alignment change, not a no-op codification.

## Evidence checked

- `static/schemas/source/core/error.json`
- `dist/schemas/3.0.0/core/error.json`
- `docs/protocol/calling-an-agent.mdx`
- `skills/call-adcp-agent/SKILL.md`
- `docs/building/implementation/security.mdx`
- `static/schemas/source/enums/error-code.json`

## Proposed implementation plan

### 1. Resolve the blocking spec decisions first

The key design choices are now resolved.

- `issues[].pointer` should use RFC 6901 JSON Pointer.
- `issues[].keyword` should be optional so non-Ajv implementations do not need placeholder values.
- Top-level `issues` should be available for all error codes, with an empty array allowed when structured issues do not apply to a particular case.
- `schemaPath` may be included in the schema, but production guidance should say sellers `SHOULD NOT` populate it in production.

### 2. Update the authoritative schema source

Edit `static/schemas/source/core/error.json` to add a normative top-level `issues` property.

Expected shape, subject to triage:

- `issues`: array
- item fields:
  - `pointer` (RFC 6901 JSON Pointer)
  - `message`
  - `keyword` (optional)
  - `schemaPath` (optional, with guidance that production systems SHOULD NOT populate it)
  - `variants` if the repo wants the currently documented `oneOf`/`anyOf` recovery helper to be schema-recognized rather than just implementation-specific

Related schema text to update at the same time:

- `field` description, because it should reflect the first error found for now and be positioned as a compatibility field that may later be deprecated in favor of `issues`
- `details` description only if needed to clarify that top-level `issues` is the normalized location and `details.issues` is not part of the recommended contract

### 3. Decide whether `variants[]` is part of the normalized contract

This repo's docs and skills already teach `issues[].variants[]` as the recovery mechanism for `oneOf`/`anyOf` failures, but issue #3059's text as fetched emphasizes `pointer`, `message`, `keyword`, and `schemaPath`.

Decision:

- Standardize only `issues[]` with core validation metadata and leave `variants[]` as an implementation-specific extension.

Buyer docs and skills should keep mentioning `variants[]` as an optional extension hint, but should not present it as a normative cross-implementation contract.

### 4. Align docs and agent skills with the final schema contract

After the schema decision is locked, update at least:

- `docs/protocol/calling-an-agent.mdx`
- `skills/call-adcp-agent/SKILL.md`

Likely edits:

- pointer encoding wording
- that `issues` is available across error codes and may be empty when not applicable
- whether `keyword` is guaranteed vs optional
- that `schemaPath` exists but SHOULD NOT be populated in production
- that `variants[]` remains documented as an implementation-specific extension rather than normative
- compatibility wording around `field`, including its current role as the first error found and likely future deprecation in favor of `issues`

### 5. Add or update security guidance

If `schemaPath` remains in the schema, add normative language in the docs to avoid schema-shape fingerprinting leakage, state that production systems SHOULD NOT populate it, and cross-reference the existing security discussion in `docs/building/implementation/security.mdx`.

Because `issues[].pointer` will use RFC 6901 while `field` remains a compatibility field, the docs should avoid telling implementers to copy one into the other literally.

### 6. Regenerate derived artifacts

After source-schema edits:

- run `npm run build:schemas`

This should refresh generated outputs under `dist/schemas/` and any bundled schema artifacts that inline `core/error.json`.

### 7. Run focused validation

Add or update tests explicitly, not just validation commands.

Minimum test work after the change:

- update any existing schema or error-envelope tests that currently assert the old shape
- add a regression test that accepts top-level `issues` with RFC 6901 `pointer`, optional `keyword`, optional `schemaPath`, and an empty `issues` array
- add a backward-compatibility test that keeps `field` populated with the first error found while `issues` is present
- add an extensibility test that confirms additional non-normative fields on issue objects do not break validation or brittle exact-shape assertions
- add or update docs/example validation so buyer-facing examples using `issues[]` are checked against the updated schema contract

Minimum command validation after the change:

- `npm run build:schemas`
- `npm run test:error-codes`

Then run the narrowest additional checks affected by the doc/spec changes:

- the schema/example tests that rely on `/schemas/core/error.json`
- any docs or unit tests that assert the buyer-facing error envelope shape
- the new backward-compatibility and extensibility tests added for `issues[]`

## Recommended execution order

1. Update `static/schemas/source/core/error.json` with top-level `issues`, RFC 6901 `pointer`, optional `keyword`, optional `schemaPath`, and wording that allows empty `issues` arrays when structured issues do not apply.
2. Update the `field` description so it reflects the first error found for now and clearly signals planned deprecation in favor of `issues`.
3. Update buyer docs and skill docs to match the chosen contract.
4. Add the production guidance for `schemaPath` and cross-reference the existing security notes.
5. Add or update tests for the new schema shape, backward compatibility of `field`, and extensibility for additional non-normative issue fields.
6. Regenerate `dist/schemas/*`.
7. Run focused validation.
8. If this becomes a PR, add a changeset that matches whether the repo treats this as a protocol spec change.

## Resolved decisions

1. `issues[].pointer` uses RFC 6901 JSON Pointer.
2. `issues[].keyword` is optional.
3. Top-level `issues` is available across all error codes, with an empty array allowed when structured issues do not apply.
4. `schemaPath` is allowed in the schema, but production guidance should say sellers SHOULD NOT populate it.
5. Top-level `issues` is the intended normalized location; `details.issues` mirroring is not part of the recommended contract.
6. `issues[].variants[]` is not standardized and remains implementation-specific.
7. `field` should reflect the first error found for now, with eventual deprecation in favor of `issues`.
8. Test coverage should explicitly preserve backward compatibility and extensibility, including allowing additional non-normative issue fields without brittle failures.

## Working hypothesis for implementation

If the answers above converge, this looks like a straightforward source-schema change plus buyer-doc alignment, with the main risk being accidental documentation/spec drift if the repo keeps documenting richer recovery fields than the schema actually standardizes.