---
"adcontextprotocol": minor
---

Deprecate inline provider credentials in secured artifact access. Signed URLs are now the recommended default for one-off delivery, while credential-free workload identity remains available for established relationships and bounded bearer tokens remain available for origins that require them.

Document the AdCP 3.2 migration path and require secret-safe handling of legacy credentials, bearer tokens, and complete signed URLs during the compatibility window. The deprecated `service_account.credentials` field remains schema-valid throughout 3.x and is eligible for removal in 4.0 or later once the six-month notice and full-release-cycle policy gates are satisfied.
