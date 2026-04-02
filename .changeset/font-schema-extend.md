---
"adcontextprotocol": minor
---

Extend brand.json fonts schema with structured font definitions. Each font role (primary, secondary, etc.) now accepts either a CSS font-family string or a structured object with `family` and `files` (array of `{url, weight, style}`). This enables creative agents to resolve fonts reliably via downloadable font files with weight and style metadata, while remaining backward compatible with simple string values.
