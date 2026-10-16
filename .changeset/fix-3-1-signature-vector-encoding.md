---
"adcontextprotocol": patch
---

Re-encode two request-signing Signature tokens as unpadded base64url so they satisfy the maintained 3.1 emission profile.

`positive/002-post-with-content-digest.json` and `negative/018-digest-covered-when-forbidden.json` were re-signed with padded standard base64 when operation-valid bodies were backported. `docs/building/by-layer/L1/security.mdx` ("Binary value encoding") overrides RFC 8941 for this profile: `Signature` MUST be emitted as base64url without padding, and a signer emitting `+`, `/` or `=` is non-conformant. Verifiers only SHOULD lenient-decode pure standard base64, so a conforming strict verifier may reject these with `request_signature_header_malformed` — which is what the maintained SDK does on an explicit 3.1 pin. They were the only 2 of 37 vectors in the standard alphabet; the other 35 were already base64url.

The effect on an explicitly 3.1-pinned verifier: `positive/002` failed at step 1 instead of verifying, and `negative/018` failed at step 1 for the wrong reason instead of reaching its intended `request_signature_components_unexpected` at step 6. Unpinned verifiers accept both alphabets, which is why existing coverage missed it.

Only the two `Signature` tokens change. Each decodes to the same 64 signature bytes and is re-encoded, so nothing is re-signed: request bodies, `Content-Digest`, `Signature-Input`, `expected_signature_base` and the Ed25519 key material are untouched. `Content-Digest` deliberately keeps its historical standard-base64 form — the maintained SDK accepts both legacy digests, and this change makes no claim about the older prose that also names `Content-Digest`.

`tests/request-signing-vector-bodies.test.cjs` asserted the RFC 8941 default rather than the AdCP override. It now checks the unpadded-base64url grammar with a canonical round-trip, rejects the standard-alphabet and padded forms of the same bytes as negative controls, and compares the deterministic Ed25519 re-sign in the same encoding. The truthful `Content-Digest` check is unchanged, with its scope stated inline.
