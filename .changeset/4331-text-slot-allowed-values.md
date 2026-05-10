---
"adcontextprotocol": minor
---

Add `allowed_values` to `text-asset-requirements.json`. Creative agents can now declare a closed set of permitted string values for a text input slot (e.g., localized CTA variants approved by legal or brand); conformant implementations MUST reject submissions not in the list. The field is optional and additive — existing producers and consumers are unaffected.

Refs #4331.
