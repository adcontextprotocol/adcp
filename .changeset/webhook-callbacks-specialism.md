---
"adcontextprotocol": minor
---

Add `webhook-callbacks` compliance specialism for outbound-webhook conformance (signing + idempotency).

Storyboards are unidirectional today — runner calls agent, agent responds — so webhook conformance (idempotency_key presence and stability across retries, RFC 9421 webhook signature validity) has no programmatic grading surface. This change adds the spec-side surface for a runner to host a webhook receiver and assert on what the agent sends back.

- New `specialism.json` enum value `"webhook-callbacks"` with description covering the profile.
- New `specialisms/webhook-callbacks/index.yaml` specialism with four phases: capability discovery, idempotency_key presence, idempotency_key stability across retries, and 9421 signature validity (optional, gated on agent advertising 9421 webhook signing).
- New `test-kits/webhook-callbacks-runner.yaml` harness contract: two endpoint modes (loopback_mock default for lint/fast, proxy_url for full conformance), per-step receiver URLs, 5xx-then-2xx retry-replay shape, and explicit delegation to `@adcp/client` primitives (`AsyncHandlerConfig.webhookDedup`, `WebhookMetadata.idempotency_key`, `Activity.type == "webhook_duplicate"`) so the runner doesn't reimplement verification or dedup.
- New step types in `universal/storyboard-schema.yaml`: `expect_webhook`, `expect_webhook_retry_keys_stable`, `expect_webhook_signature_valid`. Plus substitution variables (`{{runner.webhook_base}}`, `{{runner.webhook_url:<step_id>}}`) and two cross-specialism helpers (`expect_max_deliveries_per_logical_event`, `requires_contract`).
- `universal/idempotency.yaml`: the manual "compliance reviewer SHOULD verify in the seller's audit log" step in the replay phase is replaced by a programmatic `expect_webhook` assertion with `expect_max_deliveries_per_logical_event: 1` gated on the webhook_callbacks_runner contract. Runners without a webhook receiver skip the step as not_applicable; runners with one catch duplicate-side-effect bugs on replay directly.

Preview status pending adcp-client runner implementation. Specialism is claimable by any agent that emits webhooks via `push_notification_config` — typically sellers on spend-committing operations, rights agents on revocation notifications, governance agents on list-change webhooks.
