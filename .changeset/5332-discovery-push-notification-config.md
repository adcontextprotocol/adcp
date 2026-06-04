---
"adcontextprotocol": minor
---

Clarify async discovery webhook registration for `get_products` and `get_signals`.

Adds optional `push_notification_config` to the `get_products` and `get_signals` request schemas for curated/semantic discovery modes, adds the `get_signals` working/submitted async envelopes to the webhook result union, allows failed discovery completions to omit success payload arrays, documents that webhooks are used when configured and polling `get_task_status` (legacy `tasks/get`) is the fallback, and preserves the synchronous wholesale feed rule (`get_products` `buying_mode: "wholesale"` and `get_signals` `discovery_mode: "wholesale"` MUST NOT use the Submitted arm).
