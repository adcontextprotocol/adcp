---
---

Red-team batch 3 — privacy, governance, audit, and reference-server hardening:

- PII hashing: require HMAC-SHA-256 with per-seller ≥256-bit CSPRNG key (rotated ≥annually) for `hashed_email`/`hashed_phone`; negotiated via new `privacy.audience_hash_schemes` capability. Rewrote glossary/privacy-considerations/known-limitations to stop calling these "privacy-preserving" and correctly classify hashed PII as GDPR Art. 4(5) pseudonymous data.
- Structural privacy: close `additionalProperties` on `sync-audiences-request` match blocks (matches TMP pattern).
- Plan-hash binding: governance JWS now carries a `plan_hash` (SHA-256 of RFC 8785 JCS of the approved plan bytes); sellers recompute and MUST reject on mismatch (`PLAN_HASH_MISMATCH`).
- Price-affecting updates: `update_media_buy` now re-checks governance; surfaces `UPDATE_REQUIRES_GOVERNANCE` when the mutation crosses the approved envelope.
- Fragmentation defense: added `governance.aggregation_window_days` capability and normative "Aggregated-spend evaluation" section so sellers evaluate spend across related plans, not per-plan in isolation.
- WORM + GDPR erasure: documented crypto-erasure + tombstone pattern (per-subject KEK in KMS, AEAD envelope, chain covers ciphertext) so the audit log stays append-only while still complying with right-to-erasure.
- Error enum completeness: added `MODE_MISMATCH`, `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `PERMISSION_DENIED`, `PLAN_HASH_MISMATCH`, `UPDATE_REQUIRES_GOVERNANCE`; clarified `WEBHOOK_PAYLOAD_MISMATCH` is a log event, not a wire error.
- Reference-server RFC 9421 webhook verifier: new `server/src/adcp-security/webhook-verifier.ts` using `http-message-signatures` with Ed25519 + ECDSA-P256-SHA256 (P1363→DER), content-digest check, structured-header parsing, and typed error codes; 10/10 vitest cases pass.
- Batch-2 self-fixes: removed dead/broken `validateKeyEntropy` (false-rejected real UUIDv4s, zero callers); restored `$ref` to `auth-scheme.json` in `push-notification-config` (reversed inline-enum fragmentation); added `webhook_signing` + `identity` capability blocks and `adcp.idempotency.account_id_is_opaque` to `get-adcp-capabilities-response` so prose-only capabilities are now schema-advertised.
