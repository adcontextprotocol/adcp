---
---

Tighten the legacy webhook HMAC spec (follow-up to #2478 review feedback) and decouple the test-vector CI from vector prose.

**Legacy HMAC (`docs/building/implementation/security.mdx`):**
- Promote the byte-equality invariant to its own top-level bullet, above "Canonical on-wire form." The load-bearing rule — "signers and verifiers MUST compare bytes, not parsed structures, and this scheme does not define a canonical JSON form" — was previously buried mid-paragraph in "Non-canonicalized aspects." The "Canonical on-wire form" and "Verifier input" rules are now framed as failure-class narrowers on the signer and verifier sides of that invariant, which is what they actually are.
- Replace the vague "httpx / most HTTP-client JSON bodies produce compact output by default" wording with a concrete enumeration split by language-level serializer vs. HTTP client: JavaScript `JSON.stringify`, Go `json.Marshal`, Ruby `JSON.generate`, Java Jackson all produce compact output, and HTTP clients built on them (axios, Go `net/http`, Ruby `Net::HTTP`, Java OkHttp) inherit the defaults. Python is called out explicitly as mixed: `httpx` uses compact separators, while `requests(json=...)` and `aiohttp` pass through stdlib `json.dumps` defaults and emit spaced bodies, so signers on those paths MUST pass `separators=(",", ":")`. A trailing non-exhaustiveness disclaimer requires signers to verify their client's actual on-wire serialization rather than treat the list as an allowlist.

**Test vectors (`static/test-vectors/webhook-hmac-sha256.json`):**
- Add a stable kebab-case `id` field to every positive and rejection vector (`compact-js-style`, `spaced-python-default`, `signer-spaced-wire-compact`, etc.). Downstream cross-SDK tests SHOULD key off `id`; `description` prose can be revised without notice. Documented the policy in the top-level `description` field.

**CI (`tests/webhook-hmac-vectors.test.cjs`):**
- Added a structural assertion that every vector and rejection_vector carries a unique kebab-case `id`.
- Switched the compact-vs-spaced sanity check from `startsWith('compact JSON')` / `startsWith('spaced JSON')` prose matching to direct `id === 'compact-js-style'` / `'spaced-python-default'` lookup. Vector descriptions can now be edited freely without silently breaking the check.

No wire-format or signature changes — all existing vectors verify byte-for-byte against the same `expected_signature` values.
