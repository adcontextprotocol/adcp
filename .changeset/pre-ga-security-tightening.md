---
"adcontextprotocol": minor
---

Security hardening for 3.0 — two normative SHOULD → MUST tightenings landing in the pre-GA window:

- **Idempotency cache insert-rate limits are MUST (closes #2559).** Sellers MUST apply per-`(authenticated_agent, account)` insert-rate limits on the idempotency cache (separate from request rate limits) and MUST return `RATE_LIMITED` with `retry_after` when the configured ceiling is crossed. Recommended first-deployment ceiling: 60 inserts/sec sustained per agent (3,600/min), with burst to 300/sec over rolling 10-second windows. Sizing aligns with existing replay-cache caps (100k per-keyid webhook, 1M per-keyid request). Closes a nonce-flood DoS amplification vector. Sellers MUST expose the ceiling as a tunable configuration parameter.

- **Webhook-registration 9421-signing is MUST for signing-capable sellers (closes #2557).** Sellers that support request signing MUST reject webhook-registration requests carrying `push_notification_config.authentication` over bearer-only transport, with `request_signature_required`. Structural defense against on-path mutators injecting or stripping the `authentication` block during onboarding. Affects conditionally-signing sellers that accept bearer for registration today; fully unsigned-only and fully signing-required sellers are unaffected.

- **Conformance**: new negative test vector `027-webhook-registration-authentication-unsigned.json`. Runtime idempotency rate-limit grading requires a burst-runner test-kit contract that does not exist yet; pre-GA coverage is spec-MUST + implementer attestation via narrative in `universal/idempotency.yaml`.
