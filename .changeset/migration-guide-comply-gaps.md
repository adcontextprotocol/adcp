---
"adcontextprotocol": patch
---

Fix migration guide missing comply-blocking requirements

- Add `buying_mode` as a required field on all `get_products` requests to the breaking changes table
- Add warning callout flagging `buying_mode` and `sync_accounts` as comply-blocking
- Correct `sync_accounts` requirement: required for all sellers, not conditional on `require_operator_auth`
