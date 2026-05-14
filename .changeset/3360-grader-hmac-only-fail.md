---
"adcontextprotocol": minor
---

Grader: webhook-emission universal now fails agents that haven't published a 9421 webhook-signing JWKS at their `brand.json` `agents[].jwks_uri`. The `signature_validity` phase is required (no longer `optional` / `skip_if hmac_legacy`), and a new `signing_keys_published` precheck phase asserts the JWKS contains a key with `adcp_use: "webhook-signing"` before the signature phase runs. Closes the on-ramp loophole that previously let agents self-declare themselves out of webhook signing via `webhook_auth_mode == 'hmac_legacy'`. Operationalizes the "no new HMAC implementers after date X" enforcement from the RFC 9421 migration plan (#4205).

New error codes on `signing_keys_published`: `webhook_signing_keys_unpublished` (no JWKS or empty), `webhook_signing_keys_wrong_purpose` (JWKS present but no key with `adcp_use: "webhook-signing"`), `webhook_signing_keys_all_revoked` (all webhook-signing keys revoked).

Refs #3360, #4205.
