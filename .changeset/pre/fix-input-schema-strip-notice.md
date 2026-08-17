---
"adcontextprotocol": patch
---

Correct the `input_schema_field_stripped` compliance notice so it identifies request payload drift without blaming agents for omitting fields that are not part of the canonical task schema, and consume the SDK release that keeps broad `list_accounts` discovery requests unscoped.
