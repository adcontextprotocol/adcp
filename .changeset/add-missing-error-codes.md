---
"adcontextprotocol": patch
---

Add five error codes to `enums/error-code.json` that were already used in docs and server code but missing from the canonical enum: `INVALID_PRICING_OPTION`, `INVALID_USAGE_DATA`, `DUPLICATE_REQUEST`, `TARGETING_TOO_NARROW`, and `CREATIVE_ID_EXISTS`. Each code now has an `enumDescriptions` entry and an `enumMetadata` recovery classification so SDKs can consume them like any other standard code.
