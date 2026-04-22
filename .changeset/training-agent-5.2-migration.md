---
---

Training agent: migrate to @adcp/client 5.2.0.

- Replace the hand-rolled idempotency module with `createIdempotencyStore`
  (JCS canonical hashing, atomic `putIfAbsent` claim, ±60s skew TTL,
  Postgres + in-memory backends). Keep the `MUTATING_TOOLS` drift guard
  and the account-partitioning `scopedPrincipal` composition, since the
  SDK's `resolveIdempotencyPrincipal` hook accepts that exact shape.
- Replace the bespoke bearer-token middleware with
  `verifyApiKey` + `anyOf`, routing WorkOS validation through the
  `verify` callback and returning RFC 6750-compliant 401s via
  `respondUnauthorized`.
- Wire `createWebhookEmitter` with an Ed25519 signing key (env
  `WEBHOOK_SIGNING_KEY_JWK`, else ephemeral). Publish the public JWKS at
  `/.well-known/jwks.json`. Dispatch fires a signed completion webhook
  whenever a mutating tool's request carries
  `push_notification_config.url`.
- New migration `416_adcp_idempotency.sql` + periodic
  `cleanupExpiredIdempotency` cleanup.
- Rename `ComplianceIndex.domains` → `protocols` consumer in
  `member-tools.ts` to match the 5.2 cache layout.
