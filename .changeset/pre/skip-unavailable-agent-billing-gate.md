---
"adcontextprotocol": patch
---

Skip the per-agent billing permission phases when a seller does not advertise agent billing, preventing capability-level `BILLING_NOT_SUPPORTED` responses from being graded as failures against the narrower `BILLING_NOT_PERMITTED_FOR_AGENT` contract.
