---
---

Training agent: `createAdcpServer` scaffold behind a feature flag.

Adds `server/src/training-agent/framework-server.ts` —
`createFrameworkTrainingAgentServer()` wires every existing domain
handler through `@adcp/client/server`'s `createAdcpServer` via an
`adapt()` helper that:

- Strips `context` from params before invoking the handler; re-stamps it
  on the response (prevents the framework's `injectContextIntoResponse`
  from double-echoing).
- Enforces `VERSION_UNSUPPORTED` for `adcp_major_version !== 3`
  (framework doesn't check this today).
- Returns pre-formatted `CallToolResult` envelopes so the framework's
  `isFormattedResponse` check passes through and response bytes stay
  byte-identical to the legacy hand-rolled dispatch.
- Maps thrown exceptions to `SERVICE_UNAVAILABLE` per legacy behavior.

Covers all 30+ spec tools plus 9 tools outside `AdcpToolMap`
(registered via `registerTool()` after `createAdcpServer` returns).

## Feature flag

Opt in via `TRAINING_AGENT_USE_FRAMEWORK=1`. Default OFF; the legacy
hand-rolled dispatch path remains authoritative. Follow-up PR flips the
default once parity is proven.

## Gaps for the follow-up

- `get_adcp_capabilities` override — framework auto-registers this and
  `registerTool()` rejects duplicates. Training-agent-specific fields
  (`publisher_domains`, `compliance_testing.scenarios`,
  `media_buy.execution.targeting.*`) need SDK support for
  `replaceTool()` or a wider `AdcpCapabilitiesConfig`.
- Webhook emission from dispatch — legacy path emits when
  `push_notification_config.url` is on the request; framework expects
  `ctx.emitWebhook()` from handlers. Need to either teach handlers to
  emit or keep a dispatch-level emitter on the framework path.
- Stateless-HTTP task store verification — framework uses
  `createTaskCapableServer`; needs empirical check under task-augmented
  `create_media_buy` to ensure `notifications/tasks/status` doesn't
  fail on a fresh transport per request.

All tracked in `server/src/training-agent/FRAMEWORK_MIGRATION.md`.

Test status: 437/437 unit + integration tests green with flag OFF.
