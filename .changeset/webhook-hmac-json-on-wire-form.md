---
"adcontextprotocol": patch
---

Pin the canonical on-wire JSON form for AdCP webhook signatures and close the signer-side serialization-mismatch trap.

The legacy HMAC-SHA256 webhook signature covers `{unix_timestamp}.{raw_http_body_bytes}`. The spec previously said "never re-serialize the JSON" but did not pin the JSON serialization form the signer produces. The result: a silent cross-SDK bug where Python signers called `json.dumps(payload)` (spaced separators) while httpx wrote compact bytes on the wire, causing 401s at every compliant verifier (adcontextprotocol/adcp-client-python#205). Closes adcontextprotocol/adcp#2464.

**Legacy HMAC (`docs/building/implementation/security.mdx`, `docs/building/implementation/webhooks.mdx`):**
- New **Canonical on-wire form** rule — raw body bytes MUST be byte-identical to the wire; JSON serialization MUST use compact separators (`","` / `":"`). Matches JavaScript `JSON.stringify`, httpx defaults, and most HTTP-client JSON output.
- New **Non-canonicalized aspects** rule — key ordering, unicode-escape policy, and number representation are NOT canonicalized (signers and verifiers compare bytes). Signers SHOULD NOT emit duplicate keys; verifiers MAY reject them (RFC 8259 §4 leaves duplicate-key parsing undefined).
- New **Verifier input** rule — verifiers MUST use raw bytes captured pre-parse and SHOULD NOT re-serialize a parsed payload to reconstruct the signed bytes (re-serialization silently fails on key-order, unicode-escape, or number-format drift and masks signer bugs the verifier should surface). Verifiers that cannot capture raw bytes MUST fail closed.

**RFC 9421 parallel fix (`docs/building/implementation/security.mdx`):**
- Added a signer-side bullet to the "Known body-modifying transport patterns" warning: serialize the body once and use those exact bytes for both the `content-digest` input and the HTTP body. Same trap class as the HMAC bug, fails loud under 9421 (`webhook_signature_digest_mismatch`) but still worth calling out symmetrically.

**Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**
- Positive: whitespace-sensitive keys + nested objects/arrays in canonical compact form.
- Positive: ASCII-escaped unicode (`\u00e9`) — paired with the existing raw-UTF-8 vector to make the "unicode-escape policy is not canonicalized" rule concrete.
- Rejection: the Python-default spaced-form bug (signature over spaced bytes, raw body on the wire is compact — MUST NOT verify).

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Added iteration over `rejection_vectors` so stale/typo'd rejection vectors fail CI. Previously only `vectors` were exercised.
- Tightened the compact-vs-spaced sanity check to `startsWith('compact JSON')` / `startsWith('spaced JSON')` so new vectors containing those words in descriptions can't silently redirect the check.
