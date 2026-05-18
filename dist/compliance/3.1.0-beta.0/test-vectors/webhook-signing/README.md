# AdCP Webhook Signing Conformance Vectors

Test vectors for the AdCP RFC 9421 webhook-signing profile. These fixtures drive cross-implementation conformance testing so a signer written in one SDK and a verifier written in another agree on the wire format of outbound push-notification webhooks.

Specification: [Webhook callbacks](https://adcontextprotocol.org/docs/building/implementation/security#webhook-callbacks) in `docs/building/implementation/security.mdx`.

**Canonical URLs.** These vectors are served at `https://adcontextprotocol.org/compliance/{version}/test-vectors/webhook-signing/`, with `{version}` being either a specific release (e.g. `3.0.0`) or `latest` (tracks the most recent GA). Tree preserved — `keys.json`, `negative/*.json`, `positive/*.json` all resolvable. SDKs SHOULD fetch from the versioned CDN path and record the version under test rather than requiring a checkout of the spec repo. Example: `https://adcontextprotocol.org/compliance/latest/test-vectors/webhook-signing/positive/001-basic-post.json`.

## ⚠️ Security — test keys are public

`keys.json` publishes the full private key material for every test keypair in the `_private_d_for_test_only` field so SDKs can exercise both signer and verifier roles against the same material. **Any production verifier that adds `test-ed25519-webhook-2026`, `test-es256-webhook-2026`, `test-wrong-purpose-2026`, or `test-revoked-webhook-2026` to its trust store is exploitable** — anyone who downloads `keys.json` can forge signatures under those kids. These keys are valid ONLY for grading against this conformance suite. Production signers MUST mint and publish their own keypairs under their own `jwks_uri`; production verifiers MUST NOT treat the test kids as trusted in any deployment exposed to live traffic.

## Scope

These vectors exercise the [webhook verifier checklist](https://adcontextprotocol.org/docs/building/implementation/security#verifier-checklist-for-webhooks) and the RFC 9421 profile constraints specific to webhooks: required covered components (content-digest is REQUIRED, no policy branch), the distinct `tag="adcp/webhook-signing/v1"`, the `adcp_use: "webhook-signing"` key-purpose discriminator, and the `webhook_signature_*` error taxonomy. They do not exercise live JWKS fetch, brand.json discovery, or revocation-list polling — those require live endpoints and belong in integration suites.

Vectors cover the receiver side (buyer verifying inbound webhooks). Sender-side grading — does the agent-under-test emit conformant signatures on live traffic — is handled by the [`webhook-emission` universal](https://adcontextprotocol.org/compliance/latest/universal/webhook-emission) via a runner that hosts a receiver during storyboard execution.

## Relationship to the request-signing vectors

Webhook signing reuses most of the RFC 9421 profile from request signing:

- **`@target-uri` canonicalization** is identical. The canonicalization cases live in [`test-vectors/request-signing/canonicalization.json`](../request-signing/canonicalization.json) and are not duplicated here — every rule an SDK verifies for request signing applies byte-for-byte to webhook signing.
- **Signature parameters** (`created`, `expires`, `nonce`, `keyid`, `alg`) share semantics with request signing. The only divergence is `tag`: webhooks MUST use `adcp/webhook-signing/v1`.
- **Binary value encoding** (`Signature`, `Content-Digest`) uses the same base64url-no-padding override as request signing.

The distinct surface is the purpose-discriminator chain: `adcp_use` MUST be `"webhook-signing"` on the verifying JWK, `tag` MUST be `"adcp/webhook-signing/v1"`, and `content-digest` MUST be covered (no `covers_content_digest: "forbidden"` opt-out — the body is the event).

## File layout

```
test-vectors/webhook-signing/
├── README.md                             this file
├── keys.json                             test keypairs (Ed25519 + ES256) with adcp_use: "webhook-signing",
│                                         plus a wrong-purpose key (adcp_use: "request-signing") for vector 008
│                                         and a revoked key for vector 017
├── negative/                             vectors that MUST fail verification
│   ├── 001-wrong-tag.json                → webhook_signature_tag_invalid (step 3; uses request-signing tag)
│   ├── 002-expired-signature.json        → webhook_signature_window_invalid (step 5; expired)
│   ├── 003-window-too-long.json          → webhook_signature_window_invalid (step 5; window > 300s)
│   ├── 004-alg-not-allowed.json          → webhook_signature_alg_not_allowed (step 4)
│   ├── 005-missing-authority-component.json → webhook_signature_components_incomplete (step 6; @authority missing)
│   ├── 006-missing-content-digest.json   → webhook_signature_components_incomplete (step 6; REQUIRED on webhooks)
│   ├── 007-unknown-keyid.json            → webhook_signature_key_unknown (step 7)
│   ├── 008-wrong-adcp-use.json           → webhook_signature_key_purpose_invalid (step 8; adcp_use=request-signing)
│   ├── 009-content-digest-mismatch.json  → webhook_signature_digest_mismatch (step 11)
│   ├── 010-malformed-signature-input.json → webhook_signature_header_malformed (step 1)
│   ├── 011-signature-without-input.json  → webhook_signature_header_malformed (step 1; bound pair broken, one header without the other)
│   ├── 012-missing-expires-param.json    → webhook_signature_params_incomplete (step 2)
│   ├── 013-expires-le-created.json       → webhook_signature_window_invalid (step 5; expires ≤ created)
│   ├── 014-missing-nonce-param.json      → webhook_signature_params_incomplete (step 2)
│   ├── 015-signature-invalid.json        → webhook_signature_invalid (step 10; signature bytes corrupted)
│   ├── 016-replayed-nonce.json           → webhook_signature_replayed (step 12; requires runner state)
│   ├── 017-key-revoked.json              → webhook_signature_key_revoked (step 9; requires runner state)
│   ├── 018-rate-abuse.json               → webhook_signature_rate_abuse (step 9a; requires runner state)
│   ├── 019-revocation-stale.json         → webhook_signature_revocation_stale (step 9; requires runner state)
│   ├── 020-key-ops-missing-verify.json   → webhook_signature_key_purpose_invalid (step 8; key_ops lacks "verify")
│   └── 021-base64-alphabet-mixing.json   → webhook_signature_header_malformed (step 1; Signature token mixes base64url and standard-base64 chars)
└── positive/                             vectors that MUST verify successfully
    ├── 001-basic-post.json                   Ed25519, all five required components covered
    ├── 002-es256-post.json                   ES256, all five required components covered
    ├── 003-multiple-signature-labels.json    Two Signature-Input labels; verifier processes the label named `sig1`
    ├── 004-default-port-stripped.json        URL has :443; canonical strips it before signing
    ├── 005-percent-encoded-path.json         Path has lowercase %xx; canonical uppercases
    ├── 006-query-byte-preserved.json         Query b=2&a=1&c=3 — preserved byte-for-byte, not alphabetized
    └── 007-body-without-idempotency-key.json Body omits idempotency_key; signature still verifies (schema vs. signature separation)
```

## Vector shape

Each vector is a JSON object with these fields:

```json
{
  "name": "human-readable summary",
  "spec_reference": "#section-anchor in security.mdx",
  "reference_now": 1776520800,
  "request": {
    "method": "POST",
    "url": "https://buyer.example.com/adcp/webhook/...",
    "headers": {
      "Content-Type": "application/json",
      "Content-Digest": "sha-256=:...:",
      "Signature-Input": "sig1=(...);created=...;expires=...;nonce=...;keyid=...;alg=...;tag=\"adcp/webhook-signing/v1\"",
      "Signature": "sig1=:<base64url-unpadded>:"
    },
    "body": "{\"idempotency_key\":\"...\",\"task_id\":\"...\",\"status\":\"completed\"}"
  },
  "jwks_ref": ["test-ed25519-webhook-2026"],
  "expected_signature_base": "...\\n@signature-params: ...",
  "expected_outcome": { "success": true }
  // Negative vectors instead carry:
  // "expected_outcome": { "success": false, "error_code": "webhook_signature_<...>", "failed_step": <n> }
}
```

### `reference_now`

Fixed Unix-seconds timestamp representing "now" at vector construction time (2026-04-18T10:00:00Z). Verifiers running the vectors SHOULD stub their clock to this value so `window_invalid` checks are deterministic across time zones and machines.

**Units**: Unix **seconds**, not milliseconds. Verifiers whose internal clocks are in milliseconds MUST divide by 1000 before comparing to `created`/`expires` sig-params. Using a millisecond value directly would make every signature appear ~1000× in the past and trip `window_invalid`.

### `jwks_ref`

Array of `kid` values the vector expects in the signer JWKS. Verifiers load `keys.json`, filter to the listed `kid`s, and present that subset to their verifier under test. Not all keys in `keys.json` are in every vector's JWKS — for example, vector 008 references only `test-wrong-purpose-2026`, which causes step 8 to reject.

### `expected_signature_base`

The RFC 9421 §2.5 canonical signature base the signer produced. Verifiers computing their own base from the `request` fields and `Signature-Input` parameters MUST produce a byte-identical string. This is the fastest divergence signal for canonicalization bugs — if the base differs, the signature won't verify even if the crypto is correct.

### `expected_outcome`

Positive vectors: `{"success": true}`. Verifiers MUST accept the signature.

Negative vectors: `{"success": false, "error_code": "webhook_signature_<...>", "failed_step": <n>, "sub_step": "<letter>"?}`. Verifiers MUST reject the signature with the exact `error_code` byte-for-byte. The `failed_step` and `sub_step` fields are informational — grading is on the stable error code only. An implementation that rejects with the correct error code at a different checklist step number is conformant; the step order in the spec is a scaffolding for correctness, not a grading target.

- `failed_step` is always an **integer** (1–13).
- `sub_step` is optional and, when present, is a **string** letter (e.g., `"a"` for step 9a's per-keyid cap check). Vectors without a sub-step omit the field entirely rather than setting it to null.

### `test_harness_state`

Negative vectors that assert verifier state the vector cannot set from the outside (016, 017, 018, 019) carry `test_harness_state` describing the preconditions the runner MUST install before delivering the vector. Recognized shapes:

| Field | Type | Used by | Meaning |
|---|---|---|---|
| `replay_cache_entries` | `Array<{keyid, nonce}>` | 016-replayed-nonce | Entries the runner MUST preload into its (keyid, nonce) replay cache. Paired with `black_box_behavior: "deliver_twice"` for runners that provoke the replay by double-delivery instead. |
| `revoked_kids` | `string[]` | 017-key-revoked | Kids the runner MUST preload into the revocation list. |
| `per_keyid_cap_filled_for` | `string` | 018-rate-abuse | Kid whose per-keyid replay-cache cap the runner MUST fill to its grading target before delivering the vector. Paired with `black_box_behavior: "pre_fill_per_keyid_cap"`. |
| `revocation_list_stale_seconds` | `integer` | 019-revocation-stale | Simulated seconds since last successful revocation-list refresh. Runner MUST present this to the receiver as exceeding the `next_update + grace` window. Paired with `black_box_behavior: "simulate_stale_revocation_fetch"`. |

Runners that cannot install a declared harness-state primitive skip the affected vector as `not_applicable` — never as failed.

### `black_box_behavior`

State-dependent vectors (016, 017, 018, 019) declare a `black_box_behavior` string describing the runner-side action that provokes the assertion without white-box state injection. AdCP Verified grading runs black-box only. White-box harnesses MAY inject state directly (per the `test_harness_state` shape above) and skip the black-box step.

### `jwks_override` (vector 020 only)

Vector 020 tests that the verifier rejects JWKs whose `key_ops` lacks `"verify"`. The vector's signature itself is produced by a normally-configured key; the JWK presented to the verifier overrides `keys.json` with a mutated variant. Runners MUST substitute the keyid's entry with the `jwks_override[kid]` shape before resolving the signature. Field present only on vectors that need JWK mutation; most vectors present `keys.json` entries unchanged.

### `jwks_ref` semantics (positive vector 003)

Vector 003 includes two `Signature-Input` labels: the vector's own `sig1` and a decorative `relay` label. Verifiers MUST process the label named `sig1` specifically — not "the first label in the header," not "any label." The spec at [`#adcp-rfc-9421-profile`](https://adcontextprotocol.org/docs/building/implementation/security#adcp-rfc-9421-profile) says signers name the label `sig1` by convention, and verifiers key off the name rather than position. If an implementation picks a different label, the vector will fail even if that label's signature is individually valid.

### Signature validity vs. payload schema validation (positive vector 007)

Vector 007's body omits `idempotency_key`, which is required by the webhook payload schema per #2417. The 9421 signature still verifies cleanly because signature verification is a **transport-layer** check; payload schema validation is a **separate application-layer check** that fires after. A conformant receiver will:

1. Verify the signature (steps 1–13 of the webhook verifier checklist) → accept.
2. Validate the decoded payload against the webhook schema → reject for missing `idempotency_key`.

Step 2's rejection does NOT map to any `webhook_signature_*` code. Implementations that conflate the two and reject vector 007 at the signature layer are non-conformant. Implementations that accept vector 007 at the signature layer and separately reject the payload at schema validation are correctly splitting the concerns.

### `requires_contract` and `test_harness_state` (negative vectors only, when applicable)

Three negative vectors (016-replayed-nonce, 017-key-revoked, 018-rate-abuse) assert verifier state the vector cannot set from the outside. They carry:

- `requires_contract: "webhook_receiver_runner"` — signals that grading requires the webhook receiver contract at [`test-kits/webhook-receiver-runner.yaml`](https://adcontextprotocol.org/compliance/latest/test-kits/webhook-receiver-runner).
- `test_harness_state` — declares the preconditions (replay cache entries, revoked kids, per-keyid cap exhaustion) that the runner MUST install before delivering the vector.
- `black_box_behavior` (016 only) — runner delivers the vector twice within the replay window; receiver MUST accept the first and reject the second.

White-box harnesses MAY inject state directly and skip the runner coordination. AdCP Verified grading runs black-box only; see the test-kit contract for details.

## Using the vectors

### Positive phase

For each vector in `positive/`:

1. Load `keys.json` into your verifier's JWKS store, filtered to `vec.jwks_ref`.
2. Stub your clock to `vec.reference_now`.
3. Feed `vec.request` to your verifier as if the webhook had just arrived on the wire.
4. Assert the verifier accepts with `success: true`.

Sanity checks (optional but recommended):

- Compute your own canonical signature base from `vec.request` and compare to `vec.expected_signature_base` byte-for-byte.
- Compute your own `Content-Digest` from `vec.request.body` and compare to the header value.

### Negative phase

For each vector in `negative/`:

1. Same setup as the positive phase.
2. Apply any `test_harness_state` declared on the vector (revocation list entries, replay cache entries, per-keyid cap).
3. Feed `vec.request` to your verifier.
4. Assert the verifier rejects with `success: false` AND `error_code` equal to `vec.expected_outcome.error_code` byte-for-byte. The `failed_step` is not graded.

### Integration with `@adcp/client`

Receiver libraries built on top of `@adcp/client` SHOULD run these vectors in CI against the library's 9421 webhook verifier. The `webhook-emission` universal's live E2E grading complements but does not replace this — live grading exercises positive paths; static negative vectors are the only reliable path to cover every `webhook_signature_*` error code deterministically.

## Key material

All keys in `keys.json` are test-only. Private components ship publicly in the `_private_d_for_test_only` field so SDKs can run both signer and verifier roles against the same keypairs. Do not use these keys in production — production signers MUST generate and publish their own keypairs at their own `jwks_uri`.

The `test-revoked-webhook-2026` kid is a dedicated keypair for vector 017. Agents MUST NOT use this kid in production verifier revocation lists; it is scoped to grading runs via the runner contract.

## Generating the vectors

Vectors are generated by a script at `.context/generate-webhook-vectors.mjs` in the spec repo (gitignored — the script is not shipped). The script produces new keypairs and computes fresh signatures on each run, so the committed vectors are snapshot at generation time. Re-running the script would produce different keys and therefore different signatures; vectors are frozen once committed.

A verification script at `.context/verify-webhook-vectors.mjs` checks that all positive vectors actually verify against the published keys. Run it before committing any regeneration.

## Specification cross-reference

- Webhook callbacks profile: `docs/building/implementation/security.mdx#webhook-callbacks`
- Verifier checklist: `#verifier-checklist-for-webhooks`
- Error taxonomy: `#webhook-error-taxonomy`
- Replay dedup and sizing: `#webhook-replay-dedup-sizing`
- `@target-uri` canonicalization (shared with request signing): `#adcp-rfc-9421-profile`
