---
---

fix(compliance): add sample_request to webhook-emission trigger steps

The `universal/webhook-emission.yaml` storyboard had three trigger steps
(`trigger_webhook_operation`, `trigger_retry_scenario`, `trigger_signed_webhook`)
with narratives that described passing `push_notification_config.url =
{{runner.webhook_url:<step_id>}}`, but none of the three carried a
`sample_request` block. The runner's mustache expander only substitutes
placeholders that appear in a step's `sample_request`, so no webhook URL ever
reached the agent under test — `expect_webhook_presence`,
`expect_key_stable_across_retries`, and `expect_signature_valid` then all
timed out with "webhook never arrived" across every webhook-emitting agent.

Each trigger step now carries a minimal, operation-agnostic `sample_request`:
`push_notification_config.url` (directs the webhook at the per-step receiver,
no authentication block so the 9421 baseline is in effect), `idempotency_key`
(keeps the trigger call itself retry-safe), and `context.correlation_id`.
Operation-specific required fields (e.g., brand, packages, budget for
`create_media_buy`) are supplied by whichever `test_kit` resolves
`$test_kit.operations.primary_webhook_emitter`.

Closes adcp#2758.
