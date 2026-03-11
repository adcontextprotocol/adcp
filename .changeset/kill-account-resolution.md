---
"adcontextprotocol": major
---

Remove `account_resolution` capability field. `require_operator_auth` now determines both the auth model and account reference style: `true` means explicit accounts (discover via `list_accounts`, pass `account_id`), `false` means implicit accounts (declare via `sync_accounts`, pass natural key).
