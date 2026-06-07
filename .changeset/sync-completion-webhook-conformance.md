---
"adcontextprotocol": patch
---

Clarify that task webhooks are not emitted for synchronous completions and add
webhook-emission storyboard coverage for the sync-only invariant. Sellers MUST
NOT replay an inline terminal result to `push_notification_config.url` or invent
a `task_id`; buyer SDKs may still normalize synchronous responses into local
callbacks or handlers because those local conveniences are not AdCP webhooks.
The canonical probe sends an advertised wholesale `get_products` request with
`push_notification_config` and accepts either a terminal synchronous response
without `task_id` or a structured well-formed runtime rejection. A Submitted
async handoff is non-conformant. Any future sync-completion notification mode
would need an explicit, capability-advertised opt-in.
