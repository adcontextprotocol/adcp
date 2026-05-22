---
"adcontextprotocol": patch
---

docs(adagents): add `authorization_type` → companion-field quick-reference table at the top of the Authorization Patterns section, plus a `<Warning>` callout on the `inline_properties` naming exception (companion field is `properties`, not `inline_properties`). Schema `description` strings on the `inline_properties` `oneOf` branch updated to surface the same exception where IDEs and linters display it. "Four patterns" count corrected to "six authorization types" (the two signal-side values were absent from the prose count). Non-normative — no fields, enums, or `required` arrays change.

Closes #4776.
