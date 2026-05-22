---
"adcontextprotocol": patch
---

spec: replace the durable catalog event feed with account-level wholesale feed webhooks.

Wholesale product and signals feed changes are now registered through
`sync_accounts.accounts[].notification_configs[]`, delivered with denormalized
`product.*`, `signal.*`, and `wholesale_feed.bulk_change` payloads, and repaired
through `get_products` / `get_signals` using `if_wholesale_feed_version`.
