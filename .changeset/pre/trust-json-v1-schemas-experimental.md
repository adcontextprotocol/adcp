---
"adcontextprotocol": minor
---

Add the experimental `trust/v1` JSON schemas (`trust/v1/trust.json` and `trust/v1/trust-acknowledgements.json`) from RFC #7809, registered in the schema index and listed as `identity.trust_json` on the experimental status page, with a short reference page. Schemas only: nothing consumes `trust.json` in 3.3. There is no `identity.trust_url` capability field, no resolver or precedence change, no storyboard change, and no one is required to publish `/.well-known/trust.json`; `brand.json` behavior is unchanged. The document name and path may change before graduation while the JournalList naming outreach is open.
