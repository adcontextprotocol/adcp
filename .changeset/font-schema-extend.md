---
"adcontextprotocol": minor
---

Extend brand.json fonts schema with structured font definitions. Each font role (primary, secondary, etc.) now accepts either a CSS font-family string or a structured object with `family`, `files` (with `weight`, `weight_range` for variable fonts, and `style`), `opentype_features` (e.g., ss01, tnum), and `fallbacks` for multi-script coverage. This enables creative agents to resolve and render fonts reliably while remaining backward compatible with simple string values.
