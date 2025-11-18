---
"adcontextprotocol": minor
---

Simplify BrandManifest Schema

- Replace `anyOf` constraint with single `required: ["name"]` field
- Fixes code generation issue where schema generators created duplicate types (BrandManifest1 | BrandManifest2)
- Brand name is now always required, URL remains optional
- Supports both URL-based brands and white-label brands without URLs
