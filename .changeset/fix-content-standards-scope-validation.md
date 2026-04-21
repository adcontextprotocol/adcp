---
---

fix(training-agent): validate `create_content_standards` input before dereferencing.

Addie was crashing the in-process training-agent tool with `TypeError: Cannot read properties of undefined (reading 'countries_all')` when it called `create_content_standards` without a `scope` object. Two root causes:

1. `handleCreateContentStandards` cast `args` to a type claiming `scope` was required, then dereferenced nested fields with no runtime guard.
2. Addie's `adcp-tools` registry `validate` function was checking a non-existent `name` field instead of the schema's required `scope` and `policy` — so malformed calls cleared the pre-dispatch check and reached the handler.

**Handler:** now returns a structured `INVALID_INPUT` error when `scope` is missing / non-object / an array, when `scope.languages_any` is missing or empty, or when `policy` is missing or non-string.

**Addie validator:** now checks the actual required fields in the same order as the handler, so both surfaces produce the same message for the same bad input.

**Tests:** 6 regression tests in `training-agent.test.ts` covering missing scope, scope-as-array, missing/empty `languages_any`, missing `policy`, and the success path — all go through the full MCP `CallTool` handler (`simulateCallTool`) rather than calling the handler function directly.
