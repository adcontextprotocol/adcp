---
"adcontextprotocol": patch
---

Add `discriminator: { propertyName }` to 17 `oneOf` unions in `static/schemas/source/` whose variants already declare the same required property as a `const` with distinct string values.

Affected schemas: `adagents.json`, `compliance/comply-test-controller-response.json`, `content-standards/artifact.json`, `core/activation-key.json`, `core/creative-item.json`, `core/deployment.json`, `core/destination.json`, `core/optimization-goal.json` (3 unions), `core/requirements/catalog-field-binding.json` (2 unions), `core/signal-pricing.json`, `creative/preview-creative-response.json`, `creative/preview-render.json`.

Non-breaking: the OpenAPI `discriminator` keyword is ignored by JSON Schema 2020-12 validators that don't recognize it; the existing `const`-property pattern remains the source of truth. Codegen targets that respect the keyword (msgspec, openapi-typescript, datamodel-code-generator) now emit a properly-narrowed union without per-variant casts. Tracking: adcp#3917.
