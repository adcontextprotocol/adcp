---
"adcontextprotocol": patch
---

Release schemas with `additionalProperties: true` for forward compatibility

This releases `dist/schemas/2.5.2/` containing the relaxed schema validation
introduced in #646. Clients can now safely ignore unknown fields when parsing
API responses, allowing the API to evolve without breaking existing integrations.
