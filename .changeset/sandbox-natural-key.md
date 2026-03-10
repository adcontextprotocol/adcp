---
"adcontextprotocol": minor
---

Add sandbox to account-ref natural key. Agents can now reference sandbox accounts via `{ brand, operator, sandbox: true }` without provisioning or discovering an account_id. The implicit/explicit account model distinction is preserved — sandbox is the exception where the natural key works regardless of account model.
