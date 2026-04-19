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

Preview status pending runner implementation in adcp-client (tracked at adcontextprotocol/adcp#2426).
