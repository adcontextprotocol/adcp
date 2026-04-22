---
---

Fix two idempotency storyboard failures (closes #2842):

- **Framework dispatch IDEMPOTENCY_CONFLICT payload leak.** `@adcp/client/server`'s
  `adcpError()` builder auto-injects `recovery` on every error envelope, but
  the universal idempotency storyboard's `conflict_no_payload_leak` invariant
  allows only a narrow set of envelope keys on `IDEMPOTENCY_CONFLICT` (`code`,
  `message`, `status`, `retry_after`, `correlation_id`, `request_id`,
  `operation_id`) to prevent stolen-key read oracles. The framework training
  agent now intercepts outbound MCP response bytes and strips disallowed
  envelope keys so the invariant passes without forking the SDK. Legacy
  dispatch already builds a minimal envelope by hand and is unchanged.
- **Universal idempotency storyboard: add `push_notification_config.url` to
  the `create_media_buy` replay window.** The `no_duplicate_webhooks_on_replay`
  step depends on observing outbound webhooks, but neither the initial nor
  the replay step previously included a webhook destination in
  `sample_request`, so the runner saw zero deliveries and failed the
  assertion regardless of agent behavior. Both steps now bind to the same
  `{{runner.webhook_url:create_media_buy_initial}}` endpoint (byte-identical
  canonical payload → no false IDEMPOTENCY_CONFLICT on replay), and the
  assertion's `triggered_by` is realigned so the default filter resolves
  against the initial step's `stepOperationIds` entry.
