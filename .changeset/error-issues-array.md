---
"adcontextprotocol": patch
---

spec(error): standardize VALIDATION_ERROR `issues[]` as a normative field on `core/error.json`

Closes #3059. Adds an optional top-level `issues` array to the standard error envelope, normalizing what `@adcp/client` (and prospectively `adcp-go` / `adcp-client-python` / hand-rolled sellers) already need for multi-field validation rejections.

**Why minor**: new optional field on a published schema (`core/error.json`). Existing senders/receivers stay conformant — the field is additive. Receivers that ignore unknown fields keep working; receivers that look for it gain a richer pointer map without parsing `message` text.

**Shape**: each entry is `{ pointer (RFC 6901), message, keyword, schemaPath? }`. `schemaPath` MAY be omitted in production to avoid fingerprinting `oneOf` branch selection on adversarial payloads.

**Backward compatibility with `field` (singular)**: when both are present, sellers SHOULD set `field` to `issues[0].pointer`. Pre-3.1 consumers reading only `field` get the first failure; 3.1+ consumers prefer the top-level `issues`.

**`details.issues` mirror**: sellers MAY mirror `issues[]` into `details.issues` for backward compat with consumers reading from `details`. New consumers should prefer top-level.

Updates:
- `static/schemas/source/core/error.json` — adds `issues` property with item shape
- `docs/building/implementation/error-handling.mdx` — adds `issues` to the error-envelope field table; clarifies `field`/`issues` interaction
