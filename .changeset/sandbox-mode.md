---
"adcontextprotocol": minor
---

Add sandbox mode. Sellers declare support via `account.sandbox` in capabilities. Buyers provision a sandbox account via `sync_accounts` with `sandbox: true`; all requests using that account_id run without real platform calls or spend. Replaces the previously documented HTTP header approach (X-Dry-Run, X-Test-Session-ID, X-Mock-Time).
