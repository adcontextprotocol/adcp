---
"adcontextprotocol": patch
---

Clarify that task webhooks are not emitted for synchronous completions and add
webhook-emission storyboard coverage for the negative case. Sellers MUST NOT
replay an inline terminal result to `push_notification_config.url` or invent a
`task_id`; buyer SDKs may still normalize synchronous responses into local
callbacks or handlers because those local conveniences are not AdCP webhooks.
The new canonical probe sends an advertised wholesale `get_products` request
with `push_notification_config` and asserts the sync-only read rejects task
webhook registration instead of entering an async lifecycle. Any future
sync-completion notification mode would need an explicit, capability-advertised
opt-in.
