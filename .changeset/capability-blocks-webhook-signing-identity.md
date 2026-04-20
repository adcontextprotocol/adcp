---
"adcontextprotocol": patch
---

Add capability-discovery blocks so receivers can reason about operator posture at onboarding:

- `webhook_signing` (top-level): declares RFC 9421 outbound webhook-signing support, closed-enum profile id (`adcp-webhook-9421-v1`), permitted algorithms (`ed25519`, `ecdsa-p256-sha256`), and whether the agent falls back to HMAC-SHA256 on the deprecated `push_notification_config.authentication` path.
- `identity` (top-level): declares `per_principal_key_isolation`, `key_origins` (governance/request/webhook/TMP JWKS origin separation), and `compromise_notification` emit/accept posture. An empty `identity: {}` is schema-valid but advisory-neutral — receivers treat it as equivalent to omitting the block.
- `adcp.idempotency.account_id_is_opaque`: flag signaling that `account_id` is an HKDF-derived blind handle rather than the buyer's natural account key. Wire shape is unchanged, but buyer replay/retry/logging behavior MUST change when the flag is true. Migration: sellers already deriving opaque `account_id` without declaring this flag will be misclassified by new buyers as natural-key sellers until the flag is set.

Also fills the error-code enum for three governance/policy codes: `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `PERMISSION_DENIED`.
