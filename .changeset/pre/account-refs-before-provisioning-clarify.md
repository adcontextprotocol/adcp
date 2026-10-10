---
"adcontextprotocol": patch
---

docs(accounts): clarify how buyer-declared account references behave before provisioning. A new "Account references before provisioning" section in the accounts overview spells out what the error table and the `cache_scope` contract already required:

- a natural key resolves only after the account is provisioned (`sync_accounts`, or lazy provisioning where the seller offers it);
- an `account` that doesn't resolve, and that the seller doesn't lazily provision, returns `ACCOUNT_NOT_FOUND` even where `account` is optional, instead of being dropped in favour of public results;
- buyers omit `account` and send `brand` until the account is provisioned, and provision before `request_proposals` when they intend to accept;
- account errors describe buyer setup, not seller health;
- an `account_id` echoed by `sync_accounts` for a buyer-declared account is a seller handle that buyers must not assume is accepted as an `AccountRef`.

`ACCOUNT_NOT_FOUND` now gives the same recovery everywhere: provision a natural key, or verify an `account_id`. It previously said "terminal, verify via list_accounts" in the error-code enum and "re-run sync_accounts" in the L2 guide. The capabilities, `get_products`, `get_signals`, `account-ref`, `sync_accounts`, and sandbox texts point to the new section, and the account-status intro no longer says reads are always available, which contradicted the status table.
