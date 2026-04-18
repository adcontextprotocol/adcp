# AdCP Request Signing Conformance Vectors

Test vectors for the AdCP RFC 9421 request-signing profile. These fixtures drive cross-implementation conformance testing so a signer written in one SDK and a verifier written in another agree on the wire format.

Specification: [Signed Requests (Transport Layer)](https://adcontextprotocol.org/docs/building/implementation/security#signed-requests-transport-layer) in `docs/building/implementation/security.mdx`.

## Scope

These vectors exercise the [verifier checklist](https://adcontextprotocol.org/docs/building/implementation/security#verifier-checklist-requests) and the RFC 9421 profile constraints: covered components, signature parameters, tag namespace, alg allowlist, `adcp_use` key-purpose discriminator, replay dedup, revocation, and content-digest semantics. They do not exercise live JWKS fetch, brand.json discovery, or revocation-list polling — those require live endpoints and belong in integration suites.

## File layout

```
test-vectors/request-signing/
├── README.md                             this file
├── keys.json                             test keypairs (Ed25519 + ES256) in JWK format with adcp_use values
├── negative/                             vectors that MUST fail verification
│   ├── 001-no-signature-header.json      → request_signature_required (pre-check 0; op in required_for)
│   ├── 002-wrong-tag.json                → request_signature_tag_invalid (step 3)
│   ├── 003-expired-signature.json        → request_signature_window_invalid (step 5; expired)
│   ├── 004-window-too-long.json          → request_signature_window_invalid (step 5; window > 300s)
│   ├── 005-alg-not-allowed.json          → request_signature_alg_not_allowed (step 4)
│   ├── 006-missing-covered-component.json → request_signature_components_incomplete (step 6; @authority missing)
│   ├── 007-missing-content-digest.json   → request_signature_components_incomplete (step 6; policy 'required')
│   ├── 008-unknown-keyid.json            → request_signature_key_unknown (step 7)
│   ├── 009-key-ops-missing-verify.json   → request_signature_key_purpose_invalid (step 8; adcp_use mismatch)
│   ├── 010-content-digest-mismatch.json  → request_signature_digest_mismatch (step 11)
│   ├── 011-malformed-header.json         → request_signature_header_malformed (step 1; downgrade protection)
│   ├── 012-missing-expires-param.json    → request_signature_params_incomplete (step 2)
│   ├── 013-expires-le-created.json       → request_signature_window_invalid (step 5; expires ≤ created)
│   ├── 014-missing-nonce-param.json      → request_signature_params_incomplete (step 2)
│   ├── 015-signature-invalid.json        → request_signature_invalid (step 10; canonicalization catcher)
│   ├── 016-replayed-nonce.json           → request_signature_replayed (step 12; requires test_harness_state preload)
│   ├── 017-key-revoked.json              → request_signature_key_revoked (step 9; requires test_harness_state preload)
│   └── 018-digest-covered-when-forbidden.json → request_signature_components_unexpected (step 6; policy 'forbidden')
└── positive/                             vectors that MUST verify successfully
    ├── 001-basic-post.json               Ed25519, no content-digest
    ├── 002-post-with-content-digest.json Ed25519, content-digest covered
    └── 003-es256-post.json               ES256, no content-digest
```

## Vector format

Every vector is a single JSON file with this shape:

```json
{
  "name": "human-readable description",
  "spec_reference": "#anchor in security.mdx (checklist step or pre-check)",
  "reference_now": 1776520800,
  "request": {
    "method": "POST",
    "url": "https://seller.example.com/adcp/create_media_buy",
    "headers": {
      "Content-Type": "application/json",
      "Signature-Input": "sig1=(...)",
      "Signature": "sig1=:base64url_signature:",
      "Content-Digest": "sha-256=:base64url_digest:"
    },
    "body": "{\"...\":\"...\"}"
  },
  "verifier_capability": {
    "supported": true,
    "covers_content_digest": "either",
    "required_for": ["create_media_buy"]
  },
  "jwks_ref": ["test-ed25519-2026"],
  "jwks_override": { "keys": [ "..." ] },
  "test_harness_state": {
    "replay_cache_entries": [ "..." ],
    "revocation_list": { "..." }
  },
  "expected_signature_base": "\"@method\": POST\n...",
  "expected_outcome": {
    "success": false,
    "error_code": "request_signature_window_invalid",
    "failed_step": 5
  },
  "$comment": "optional free-form notes"
}
```

### Fields

- **`name`** — one-line description.
- **`spec_reference`** — anchor in `security.mdx` the vector tests, including the checklist step number.
- **`reference_now`** — Unix seconds. Treat as the wall-clock value the verifier should use when evaluating the signature window. Inject into your test harness rather than using `Date.now()`.
- **`request`** — the raw HTTP request the verifier receives. `headers` is case-insensitive; `body` is the exact byte string on the wire (empty string for GETs).
- **`verifier_capability`** — the `request_signing` block the verifier advertises. Drives expected behavior on content-digest coverage (`"required"` | `"forbidden"` | `"either"`) and whether unsigned requests to the operation are rejected pre-check.
- **`jwks_ref`** — array of `kid` strings from `keys.json`. The test harness builds the verifier's view of the signing agent's JWKS by selecting those entries. Present on most vectors.
- **`jwks_override`** — full JWKS object (`{ keys: [...] }`) that replaces the default `jwks_ref` lookup for this vector. Used when a vector needs a JWK that is NOT in the canonical `keys.json` (e.g., a malformed `key_ops` to test step 8 rejection). Mutually exclusive with `jwks_ref`.
- **`test_harness_state`** — optional. Preloads verifier state BEFORE invoking verification. Supported sub-keys:
  - `replay_cache_entries` — list of `{ keyid, nonce, ttl_seconds }` to preload into the replay cache (used by `016-replayed-nonce.json`).
  - `revocation_list` — full signed-revocation-list object to preload as the current freshness snapshot (used by `017-key-revoked.json`).
- **`expected_signature_base`** — present on positive vectors and on `015-signature-invalid.json`. The canonical signature base string per RFC 9421 §2.5, with actual newlines between component lines (the JSON string uses `\n` escapes which parse to newlines). Implementers can diff their computed base against this field BEFORE worrying about signatures — canonicalization disagreements are the #1 source of 9421 interop bugs, and checking the base is how you catch them.
- **`expected_outcome.success`** — `true` for positive vectors, `false` for negative.
- **`expected_outcome.error_code`** — stable code from the [transport error taxonomy](https://adcontextprotocol.org/docs/building/implementation/security#transport-error-taxonomy). Conformance requires **byte-for-byte match** on this code. Negative vectors only.
- **`expected_outcome.failed_step`** — which step of the verifier checklist the rejection occurs at. Informational only — an implementation that rejects at an earlier step with the same error code is non-conformant (see [Conformance expectations](#conformance-expectations)). Negative vectors only.
- **`$comment`** — free-form clarifying notes. Some vectors use `$comment` to describe test-harness setup or conformance edge cases.

## Test keypairs

`keys.json` ships three keypairs used across the vectors:

| kid | alg | adcp_use | purpose |
|---|---|---|---|
| `test-ed25519-2026` | EdDSA (Ed25519) | `request-signing` | primary signing key for Ed25519 positive vectors |
| `test-es256-2026` | ES256 | `request-signing` | edge-runtime variant; covers ES256 |
| `test-gov-2026` | EdDSA (Ed25519) | `governance-signing` | included to test the cross-purpose rejection rule at checklist step 8 (vector `009-key-ops-missing-verify` presents this key when verifying a request signature) |

The private-key halves are present in `keys.json` as `_private_d_for_test_only` so implementations can regenerate positive-vector signatures deterministically. **These keypairs are for conformance testing only. They are public knowledge and MUST NOT be used in any production capacity.**

## Conformance expectations

An implementation is conformant when, for every vector:

1. **Negative vectors** produce `expected_outcome.error_code` exactly. The `failed_step` is informational: an implementation that rejects with the correct error code is conformant, even if its internal step numbering differs. An implementation that rejects with a DIFFERENT error code (even at the right step) is non-conformant.
2. **Positive vectors** verify without error.
3. **Signature bytes on positive vectors** match `request.headers.Signature` byte-for-byte when the implementation signs with the corresponding key from `keys.json`. Ed25519 is deterministic (001 and 002 will reproduce byte-exact). ES256 uses IEEE P1363 (r||s) encoding per RFC 9421 §3.3.2; ECDSA is non-deterministic by default, so implementations that use random-k are conformant on VERIFY but may not reproduce the `Signature` byte-for-byte. Verifiers are the protocol surface — reproduction of signer bytes is a convenience check, not a normative requirement.

## Generating positive-vector signatures

Positive-vector signatures are computed from the canonical signature base per RFC 9421 §2.5. The base string for each positive vector is in `expected_signature_base` so implementers can check their canonicalization independently of cryptographic signing.

The shipped signatures were generated from those base strings using the corresponding private keys. Regenerator script (not shipped): `.context/generate-test-vectors.mjs` uses `jose` + Node's `node:crypto` to produce the committed outputs.

## Running vectors against an implementation

A reference harness is in progress at https://github.com/adcontextprotocol/adcp-client/issues/575. Until it lands, implementers consuming these vectors should:

1. Parse each vector JSON.
2. Build a `Request` object from `vector.request.method`, `vector.request.url`, `vector.request.headers`, `vector.request.body`.
3. Build the verifier's JWKS from `vector.jwks_ref` (selecting entries from `keys.json`) or `vector.jwks_override` (use as-is).
4. Preload any `test_harness_state` sub-keys into the verifier's replay cache and revocation snapshot.
5. Invoke verification with `reference_now` as the wall clock, `vector.verifier_capability` as the advertised capability, and the operation name derived from the request URL or `expected_outcome.failed_step == 0`'s pre-check expectation.
6. Assert:
   - Negative: error code matches `expected_outcome.error_code` exactly.
   - Positive: verification returns successfully.

## Adding vectors

Every new vector MUST:

1. Cite a specific normative requirement in `security.mdx`.
2. Identify the verifier-checklist step it exercises (or the pre-check).
3. Use only keypairs from `keys.json`, OR supply a documented `jwks_override` explaining why a non-canonical key shape is required.
4. Include `expected_signature_base` for positive vectors and for step-10 `request_signature_invalid` catchers.
5. Include `test_harness_state` for any vector that requires preloaded verifier state.
