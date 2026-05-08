---
"adcontextprotocol": patch
---

Fix stale HMAC-as-recommended framing in reporting-webhook.json and auth-scheme.json; add RFC 9421 default guidance to call-adcp-agent SKILL.md. Description-only fixes aligning these surfaces with the existing push-notification-config.json framing (HMAC is the deprecated fallback, RFC 9421 is the default). No wire format changes.
