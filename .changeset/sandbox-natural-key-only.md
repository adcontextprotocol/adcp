---
"adcontextprotocol": minor
---

Remove sandbox from sync_accounts and list_accounts schemas. Sandbox accounts are natural-key-only constructs referenced via account-ref with `sandbox: true` — no provisioning or discovery needed.
