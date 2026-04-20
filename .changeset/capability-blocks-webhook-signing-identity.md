---
"adcontextprotocol": patch
---

Add capability-discovery blocks so receivers can reason about operator posture at onboarding:

- `webhook_signing` (top-level): declares RFC 9421 outbound webhook-signing support, profile id, permitted algorithms (`ed25519`, `ecdsa-p256-sha256`), and whether the agent falls back to HMAC-SHA256 on the deprecated `push_notification_config.authentication` path.
- `identity` (top-level): declares `per_principal_key_isolation`, `key_origins` (governance/request/webhook/TMP JWKS origin separation), and `compromise_notification` emit/accept posture.
- `adcp.idempotency.account_id_is_opaque`: advisory flag signaling that `account_id` is an HKDF-derived blind handle rather than the buyer's natural account key.

Also fills the error-code enum for three governance/policy codes: `CAMPAIGN_SUSPENDED`, `GOVERNANCE_UNAVAILABLE`, `PERMISSION_DENIED`.
