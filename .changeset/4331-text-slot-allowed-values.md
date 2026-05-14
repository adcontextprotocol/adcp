---
"adcontextprotocol": minor
---

Add `allowed_values` to `text-asset-requirements.json` and the matching `CREATIVE_VALUE_NOT_ALLOWED` error code. Creative agents can now declare a closed set of permitted string values for a text input slot (e.g., legal- or brand-approved CTAs); conformant implementations MUST reject submissions outside the list with `CREATIVE_VALUE_NOT_ALLOWED`, echoing the offending field path in `error.field` and the allowed list in `error.details.allowed_values` so buyer agents can re-prompt deterministically. The field is optional and additive — existing producers and consumers are unaffected.

Refs #4331.
