---
"adcontextprotocol": minor
---

Add the optional `account.stable_account_id` capability and make returning `account_id` from `sync_accounts` a SHOULD. This is the non-breaking 3.3 step toward one account reference after provisioning (#7850).

A seller declaring `stable_account_id: true` MUST return `account_id` on every non-failed `sync_accounts` provisioning result, MUST accept `{ "account_id": "..." }` wherever an `AccountRef` is accepted (including for buyer-declared accounts), and MUST NOT change an account's ID for the life of the account, including across identity reconciliation. Buyers holding an ID from such a seller SHOULD send it instead of the natural key. Buyer-declared sellers keep accepting the natural key throughout 3.x, and without the capability buyers still MUST NOT assume a returned `account_id` is accepted. Adds a capability-gated compliance scenario for sellers that declare it.

Docs: the accounts overview now explains `require_operator_auth` as who holds the credential the seller authorizes, separates the account operator from authenticated parties, and adds "Toward account IDs everywhere". `sync_principal` and the glossary state that a principal exists from authentication alone, that `sync_principal` is optional configuration rather than registration, and that the operators an agent acts for are not principals. The versioning page no longer contradicts its own rule for optional → required transitions.
