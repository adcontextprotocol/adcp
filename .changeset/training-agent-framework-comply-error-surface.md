---
---

Training agent (framework path): close the `deterministic_testing`
storyboard's error-surface gaps so the reference seller round-trips
typed controller errors.

- **`UNKNOWN_SCENARIO` on unrecognized scenarios**: the framework's
  custom-tool zod input rejected unknown `scenario` values at MCP
  validation, returning a generic validation error without the
  controller's context echo. Loosen `COMPLY_TEST_CONTROLLER_SCHEMA.
  scenario` from `z.enum([...])` to `z.string()` so the SDK handler
  emits the typed `UNKNOWN_SCENARIO` envelope (with `success: false`,
  `error`, and `context.correlation_id` preserved).
- **`INVALID_TRANSITION` on cross-request state machine probes**: the
  framework path never wrapped tool handlers in `runWithSessionContext`
  / `flushDirtySessions`, so mutations from one request (e.g.
  `sync_creatives`, `create_media_buy`) were discarded before the next
  request (e.g. `force_creative_status` → `NOT_FOUND` instead of
  `INVALID_TRANSITION`). Wrap both `adapt()` and `customToolFor()`
  handlers in the same session-persistence envelope the legacy dispatch
  uses at the MCP handler level. Closes #2844.

Adds `tests/unit/training-agent-framework-comply.test.ts` to lock in
the framework-path error surface for both probes.
