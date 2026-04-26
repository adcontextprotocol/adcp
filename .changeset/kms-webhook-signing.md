---
---

feat(training-agent): GCP KMS-backed webhook signing

Routes the training-agent's outbound webhook signing through a GCP KMS
`SigningProvider` (added in `@adcp/client@5.21.0` per #1020 / PR
adcp-client#1021). Private webhook-signing key material no longer enters
process memory in production.

AdCP requires distinct key material per signing purpose
(`docs/guides/SIGNING-GUIDE.md` § Key separation), so this lands a second
KMS cryptoKeyVersion separate from the request-signing key. New Fly secret:
`GCP_KMS_WEBHOOK_KEY_VERSION` pointing at the webhook cryptoKeyVersion path.
The shared `GCP_SA_JSON` covers IAM for both.

Refactors `server/src/security/gcp-kms-signer.ts` into a factory pattern
with two named exports — `getRequestSigningProvider()` and
`getWebhookSigningProvider()` — sharing init / tripwire / lazy-singleton /
in-flight-dedup logic.

`server/src/security/expected-public-key.ts` now exports both committed
PEMs and KIDs (`aao-signing-2026-04` for requests, `aao-webhook-2026-04`
for webhooks). The published JWKS at `/.well-known/jwks.json` advertises
both keys with their respective `adcp_use` values; receivers enforce
purpose at that field.

Dev fallback unchanged: when `GCP_KMS_WEBHOOK_KEY_VERSION` is unset,
`webhooks.ts` still loads `WEBHOOK_SIGNING_KEY_JWK` (stable JWK env) or
generates an ephemeral key.

Bumps `@adcp/client` 5.20.0 → 5.21.0.
