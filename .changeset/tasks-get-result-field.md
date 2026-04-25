---
"adcontextprotocol": minor
---

feat(schema): add `result` and `include_result` to `tasks/get` request/response (closes #3123)

`tasks/get` had no typed field for the completion payload — buyers polling an async `create_media_buy` (or any submitted-arm task) could see `status: completed` but had no schema-backed path to retrieve `media_buy_id` and `packages`. The push-notification webhook schema already defined this pattern correctly (`result: $ref async-response-data.json`); the polling API simply never got the same field.

**Schema changes (both additive, non-breaking):**

- `static/schemas/source/core/tasks-get-response.json` — adds optional `result: $ref /schemas/core/async-response-data.json`. Present when `status` is `completed` or `failed` and `include_result: true` was requested; absent otherwise. Mirrors the `result` field in `mcp-webhook-payload.json` so push and pull paths return the same payload shape.
- `static/schemas/source/core/tasks-get-request.json` — adds optional `include_result: boolean` (default `false`). Signals that the caller wants the completion payload on the response. `async-operations.mdx` and `task-lifecycle.mdx` already referenced this parameter in code examples; this PR formalizes it in the schema.

**Docs:**

- `docs/protocol/calling-an-agent.mdx` — adds a completed `tasks/get` example showing the `result` field, closing the documentation gap identified in the issue.

Non-breaking: `result` is optional on both request and response. Sellers omitting it on non-completed tasks or on requests without `include_result: true` remain spec-conformant. Existing `adcp-client` consumers relying on informal `additionalProperties` passthrough continue to work; the typed field gives SDKs a stable, named field to key on.

Unblocks adcp-client#967 (polling-cycle hardening).
