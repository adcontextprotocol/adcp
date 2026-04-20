---
---

Add a conformance test vector for the duplicate-object-key path in the legacy HMAC-SHA256 webhook scheme, making the "verifiers MAY reject bodies containing duplicate keys" clause from #2478 testable.

**Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**
- New positive vector `duplicate-keys` with `raw_body={"status":"ok","status":"ok"}` and a correctly-computed HMAC. The vector carries a `verifier_outcomes: ["accept", "reject-malformed"]` field and a long-form description stating explicitly that BOTH outcomes are spec-conformant: accept (the signature is mathematically valid over the raw bytes; the verifier has no duty to parse the payload) or reject (parser behavior for duplicates is undefined per RFC 8259 §4, so the verifier treats the body as malformed under the "verifiers MAY reject" clause). Conformance suites MUST assert the SDK produces one of these two outcomes and MUST NOT assert either specific outcome — an SDK that crashes or returns an uninitialized parse is non-conformant.

No spec change. The clause as written in `security.mdx` already permits both outcomes; this vector only makes the clause probe-able so SDK conformance suites can catch drift (e.g., an SDK that panics on duplicate keys rather than either accepting or rejecting cleanly).

Closes #2483.
