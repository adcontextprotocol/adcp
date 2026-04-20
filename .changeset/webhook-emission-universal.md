---
"adcontextprotocol": minor
---

Add `webhook-emission` universal for outbound-webhook conformance (signing + idempotency).

Webhook emission is a cross-cutting capability, not a specialism — any agent that accepts `push_notification_config` on any operation must emit conformant webhooks. Graded as a universal (like `idempotency`), not claimed as a specialism. Applies to sellers, rights agents, governance agents, content-standards agents, and any future agent that emits webhooks.

Storyboards are unidirectional today (runner → agent). Verifying outbound webhook conformance — `idempotency_key` presence and stability across retries (#2417), and RFC 9421 webhook signature validity (#2423) — requires the runner to host a webhook receiver during storyboard execution and observe live deliveries. This PR adds the spec-side surface.

- `universal/webhook-emission.yaml` — new universal with four phases: capability discovery, `idempotency_key` presence, `idempotency_key` stability across retries, and 9421 signature validity (gated on 9421 being in effect — agents whose buyers registered the legacy HMAC fallback skip the signature phase).
- `test-kits/webhook-receiver-runner.yaml` — harness contract. Two endpoint modes: `loopback_mock` default for lint/fast runs (intercepts at the `@adcp/client` AsyncHandler layer, zero network deps) and `proxy_url` for AdCP Verified conformance runs (operator-supplied HTTPS URL). Per-step receiver URLs with `operation_id` echo. 5xx-then-2xx retry-replay shape with configurable count and status. Applies to both `universal/webhook-emission.yaml` and `universal/idempotency.yaml`.
- `universal/idempotency.yaml` — the replay-side-effect invariant ("no duplicate webhooks on replay") was previously graded by a manual-audit step. Replaced with a programmatic `expect_webhook` step using `expect_max_deliveries_per_logical_event: 1` gated on the `webhook_receiver_runner` contract. Runners without a webhook receiver skip as `not_applicable`; runners with one catch duplicate-side-effect bugs directly.
- `universal/storyboard-schema.yaml` — new step types (`expect_webhook`, `expect_webhook_retry_keys_stable`, `expect_webhook_signature_valid`), substitution variables (`{{runner.webhook_base}}`, `{{runner.webhook_url:<step_id>}}`), and cross-cutting helpers (`expect_max_deliveries_per_logical_event`, `requires_contract`).
- `push-notification-config.json` — description drift fix: now says "seller signs outbound with a key published at the jwks_uri on its own brand.json `agents[]` entry" (was "its adagents.json-published key," which is not where the key actually lives per the `#webhook-callbacks` section of security.mdx).

Clean seam: the runner delegates to `@adcp/client` primitives (`AsyncHandlerConfig.webhookDedup`, `WebhookMetadata.idempotency_key`, `Activity.type == "webhook_duplicate"`) rather than reimplementing signature verification or idempotency dedup. The same code that production receivers rely on is what the conformance runner exercises. Cross-references adcontextprotocol/adcp-client#629 by URL.

Implementation-feedback follow-ups (from adcp-client runner work):
- Renamed `schema_ref` on webhook-assertion steps to `webhook_payload_schema_ref` to avoid overloading the request-schema field name on caller→agent steps.
- Clarified that the "caller" minting `operation_id` in the URL template is the runner, not the agent under test — agents MUST echo the runner-supplied operation_id back in the webhook payload and MUST NOT mint their own.
- Required signature verification on every delivery in `expect_webhook_retry_keys_stable` (not just the first) when 9421 is in effect, with a run-scoped `(keyid, nonce)` replay store, to catch publishers that stably reuse both `idempotency_key` (correct) and 9421 `nonce` (incorrect — nonce MUST be fresh per delivery).
- Mandated a single cross-step `(keyid, nonce)` replay store shared across all `expect_webhook_signature_valid` invocations in a run, so cross-step nonce replay is detected.
- Capped `retry_trigger.count` at 10 and allowlisted `retry_trigger.http_status` to `{429, 500, 502, 503, 504}` to prevent typo'd storyboards from turning runners into DoS amplifiers in `proxy_url` mode.
- Required HTTPS scheme on `proxy_url` endpoint mode (loopback_mock is in-process and has no TLS surface).
- Deferred `shared_receiver: true` semantics (fan-in dedup across multiple emitting steps); storyboard authors MUST use per-step receivers in v1.
- Specified that unresolved substitutions like `{{runner.webhook_base}}` MUST grade the storyboard `not_applicable` (preflight) or the step `failed` (step-time) — runners MUST NOT ship literal `{{...}}` tokens on the wire.

Preview status pending runner implementation in adcp-client (tracked at adcontextprotocol/adcp#2426).
