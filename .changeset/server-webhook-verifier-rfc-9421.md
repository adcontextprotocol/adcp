---
---

server(adcp-security): add RFC 9421 AdCP webhook-signature verifier.

New module `server/src/adcp-security/webhook-verifier.ts` that verifies the
`Signature` / `Signature-Input` / `Content-Digest` trio on incoming webhook
requests against a caller-supplied JWKS. Supports `ed25519` and
`ecdsa-p256-sha256` (IEEE P1363 r||s, converted to DER for node:crypto).
Uses `timingSafeEqual` for the content-digest compare, rejects JOSE
algorithm names (`EdDSA`, `ES256`) in the `Signature-Input` `alg`
parameter, returns typed `webhook_signature_*` / `webhook_content_digest_*`
error codes, and surfaces the `tag` parameter on success so call sites can
enforce `tag === 'adcp/webhook-signing/v1'`.

Not yet wired into any request handler — JWKS fetching, nonce-replay
caching, revocation-list, and `adcp_use`/`tag` enforcement remain caller
responsibilities.
