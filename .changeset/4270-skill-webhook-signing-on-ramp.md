---
---

skills(call-adcp-agent): document RFC 9421 as the default webhook signing path

The five protocol skills (`adcp-media-buy`, `adcp-creative`, `adcp-signals`, `adcp-governance`, `adcp-si`, `adcp-brand`) all delegate cross-cutting buyer-side basics to `call-adcp-agent/SKILL.md`. That skill teaches `idempotency_key`, the `account` `oneOf`, `status:'submitted'` polling, and error recovery — but was silent on webhook signing, leaving SDK consumers with no signal that omitting `push_notification_config.authentication` selects the modern RFC 9421 path. A new buyer reading the schema sees a visible `authentication` field and reaches for it; the modern default is invisible from the schema alone.

Adds a "Webhook signing — default to RFC 9421, don't reach for `authentication`" section to the cross-cutting skill, mirroring the framing locked in by #2506 on `push-notification-config.json`. The section covers:

- The default 9421 path (seller publishes JWKS at `brand.json` `agents[].jwks_uri`, buyer verifies — no shared secret on the wire).
- The switch-not-fallback rule: presence of `authentication` selects legacy; absence selects 9421.
- Inbound verifier checklist: required covered components, `tag="adcp/webhook-signing/v1"`, `adcp_use="webhook-signing"`, error taxonomy.
- Pointer at the `compliance/{version}/test-vectors/webhook-signing/` conformance suite as the only deterministic path to cover every `webhook_signature_*` error code.
- "Use the SDK's verifier; don't roll your own" — RFC 9421 canonicalization is the dominant interop-bug surface.

No normative change — the section surfaces existing rules from `security.mdx` § Webhook callbacks at the on-ramp surface where SDK consumers actually read them. Pairs with the schema-description fix in #4273 (deprecates HMAC-SHA256 recommendation in `reporting-webhook.json` + `auth-scheme.json`); both close pieces of #4270.
