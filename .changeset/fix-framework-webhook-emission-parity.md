---
---

fix(training-agent): emit completion webhooks on the framework dispatch path

The `adapt()` wrapper in `framework-server.ts` called the domain handler but
never fired a completion webhook when the buyer supplied
`push_notification_config.url`. That broke three `webhook_emission` storyboard
invariants under `TRAINING_AGENT_USE_FRAMEWORK=1`: payload/idempotency_key
presence, retry dedupe, and RFC 9421 signature verification. Legacy dispatch
already handled this inline in `task-handlers.ts`.

Extracts the emission logic into `maybeEmitCompletionWebhook` in
`webhooks.ts` and calls it from both paths so the framework and legacy
dispatchers emit byte-identical webhook envelopes. Closes #2843.
