---
"adcontextprotocol": minor
---

Add signed-response verifier error codes and response-signing verifier checklist.

- Add `SIGNED_RESPONSE_ENVELOPE_EXPIRED`, `SIGNED_RESPONSE_REQUEST_HASH_MISMATCH`, and `SIGNED_RESPONSE_TENANT_MISMATCH` to `enums/error-code.json` with normative descriptions and recovery classifications.
- Add a 10-step verifier checklist for designated-task response signing in `docs/building/by-layer/L1/security.mdx`, formalizing the MUST-level verification steps for `verify_brand_claim` / `verify_brand_claims` signed responses — expiry, request-hash binding, tenant binding, and payload consistency.

Refs #6147
