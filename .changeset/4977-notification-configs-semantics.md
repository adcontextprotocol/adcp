---
"adcontextprotocol": minor
---

Clarify durable `sync_accounts.accounts[].notification_configs[]` semantics:
omitted means unchanged, `[]` clears the account's subscribers, and a non-empty
array replaces the account-scoped set keyed by `subscriber_id`.

The account-level subscription surface remains limited to account-anchored
resource events already defined in `notification-type.json`; it does not define
`account.*` lifecycle events. Account status changes remain observable through
`list_accounts` polling or the one-shot `sync_accounts.push_notification_config`
async-result channel.

Standardize endpoint proof-of-control for active durable webhook configs,
including the challenge payload and response schemas, auth-mode binding,
paused-config behavior, retry guidance, and failure semantics.
