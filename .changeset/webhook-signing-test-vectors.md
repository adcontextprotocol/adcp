---
"adcontextprotocol": minor
---

Ship RFC 9421 webhook-signing conformance test vectors.

Static canonical signed webhook payloads at `static/compliance/source/test-vectors/webhook-signing/`, parallel to the request-signing vectors shipped in #2323. Covers the receiver side: deterministic positive and negative vectors a webhook-verifier library can validate against, independent of any live publisher.

- `keys.json` — four test keypairs. Two working verifier keys (Ed25519 + ES256) with `adcp_use: "webhook-signing"`. One request-signing key (`adcp_use: "request-signing"`) to exercise cross-purpose rejection at verifier checklist step 8. One dedicated revoked key for vector 017. Private components publish in `_private_d_for_test_only` so SDKs can exercise both signer and verifier roles.
- `positive/` — 6 vectors covering Ed25519 and ES256 happy paths, multiple `Signature-Input` labels (verifier processes `sig1` only), default-port stripping, percent-encoded path normalization, query-byte preservation. All pass against a conformant verifier.
- `negative/` — 18 vectors, one per `webhook_signature_*` error code in the webhook-callbacks verifier checklist: `tag_invalid`, `window_invalid` (3 variants: expired, window-too-long, expires≤created), `alg_not_allowed`, `components_incomplete` (2 variants: missing `@authority`, missing `content-digest` — REQUIRED on webhooks), `key_unknown`, `key_purpose_invalid` (adcp_use mismatch), `digest_mismatch`, `header_malformed` (2 variants: malformed Signature-Input, Signature without Signature-Input), `params_incomplete` (2 variants: missing expires, missing nonce), `invalid` (corrupted signature bytes), `replayed`, `key_revoked`, and `rate_abuse`. The last three carry `requires_contract: "webhook_receiver_runner"` + `test_harness_state` for runner-coordinated preconditions.
- `README.md` — scope, file layout, vector shape, usage patterns, cross-reference to the webhook-callbacks spec section and the `webhook-emission` universal.

**Relationship to other surfaces:**
- `@target-uri` canonicalization is identical to request signing. Vectors reference `test-vectors/request-signing/canonicalization.json` by pointer rather than duplicating.
- Vectors complement the `webhook-emission` universal (#2431). The universal grades live sender behavior; these vectors grade receiver libraries. Together they cover both halves of the webhook-signing conformance surface.

Vectors test verifiers deterministically — receiver libraries (e.g., `@adcp/client`'s forthcoming 9421 webhook verifier) can validate every `webhook_signature_*` rejection path in CI without needing a live publisher to produce malformed signatures on demand.
