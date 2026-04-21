---
---

fix(training-agent): validate `create_content_standards` input before dereferencing.

Addie was crashing the in-process training-agent tool with `TypeError: Cannot read properties of undefined (reading 'countries_all')` when it called `create_content_standards` without a `scope` object. Two root causes:

1. `handleCreateContentStandards` cast `args` to a type claiming `scope` was required, then dereferenced nested fields with no runtime guard.
2. Addie's `adcp-tools` registry `validate` function was checking a non-existent `name` field instead of the schema's required `scope` and policy fields — so malformed calls cleared the pre-dispatch check and reached the handler.

**Handler:** now returns a structured `INVALID_INPUT` error when `scope` is missing / non-object / an array, when `scope.languages_any` is missing or empty, or when none of `policy` / `policies[]` / `registry_policy_ids[]` is provided. (The AdCP spec accepts one-of `policies` or `registry_policy_ids`; the training-agent additionally accepts the legacy `policy` string. Previously the handler silently accepted `policies` but stored `policy: undefined`; it now synthesizes a policy summary from `policies[]` or `registry_policy_ids[]` so downstream state is always a string.)

**Addie validator:** now checks the real required fields in the same order as the handler, so both surfaces produce identical messages for the same bad input.

**Tests:** 8 regression tests in `training-agent.test.ts` covering missing scope, scope-as-array, missing/empty `languages_any`, missing policy-fields entirely, and success paths for `policy` string, spec-shape `policies[]`, and `registry_policy_ids[]`. All go through the full MCP `CallTool` handler (`simulateCallTool`).
