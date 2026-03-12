---
"adcontextprotocol": patch
---

Clarify sandbox account protocol by account model. Explicit accounts (`require_operator_auth: true`) discover pre-existing sandbox test accounts via `list_accounts`. Implicit accounts declare sandbox via `sync_accounts` with `sandbox: true` and reference by natural key.
