---
"adcontextprotocol": minor
---

Webhooks are signed with the agent's `request-signing` key — there is no separate webhook key purpose. The webhook verifier checklist (step 8) now requires `adcp_use == "request-signing"` (with the deprecated `"webhook-signing"` still accepted for backward compatibility, removed in 4.0). Operators that want separate key material for webhooks publish a second `"request-signing"` key with a distinct `kid` and sign webhooks with it — key isolation comes from the `kid`, not a distinct `adcp_use`. Any other key-purpose failure — `"response-signing"`/`"governance-signing"`, absent `adcp_use`, or a missing `verify` key_op — is rejected with `webhook_signature_key_purpose_invalid`. `webhook_mode_mismatch` is unchanged and remains reserved for the HMAC-vs-9421 auth-mode selector mismatch.

The relaxation is one-directional and safe: cross-protocol confusion is prevented by the RFC 9421 `tag` (`adcp/webhook-signing/v1`, part of the signed base, checked at step 3) and mandatory `content-digest` coverage — not by the key-purpose discriminator. A captured request signature carries `tag=adcp/request-signing/v1` and is rejected at step 3, so it can never be replayed as a webhook. The reverse remains forbidden: a webhook-signing key MUST NOT verify a request signature (request verification still requires `adcp_use == "request-signing"` exactly).

Conformance vectors updated: former negative `webhook-signing/negative/008-wrong-adcp-use` (request-signing key rejected) becomes positive `webhook-signing/positive/008-request-signing-key-reuse` (accepted); a new negative `008-wrong-adcp-use` covers a `response-signing` key, still rejected.
