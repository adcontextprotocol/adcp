---
"adcontextprotocol": patch
---

Fix reporting_webhook schema to enable additionalProperties validation.

Inlined push-notification-config fields because allOf + additionalProperties:false doesn't work in JSON Schema. Documented this pattern in CLAUDE.md.
