---
"adcontextprotocol": patch
---

Fix reporting_webhook schema to enable additionalProperties validation.

Inlined push-notification-config fields because allOf + additionalProperties:false breaks PHP schema generation (reported by Lukas Meier). Documented this pattern in CLAUDE.md.
