---
---

CSRF middleware now exempts `/mcp-strict`, `/mcp-strict-required`, and `/mcp-strict-forbidden` — the training agent's RFC 9421 conformance routes. These are server-to-server endpoints authenticated by signature or bearer token; CSRF is the wrong protection layer.

Without these exemptions the conformance grader's signed POSTs were rejected with `CSRF validation failed` (HTTP 403, no error code) before the signing verifier could run, producing a misleading "every vector failed" report instead of the spec-mandated 401 with RFC 9421 error codes. Closes the demo-blocking half of #2368 — the verifier middleware, JWKS, replay store, and test-kit contract were all already wired; only the CSRF exemption was missing.
