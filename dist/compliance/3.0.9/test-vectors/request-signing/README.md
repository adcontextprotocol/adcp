# AdCP Request Signing Conformance Vectors

Test vectors for the AdCP RFC 9421 request-signing profile. These fixtures drive cross-implementation conformance testing so a signer written in one SDK and a verifier written in another agree on the wire format.

Specification: [Signed Requests (Transport Layer)](https://adcontextprotocol.org/docs/building/implementation/security#signed-requests-transport-layer) in `docs/building/implementation/security.mdx`.

**Canonical URLs.** These vectors are served at `https://adcontextprotocol.org/compliance/{version}/test-vectors/request-signing/`, with `{version}` being either a specific release (e.g. `3.0.0`) or `latest` (tracks the most recent GA). Tree preserved — `keys.json`, `negative/*.json`, `positive/*.json` all resolvable. SDKs SHOULD fetch from the versioned CDN path and record the version under test rather than requiring a checkout of the spec repo. Example: `https://adcontextprotocol.org/compliance/latest/test-vectors/request-signing/positive/001-basic-post.json`.

## Scope

These vectors exercise the [verifier checklist](https://adcontextprotocol.org/docs/building/implementation/security#verifier-checklist-requests) and the RFC 9421 profile constraints: covered components, signature parameters, tag namespace, alg allowlist, `adcp_use` key-purpose discriminator, replay dedup, revocation, and content-digest semantics. They do not exercise live JWKS fetch, brand.json discovery, or revocation-list polling — those require live endpoints and belong in integration suites.

## File layout

```
test-vectors/request-signing/
├── README.md                             this file
├── keys.json                             test keypairs (Ed25519 + ES256) in JWK format with adcp_use values
├── canonicalization.json                 pure URL-canonicalization cases (no crypto) — every rule from the @target-uri algorithm + malformed-authority rejections
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
│   ├── 018-digest-covered-when-forbidden.json → request_signature_components_unexpected (step 6; policy 'forbidden')
│   ├── 019-signature-without-signature-input.json → request_signature_header_malformed (pre-check; downgrade loophole)
│   ├── 020-rate-abuse.json               → request_signature_rate_abuse (step 9a cap; abuse signal)
│   ├── 021-duplicate-signature-input-label.json → request_signature_header_malformed (step 1; RFC 8941 dict duplicate-key)
│   ├── 022-multi-valued-content-type.json → request_signature_header_malformed (step 1; covered non-list field must be single-valued)
│   ├── 023-multi-valued-content-digest.json → request_signature_header_malformed (step 1; RFC 9530 dict duplicate algorithm)
│   ├── 024-unquoted-string-param.json     → request_signature_header_malformed (step 1; RFC 8941 §3.3 string values must be quoted)
│   ├── 025-jwk-alg-crv-mismatch.json      → request_signature_key_purpose_invalid (step 8; alg=EdDSA with crv=P-256 is impossible per RFC 8037)
│   ├── 026-non-ascii-host.json            → request_signature_header_malformed (step 1; raw IDN U-label on wire; MUST be A-label)
│   └── 027-webhook-registration-authentication-unsigned.json → request_signature_required (webhook-reg with push_notification_config.authentication over bearer on a seller supporting signing; operation NOT in required_for)
└── positive/                             vectors that MUST verify successfully
    ├── 001-basic-post.json                   Ed25519, no content-digest
    ├── 002-post-with-content-digest.json     Ed25519, content-digest covered
    ├── 003-es256-post.json                   ES256, no content-digest
    ├── 004-multiple-signature-labels.json    Two Signature-Input labels; verifier processes sig1 only
    ├── 005-default-port-stripped.json        URL has :443; canonical strips it
    ├── 006-dot-segment-path.json             Path has /./; canonical collapses it
    ├── 007-query-byte-preserved.json         Query b=2&a=1&c=3 — preserved, not alphabetized
    ├── 008-percent-encoded-path.json         Path has lowercase %xx; canonical uppercases
    ├── 009-percent-encoded-unreserved-decoded.json  Path has %7E/%2D/%5F/%2E; canonical decodes unreserved per RFC 3986 §6.2.2.2
    ├── 010-percent-encoded-slash-preserved.json     Path has %2F (reserved); stays percent-encoded, not treated as segment separator
    ├── 011-ipv6-authority.json                       IPv6 literal host; brackets preserved in @target-uri and @authority
    └── 012-ipv6-authority-default-port-stripped.json IPv6 literal with :443; port stripped, brackets preserved
```

## Canonicalization vectors (`canonicalization.json`)

`canonicalization.json` is a flat set of URL-canonicalization cases that exercise every rule in the `@target-uri` canonicalization algorithm, plus the malformed-authority rejection cases. Independent of cryptographic signing — an SDK can run this file without keys, crypto, or a full verifier harness, which makes it the fastest way to surface cross-implementation divergence.

Shape:

```json
{
  "spec_reference": "#adcp-rfc-9421-profile",
  "cases": [
    {
      "name": "ipv6-host-hex-lowercased",
      "rule": "step 2: IPv6 brackets preserved; hex digits inside lowercased",
      "input_url": "https://[2001:DB8::1]/p",
      "expected_target_uri": "https://[2001:db8::1]/p",
      "expected_authority": "[2001:db8::1]"
    },
    {
      "name": "malformed-port-without-host",
      "rule": "step 3: authority with port but no host is malformed",
      "input_url": "https://:443/p",
      "reject": true,
      "reject_reason": "authority missing host",
      "expected_error_code": "request_signature_header_malformed"
    }
  ]
}
```

For each case:

- **Positive case** (no `reject` field): the implementation MUST canonicalize `input_url` and produce byte-for-byte matches on `expected_target_uri` and `expected_authority`. Each case also carries a `rule` string pointing to the specific numbered step in the canonicalization algorithm it exercises — useful when a test fails and you want to know which rule the implementation got wrong.
- **Reject case** (`reject: true`): the implementation MUST refuse to canonicalize `input_url`. Signers refuse to sign; verifiers reject with `expected_error_code`.

SDKs SHOULD run `canonicalization.json` on every commit alongside a lint pass. Canonicalization divergence is the #1 silent 9421 interop bug, and catching it as a fast unit test (cheap, no network, no crypto) closes that gap.

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
- **`test_harness_state`** — optional. Preloads verifier state BEFORE invoking verification. Harness implementations translate each sub-key into the appropriate concrete preload for their verifier under test. Supported sub-keys:
  - `replay_cache_entries` — list of `{ keyid, nonce, ttl_seconds }` to preload into the per-`(keyid, nonce)` replay cache. Used by `016-replayed-nonce.json` to assert the nonce-dedup check at step 12.
  - `replay_cache_per_keyid_cap_hit` — object `{ keyid }` signalling the per-keyid entry cap is hit for the named key. Used by `020-rate-abuse.json` to assert the cap check at step 9a. The harness MAY simulate by populating the cache with N placeholder entries (where N equals the verifier's configured cap) or by setting an implementation-private flag — what the vector asserts is the rejection behavior when the cap is hit, not the mechanism of reaching it.
  - `revocation_list` — full signed-revocation-list object to preload as the current freshness snapshot. Used by `017-key-revoked.json` to assert the revocation check at step 9.
- **`expected_signature_base`** — present on positive vectors and on `015-signature-invalid.json`. The canonical signature base string per RFC 9421 §2.5. Shape specifics that implementers get wrong: **lines are joined with a single `\n`** (LF, not CRLF); **there is no trailing newline** after the final `@signature-params` line; **components appear in the exact order listed in `Signature-Input`**, followed by `@signature-params` as the last line. The JSON string uses `\n` escapes which parse to real newline bytes at load time. Implementers can diff their computed base against this field BEFORE worrying about signatures — canonicalization disagreements are the #1 source of 9421 interop bugs, and checking the base is how you catch them.
- **`expected_outcome.success`** — `true` for positive vectors, `false` for negative.
- **`expected_outcome.error_code`** — stable code from the [transport error taxonomy](https://adcontextprotocol.org/docs/building/implementation/security#transport-error-taxonomy). Conformance requires **byte-for-byte match** on this code. Negative vectors only.
- **`expected_outcome.failed_step`** — which step of the verifier checklist the rejection occurs at. Integer for numbered steps (`1`–`13`), or a string for lettered sub-steps (e.g. `"9a"` for the per-keyid cap check). Informational only — an implementation that rejects with the correct error code is conformant even if its internal step numbering differs. An implementation that rejects with a DIFFERENT error code is non-conformant (see [Conformance expectations](#conformance-expectations)). Negative vectors only.
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

**Cross-implementation commitment check.** Before relying on the shipped signatures, SDK implementers SHOULD independently compute the signature base from the vector inputs (method, URL, headers, body, covered-components list, sig-params) and compare byte-for-byte against `expected_signature_base` in each positive vector. If all three reference SDKs (TypeScript, Go, Python — see adcp#2323 for tracking issues) agree with the committed base, confidence that the committed `Signature` values are canonical is high. If any disagrees, escalate to the spec repo BEFORE the SDK consumes the signatures — locking a canonicalization bug into the committed signatures would be the worst outcome, because every subsequent verifier would inherit it. The `expected_signature_base` field exists specifically to make this check byte-level and implementation-independent.

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

### Recommended run order

Run vectors in this order when validating a new implementation — it isolates failure categories so a bug surfaces cleanly instead of as a pile of unrelated red tests:

1. **Positive vectors first** (`positive/001`, `/002`, `/003`). These exercise the happy path. If `001` fails, your signer or verifier's canonicalization, key loading, or crypto is wrong — fix before touching anything else. The `expected_signature_base` field in each positive vector lets you diff YOUR canonical base against the spec's, independent of whether your crypto works.
2. **Parse-level negatives next** (`001`, `002`, `011`, `012`, `014`, `019`). These fail at the pre-check or early checklist steps without invoking crypto. Passing these means your header parsing and presence checks are correct.
3. **Semantic negatives** (`003`, `004`, `005`, `006`, `007`, `013`, `018`). These exercise specific rules (window, alg allowlist, covered components, content-digest policy) without requiring valid signatures.
4. **Key-path negatives** (`008`, `009`). JWKS resolution + `adcp_use` enforcement.
5. **Stateful pre-crypto negatives** (`017`, `020`). These require preloaded harness state and reject before crypto verify — `017` on revocation (step 9), `020` on the per-keyid cap (step 9a). The committed `Signature` on these vectors is a placeholder and is NOT expected to verify cryptographically; the rejection MUST land on the pre-crypto cheap check.
6. **Crypto / stateful-post negatives last** (`015`, `010`, `016`). These require the verifier to have run most of the checklist before reaching the failure point. `015` specifically catches canonicalization bugs where your implementation computes a different signature base than the spec — if you pass `positive/001` but fail `015`, your canonicalization is still off somewhere and `015` is picking it up.

## Adding vectors

Every new vector MUST:

1. Cite a specific normative requirement in `security.mdx`.
2. Identify the verifier-checklist step it exercises (or the pre-check).
3. Use only keypairs from `keys.json`, OR supply a documented `jwks_override` explaining why a non-canonical key shape is required.
4. Include `expected_signature_base` for positive vectors and for step-10 `request_signature_invalid` catchers.
5. Include `test_harness_state` for any vector that requires preloaded verifier state.
