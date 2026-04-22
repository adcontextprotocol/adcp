---
"adcontextprotocol": patch
---

Clarify the two-layer error model and add error-code taxonomy lint:

- Documents the envelope-vs-payload distinction: `adcp_error` (MCP structuredContent / A2A DataPart / JSON-RPC error.data) signals transport-level failure; `errors[]` in the task payload carries task-level error arrays. Fatal failures SHOULD populate both layers (closes #2587).
- Fixes four storyboard validators that pinned assertions to the payload shape (`check: field_present, path: "errors"`), which failed against conformant agents that surface errors only via the transport envelope. Replaces with `check: error_code`, which the runner resolves from either layer (closes #2587).
- Adds `scripts/lint-error-codes.cjs` and the `test:error-codes` npm script. Every storyboard `error_code` assertion is validated against the canonical enum at `static/schemas/source/enums/error-code.json`. Wired into the main `npm test` pipeline — undefined codes fail the build (closes #2588).
- Sets up the alias-file convention at `static/schemas/source/enums/error-code-aliases.json` (file created lazily on first rename) so code renames can land with a deprecation window rather than synchronized big-bang changes.
