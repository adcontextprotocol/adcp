---
"adcontextprotocol": minor
---

spec(manifest): publish `manifest.json` + structured `enumMetadata` to stop SDK drift (adcp#3725)

Adds two additive artifacts to every released schema bundle:

1. **`enums/error-code.json` gains an `enumMetadata` block.** Every error code now carries structured `recovery` (correctable | transient | terminal) and `suggestion` fields. SDKs MUST consume this block instead of parsing `Recovery: X` prose out of `enumDescriptions`. A build-time lint rejects any drift between the structured value and the prose. Root cause for adcp-client#1135 (17 missing codes, 3 wrong recovery classifications shipped in TS SDK for over a year).
2. **`manifest.json` at `/schemas/{version}/manifest.json` (and `/schemas/latest/manifest.json` for nightly codegen).** Single canonical artifact listing every tool (with `protocol`, `mutating`, `request_schema`, `response_schema`, `async_response_schemas`, `specialisms`), every error code (with `recovery`, `description`, `suggestion`), an `error_code_policy` block (defining `default_unknown_recovery` so SDKs handle non-spec codes from non-conforming sellers correctly), and every storyboard specialism (with `protocol`, `entry_point_tools`, `exercised_tools`). Validates against `/schemas/{version}/manifest.schema.json`. Generated deterministically from existing source — no new authored content. Lets SDKs derive their internal tool/error tables from one place at codegen time instead of hand-transcribing the spec.

`mutating` is derived using the same classifier the idempotency-key lint enforces (single source of truth — manifest and lint can never disagree). The read-only verb pattern was tightened in the process: it now anchors at the start so tools like `create-collection-list` and `delete-property-list` are no longer mis-classified as read-only because they happen to contain `-list-` mid-name. `search-` was added as a read-only verb.

Specialisms expose two distinct tool sets per #3725 review feedback: `entry_point_tools` (the curated minimal contract from `index.yaml.required_tools` — what the spec asserts implementers MUST ship) and `exercised_tools` (the full surface — union of own phases and every linked scenario, derived by walking `phases[].steps[].task` and resolving `requires_scenarios`). SDK authors should size their tool registration against `exercised_tools` to ensure they handle every call the conformance kit will make.

Migration: SDKs targeting 3.0.x continue to work unchanged — `enumDescriptions` and the existing `index.json` are retained verbatim. SDKs targeting 3.1+ should switch to `enumMetadata` for error recovery and `manifest.json` for tool/specialism enumeration. The prose "Recovery: X" sentence embedded in each `enumDescriptions` value is stripped from the manifest's per-code `description` to avoid double-encoding; it remains in `enumDescriptions` for the human-readable narrative until a future minor formally deprecates it. Until then, the lint guarantees both surfaces stay synchronized.
