# Web Bot Auth profile conformance vectors

Test vectors for the proposed AdCP profile of Web Bot Auth (WBA) for request and webhook signing. The profile is proposed for AdCP 3.3 in [RFC #7878](https://github.com/adcontextprotocol/adcp/issues/7878) and is published alongside the AdCP RFC 9421 request-signing profile. These fixtures let a signer written with one WBA or RFC 9421 library and a verifier written with another agree on the wire format and on what a verifier rejects.

Specification: [Web Bot Auth request-signing profile](https://adcontextprotocol.org/docs/building/by-layer/L1/wba-profile) in `docs/building/by-layer/L1/wba-profile.mdx`. Section numbers in vector comments refer to [draft-ietf-webbotauth-httpsig-protocol-00](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/00/) unless they name RFC 9421.

**Canonical URLs.** These vectors are served at `https://adcontextprotocol.org/compliance/{version}/test-vectors/wba-profile/`, with `{version}` either an immutable release or `latest`. Tree preserved: `keys.json`, `positive/*.json`, and `negative/*.json` are all resolvable.

## Test keys are public

`keys.json` publishes the private seed of every test key in `_private_d_for_test_only`, so implementations can reproduce every signature. Each seed is SHA-256 of the ASCII string `rfc004-test/<seed_name>`, used as the Ed25519 private key. Each `kid` is the key's JWK thumbprint (RFC 7638; RFC 8037 Appendix A.3 for Ed25519), and each entry's `identity` is the origin whose key directory publishes the key.

**These keys are valid only for grading against this suite.** WBA section 6.8: test keys "MUST NOT be used in production", and verifiers SHOULD reject them when detected. A production verifier that accepts a directory containing `6WsKMCObba49V3uN0vIENnk1BKAk7c9zjBJcWKyQ9_I`, `hHurKlVBnPJ4AGiPyl6HWMhxgkIcRBzaC8qWwEtnuVI`, or `ZtaFf5jj-EzorJmZn6mX3YnmK_QyZKVLbbinzIQKOjQ` is exploitable.

The domains in the vectors (`buyer-7k3q.com`, `agent.brand-7k3q.com`, `relay.agency-7k3q.com`, `seller-7k3q.com`) are placeholders that resolve to nothing. A harness serves each directory from the vector's `directories` object instead of fetching it.

## Scope

The vectors exercise the profile rules: the covered `Signature-Agent` member, key selection by thumbprint from the directory the member names, the required `nonce`, replay rejection, several signatures on one request with each later signature covering the earlier ones, the signed directory response, and the `400` and `403` responses. They do not exercise live directory fetches, revocation-list polling, or onboarding state, which need live endpoints and belong in integration suites.

## File layout

```
test-vectors/wba-profile/
├── README.md                                      this file
├── keys.json                                      three Ed25519 test keys, one per identity, with private seeds
├── positive/                                      requests and responses that MUST verify
│   ├── 001-single-signer-request.json             buyer agent signs create_media_buy; one label
│   ├── 002-relay-request-two-signatures.json      brand agent signs, relay adds a signature covering the brand's members
│   └── 003-signed-directory-response.json         directory response signed per key (WBA Appendix B.1)
└── negative/                                      requests a verifier MUST reject, with the expected status
    ├── 001-missing-nonce.json                     → 403 with Accept-Signature (nonce required on every signed request)
    ├── 002-replayed-nonce.json                    → 403 with Accept-Signature carrying a fresh nonce (needs test_harness_state)
    ├── 003-signature-agent-not-covered.json       → 403 (Signature-Agent present but not a covered component)
    ├── 004-relay-omits-inner-signature.json       → 403 (second signature does not cover the first signer's members)
    ├── 005-relay-inner-signature-altered.json     → 403 (brand signature changed after the relay signed over it)
    ├── 006-key-not-in-named-directory.json        → 403 (key is published by an origin other than the one named)
    └── 007-malformed-signature-agent.json         → 400 (Signature-Agent does not parse)
```

## Vector format

Every request vector has this shape:

```json
{
  "name": "human-readable description",
  "spec_reference": "docs/building/by-layer/L1/wba-profile.mdx#anchor",
  "signing_profile": "web-bot-auth",
  "reference_now": 1790841610,
  "request": {
    "method": "POST",
    "url": "https://seller-7k3q.com/mcp/",
    "headers": {
      "Content-Type": "application/json",
      "Content-Digest": "sha-256=:...:",
      "Signature-Agent": "sig1=\"https://buyer-7k3q.com\"",
      "Signature-Input": "sig1=(...);created=...;expires=...;nonce=\"...\";keyid=\"...\";alg=\"ed25519\";tag=\"web-bot-auth\"",
      "Signature": "sig1=:...:"
    },
    "body": "{...}"
  },
  "directories": {
    "https://buyer-7k3q.com": { "keys_ref": ["6WsKMCObba49V3uN0vIENnk1BKAk7c9zjBJcWKyQ9_I"] }
  },
  "test_harness_state": {
    "replay_cache_entries": [{ "identity": "https://buyer-7k3q.com", "nonce": "...", "ttl_seconds": 360 }]
  },
  "expected_signature_base": { "sig1": "\"@method\": POST\n..." },
  "expected_outcome": {
    "success": false,
    "status": 403,
    "accept_signature": {
      "label": "sig1",
      "components": "(\"@method\" \"@target-uri\" \"@authority\" \"content-type\" \"content-digest\" \"signature-agent\";key=\"sig1\")",
      "parameters": ["created", "expires", "nonce", "keyid", "tag"],
      "tag": "web-bot-auth"
    },
    "reason": "..."
  },
  "$comment": "free-form notes"
}
```

### Fields

- **`name`**: one-line description.
- **`spec_reference`**: the section of `wba-profile.mdx` the vector grades.
- **`signing_profile`**: always `web-bot-auth`. A verifier selects these vectors by this value and never grades them as AdCP RFC 9421 profile cases.
- **`reference_now`**: Unix seconds. Inject this as the verifier's wall clock instead of using the real time.
- **`request`**: the raw HTTP request the verifier receives. Header names are case-insensitive; `body` is the exact byte string on the wire. Binary header values use RFC 8941 `sf-binary` (standard Base64 with padding).
- **`response`**: present on the directory-response vector only. The response the directory server sends to `request`, with `status`, `headers`, and the exact `body`.
- **`directories`**: the key directory each origin serves, as a list of `kid` values from `keys.json`. The harness answers a fetch of `<origin>/.well-known/http-message-signatures-directory` with a JWK Set holding exactly those keys. An origin absent from the object serves no directory. Several vectors list more than one origin so that a harness can show the trap the vector guards against (see `006-key-not-in-named-directory`).
- **`test_harness_state`**: optional. Preloads verifier state before verification. `replay_cache_entries` lists `{ identity, nonce, ttl_seconds }` pairs the verifier has already accepted. Reset verifier state before every vector.
- **`expected_signature_base`**: per label, the signature base per RFC 9421 section 2.5. Lines are joined with a single `\n`, there is no trailing newline, and components appear in the order listed in `Signature-Input`, followed by `@signature-params`. The base is the one a verifier computes from the request as sent, so on `005-relay-inner-signature-altered` it carries the altered brand signature that the relay's signature then fails over. Diff your computed base against this field before looking at signatures.
- **`expected_outcome.success`**: `true` for positive vectors, `false` for negative.
- **`expected_outcome.identities`**: positive vectors only. Per label, the origin the verifier attributes the signature to.
- **`expected_outcome.status`**: negative vectors only. The HTTP status the verifier answers: `400` when the signature headers do not parse, `403` when a signature or the profile's checks fail. Conformance requires this status.
- **`expected_outcome.accept_signature`**: negative vectors with `403` only. The `Accept-Signature` member the verifier sends (RFC 9421 section 5.1): the label, the covered components, and the parameters the profile requires. `"nonce": "verifier-chosen"` marks the replay case, where the verifier supplies a fresh nonce value that this vector does not pin. The exact serialization is RFC 9421 section 5.1; conformance grades the status, and a harness MAY check that `Accept-Signature` names at least these components and parameters.
- **`expected_outcome.reason`**: the profile rule the request breaks. Informational.
- **`$comment`**: free-form notes, including which non-conformant verifier behavior the vector catches.

## Conformance expectations

An implementation is conformant when, for every vector:

1. **Positive request vectors** verify every `web-bot-auth` label and attribute each to the origin in `expected_outcome.identities`.
2. **The directory-response vector** verifies the response signature with the key the directory body provides and matches `Content-Digest` against the body.
3. **Negative vectors** answer `expected_outcome.status`. A `403` carries `Accept-Signature`.
4. **Signature bytes on positive vectors** match the committed `Signature` values byte for byte when the implementation signs the committed `expected_signature_base` with the corresponding private seed. Ed25519 is deterministic.

Several negative vectors carry cryptographically valid signatures on purpose. `001-missing-nonce`, `003-signature-agent-not-covered`, and `004-relay-omits-inner-signature` verify once the targeted check is removed, and `006-key-not-in-named-directory` verifies under a verifier that looks keys up by thumbprint alone. A verifier that accepts any of them has skipped a profile rule, not failed at cryptography.

## Running vectors against an implementation

1. Parse each vector.
2. Build the verifier's directory store from `directories`, keyed by origin, selecting entries from `keys.json`.
3. Preload `test_harness_state` into the verifier, then reset it before the next vector.
4. Build the request from `request`, and invoke verification with `reference_now` as the wall clock.
5. Assert on `expected_outcome`: identities for positive vectors, status for negative vectors.

Run the positive vectors first. If `positive/001` fails, the signature base, key loading, or thumbprint computation is wrong; the `expected_signature_base` field isolates the first of those. Then run `007` (parse), `001` and `003` (profile rules without state), `006` (key lookup), `004` and `005` (relay chain), and `002` (replay state) last.

## Generating the vectors

`scripts/generate-wba-profile-vectors.mjs` writes every file in this directory except this README. It derives the keys from their seeds, builds each signature base component by component, and signs it with Ed25519. Run `node scripts/generate-wba-profile-vectors.mjs --check` to confirm the committed files match the generator. The positive values are the ones in RFC #7878's illustrations. Do not hand-edit the vector files; change the generator and run it again.

`tests/wba-profile-vectors.test.cjs` verifies the vectors without sharing code with the generator. It parses the headers, rebuilds each signature base from the request, and checks signatures and digests with `node:crypto`. For each negative vector it asserts the expected status and the check that fails. For each negative vector with a valid signature, it asserts that the request verifies once that one check is skipped. `npm run test:wba-profile-vectors` runs both. The positive vectors were also verified with a generic RFC 9421 library ([`http-message-sig`](https://www.npmjs.com/package/http-message-sig)) and, for the single-signer request, with Cloudflare's [`web-bot-auth`](https://www.npmjs.com/package/web-bot-auth) library.

## Adding vectors

Every added vector MUST:

1. Cite the section of `wba-profile.mdx` it grades in `spec_reference`.
2. Use only keys from `keys.json`, and list every directory the verifier may consult in `directories`.
3. State `expected_outcome.status` for a negative vector in the profile's status-code vocabulary, and `accept_signature` for a `403`.
4. Include `expected_signature_base` for every label when the signature headers parse, computed from the request as sent.
5. Include `test_harness_state` when the vector needs preloaded verifier state.
6. Come from `scripts/generate-wba-profile-vectors.mjs`. A negative vector also needs an entry in `TARGETS` in `tests/wba-profile-vectors.test.cjs`, naming the check it targets.
