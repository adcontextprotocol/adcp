---
"adcontextprotocol": minor
---

Add sandbox to account-ref natural key. Implicit-account operators can reference sandbox accounts via `{ brand, operator, sandbox: true }` without provisioning or discovering an account_id. Explicit-account operators discover pre-existing sandbox test accounts via `list_accounts`. The sandbox field participates in the natural key but its usage follows the same implicit/explicit account model rules as non-sandbox accounts.
