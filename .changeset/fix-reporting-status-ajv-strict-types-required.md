---
"adcontextprotocol": patch
---

Fix get-reporting-status-response schema compilation under AJV strictTypes and strictRequired.

Adds `properties` stubs alongside bare `required` arrays in `not`/`then` subschemas (17 locations: Summary view not.anyOf×10, Periods view then.not and not, Revision view not.anyOf×5) and adds `"type": "object"` to the `pagination` property in the Periods and Revision view discriminator arms. Runtime validation behavior with strictTypes/strictRequired disabled is unchanged.
