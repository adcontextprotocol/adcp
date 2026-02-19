---
"adcontextprotocol": minor
---

Add sandbox mode as a protocol parameter on all task requests. Sellers declare support via `features.sandbox` in capabilities. Buyers pass `sandbox: true` on any request to run without real platform calls or spend. Replaces the previously documented HTTP header approach (X-Dry-Run, X-Test-Session-ID, X-Mock-Time).
