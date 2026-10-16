---
"adcontextprotocol": patch
---

Re-encode two request-signing Signature tokens as unpadded base64url so they satisfy the maintained 3.1 emission profile.

`positive/002-post-with-content-digest.json` and `negative/018-digest-covered-when-forbidden.json` were re-signed with padded standard base64 when operation-valid bodies were backported. `docs/building/by-layer/L1/security.mdx` ("Binary value encoding") overrides RFC 8941 for this profile: `Signature` MUST be emitted as base64url without padding, and a signer emitting `+`, `/` or `=` is non-conformant. Verifiers only SHOULD lenient-decode pure standard base64, so a conforming strict verifier may reject these with `request_signature_header_malformed` — which is what the maintained SDK does on an explicit 3.1 pin. They were the only 2 of 37 vectors in the standard alphabet; the other 35 were already base64url.

The effect on an explicitly 3.1-pinned verifier: `positive/002` failed at step 1 instead of verifying, and `negative/018` failed at step 1 for the wrong reason instead of reaching its intended `request_signature_components_unexpected` at step 6. Unpinned verifiers accept both alphabets, which is why existing coverage missed it.

Only the two `Signature` tokens change. Each decodes to the same 64 signature bytes and is re-encoded, so nothing is re-signed: request bodies, `Content-Digest`, `Signature-Input`, `expected_signature_base` and the Ed25519 key material are untouched. `Content-Digest` keeps its historical standard-base64 form. The same `security.mdx` rule names `Content-Digest` alongside `Signature`, so that form is a known discrepancy tracked separately — this change neither resolves it nor claims to. It is out of scope here for a concrete reason: `content-digest` is a covered component, so its literal field value is part of `expected_signature_base`. Re-encoding it would change the signed base and require a genuine re-sign, which this change deliberately does not do.

`tests/request-signing-vector-bodies.test.cjs` asserted the RFC 8941 default rather than the AdCP override. It now checks the unpadded-base64url grammar with a canonical round-trip and compares the deterministic Ed25519 re-sign in the same encoding. A new corpus guard applies that grammar to every `Signature` token in all 37 signed vectors (38 tokens), with the 3 deliberately unsigned vectors allowlisted and both counts pinned so a new vector cannot silently skip it. The truthful `Content-Digest` check is unchanged, with its scope stated inline.

This profile is 3.0/3.1 only. `security.mdx` on 3.2 inverts it — there these values are RFC 8941 `sf-binary` in the standard alphabet and base64url MUST be rejected, and the versioned fixtures preserve both profiles on purpose. This commit MUST NOT be forward-ported to 3.2/main; the forward-merge conflict on these files is expected and resolves to each line's own profile.
