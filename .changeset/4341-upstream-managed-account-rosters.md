---
"adcontextprotocol": patch
---

Clarify account namespace semantics for `account_id` references. Account-id mode now explicitly covers both seller-defined IDs supplied out-of-band and upstream-managed namespaces discovered through `list_accounts`; sellers MUST expose `list_accounts` when a credential can access more than one account and SHOULD expose a singleton row when a credential can access exactly one account. `sync_accounts` provisioning remains the buyer-declared natural-key path, and sellers MAY echo `account_id` there only if they continue accepting natural-key `AccountRef` values for subsequent calls. Required-account tasks must receive an explicit `AccountRef`; optional account omission is task-local, not a hidden credential-implied default.

Refs #4341.
