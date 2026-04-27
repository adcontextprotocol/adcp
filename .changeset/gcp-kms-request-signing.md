---
---

feat(addie): GCP KMS-backed Ed25519 signing for outbound AdCP requests

Addie's outbound AdCP calls (`AdCPClient.executeTask`) now attach an RFC 9421
request-signing block backed by a GCP KMS Ed25519 key when `GCP_SA_JSON` and
`GCP_KMS_KEY_VERSION` are set. Private key material never enters process
memory; signing routes through the `SigningProvider` interface added in
`@adcp/client@5.20.0`.

Verifiers fetch the public key from `${BASE_URL}/.well-known/jwks.json`
(kid: `aao-signing-2026-04`). The committed `expected-public-key.ts` is the
single source of truth for both the published JWKS and the boot-time
tripwire that asserts the KMS-returned public key matches the repo —
silent key swaps in GCP fail loudly rather than producing signatures
verifiers reject.

Webhook signing in the training agent still uses an in-process JWK; lifting
that to KMS is a follow-up that needs a `SigningProvider` integration in
`@adcp/client`'s `createWebhookEmitter`.
