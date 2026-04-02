---
"adcontextprotocol": patch
---

Fix migration guide missing comply-blocking requirements

- Add `buying_mode` as a required field on all `get_products` requests to the breaking changes table
- Add warning callout for `buying_mode` comply-blocking requirement
- Fix Accounts protocol row: protocol is required for all buyers, `require_operator_auth` determines which task (`sync_accounts` vs `list_accounts`) to call
