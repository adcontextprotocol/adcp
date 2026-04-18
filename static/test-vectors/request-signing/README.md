# AdCP Request Signing Conformance Vectors

Test vectors for the AdCP RFC 9421 request-signing profile. These fixtures drive cross-implementation conformance testing so a signer written in one SDK and a verifier written in another agree on the wire format.

Specification: [Signed Requests (Transport Layer)](https://adcontextprotocol.org/docs/building/implementation/security#signed-requests-transport-layer) in `docs/building/implementation/security.mdx`.

## Scope

These vectors exercise the verifier checklist (12 steps) and the RFC 9421 profile constraints: covered components, signature parameters, tag namespace, alg allowlist, and content-digest semantics. They do not exercise JWKS fetch, brand.json discovery, or revocation-list polling — those require live endpoints and belong in integration suites.

## File layout

```
test-vectors/request-signing/
├── README.md                  this file
├── keys.json                  test keypairs (Ed25519 and ES256) in JWK format
├── negative/                  vectors that MUST fail verification
│   ├── 001-no-signature-header.json
│   ├── 002-wrong-tag.json
│   ├── 003-expired-signature.json
│   ├── 004-window-too-long.json
│   ├── 005-alg-not-allowed.json
│   ├── 006-missing-covered-component.json
│   ├── 007-missing-content-digest.json
│   ├── 008-unknown-keyid.json
│   ├── 009-key-ops-missing-verify.json
│   └── 010-content-digest-mismatch.json
└── positive/                  vectors that MUST verify successfully
    ├── 001-basic-post.json
    ├── 002-post-with-content-digest.json
    └── 003-get-no-body.json
```

## Vector format

Every vector is a single JSON file with this shape:

```json
{
  "name": "human-readable description",
  "spec_reference": "anchor in security.mdx",
  "request": {
    "method": "POST",
    "url": "https://seller.example.com/adcp/create_media_buy",
    "headers": {
      "Content-Type": "application/json",
      "Signature-Input": "sig1=(\"@method\" \"@target-uri\" \"@authority\" \"content-type\" \"content-digest\");created=1744934400;expires=1744934700;nonce=\"...\";keyid=\"agent-2026-04\";alg=\"ed25519\";tag=\"adcp/request-signing/v1\"",
      "Signature": "sig1=:base64url_signature:",
      "Content-Digest": "sha-256=:base64url_digest:"
    },
    "body": "{\"...\":\"...\"}"
  },
  "verifier_capability": {
    "covers_content_digest": false,
    "required_for": ["create_media_buy"]
  },
  "jwks": {
    "keys": [ "...reference to keys.json entry by kid..." ]
  },
  "expected_outcome": {
    "success": false,
    "error_code": "request_signature_window_invalid",
    "failed_step": 4
  }
}
```

### Fields

- **`name`** — one-line description.
- **`spec_reference`** — anchor in `security.mdx` the vector tests (e.g., `#verifier-checklist-requests`).
- **`request`** — the raw HTTP request the verifier receives. `headers` is a case-insensitive map; `body` is the exact byte string on the wire (empty string for GETs).
- **`verifier_capability`** — the `request_signing` capability the verifier advertises. Drives whether `content-digest` is expected, etc.
- **`jwks`** — the JWKS the verifier would fetch for the signer. Referenced keys live in `keys.json`; include `kid` strings only to keep vectors small.
- **`expected_outcome.success`** — `true` for positive vectors, `false` for negative.
- **`expected_outcome.error_code`** — stable code from the [Transport error taxonomy](https://adcontextprotocol.org/docs/building/implementation/security#transport-error-taxonomy). Negative vectors only.
- **`expected_outcome.failed_step`** — which step of the verifier checklist (1–12) the rejection happens at. Helps implementers debug "my verifier rejects this for a different reason than the vector expects."

## Test keypairs

`keys.json` ships three keypairs used across the vectors:

| kid | alg | use | key_ops | purpose |
|---|---|---|---|---|
| `test-ed25519-2026` | EdDSA (Ed25519) | sig | verify | primary signing key for positive vectors |
| `test-es256-2026` | ES256 | sig | verify | edge-runtime variant; covers ES256-specific canonicalization |
| `test-gov-2026` | EdDSA (Ed25519) | sig | verify | governance-signing key — included to test the cross-purpose rejection rule (vector `009-key-ops-missing-verify` uses it) |

The private-key halves are present in `keys.json` so implementations can regenerate positive-vector signatures deterministically. **These keypairs are for conformance testing only. They are public knowledge and MUST NOT be used in any production capacity.**

## Conformance expectations

An implementation is conformant when, for every vector:

1. Negative vectors produce `expected_outcome.error_code` at or before `expected_outcome.failed_step`.
2. Positive vectors verify without error.
3. Signatures produced by the implementation on the positive-vector inputs match `request.headers.Signature` byte-for-byte when using the corresponding key from `keys.json` and the documented `created`/`nonce`/`expires` values. (Determinism comes from Ed25519 being deterministic and ES256 using the same deterministic-k variant — RFC 6979 — that the reference impl uses.)

For ES256 specifically: only implementations that sign with RFC 6979 deterministic-k can reproduce the expected signature exactly. Implementations using random-k are conformant if they can *verify* the expected signature but not reproduce it — verify-only mode is what matters in practice; verifier behavior is the protocol surface, signer byte-reproduction is a convenience.

## Generating positive vectors

Positive-vector signatures are computed from the canonical signature base per RFC 9421 §2.5. The base string for each positive vector is included in the vector file as `expected_signature_base` so implementers can check their canonicalization independently of cryptographic signing. A reference generator lives in the `@adcp/client` repository (see issue link TBD); signatures here were produced by that generator.

## Adding vectors

Run the conformance suite in `@adcp/client` against new vectors before adding them here. Every new vector MUST:

1. Cite a specific normative requirement in `security.mdx`.
2. Identify the verifier-checklist step it exercises.
3. Use only keypairs from `keys.json` (or add a new documented keypair, with a note that it is conformance-only and public).
4. Include `expected_signature_base` for positive vectors.
