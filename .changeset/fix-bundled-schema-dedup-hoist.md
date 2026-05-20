---
"adcontextprotocol": patch
---

Mark `data-provider-signal-selector.json` with `x-adcp-hoist: true` so the schema bundler deduplicates it via root `$defs` instead of inlining it N times.

In 3.1.0-beta.x, the `tasks-get-response.json` `result` field references `async-response-data.json` — a union of all task response schemas. When bundled, shared sub-schemas get inlined once per referencing response schema. The duplicate `data-provider-signal-selector` instances (a discriminated `oneOf` with `selection_type` values `all`, `by_id`, `by_tag`) caused `datamodel-code-generator` to fabricate a `Literal['reuse']` discriminator value, raising `TypeError: Value 'reuse' for discriminator 'selection_type' mapped to multiple choices` and blocking the entire Python SDK from importing.

The bundler already has `hoistMarkedSchemas()` for exactly this case. The `x-adcp-hoist: true` directive is build-time only and is stripped from the emitted bundled schemas — the normative wire contract is unchanged.
