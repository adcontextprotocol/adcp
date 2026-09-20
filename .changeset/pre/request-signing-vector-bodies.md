---
"adcontextprotocol": patch
---

Give 35 request-signing conformance vectors bodies that are schema-valid for the operation their URL names, so a seller that validates the request payload before authenticating the caller still reaches the RFC 9421 verifier checklist. Only `request.body` changes; headers, URLs, `verifier_capability` and `expected_outcome` are untouched, and each vector's intended fault is preserved (#7567).
