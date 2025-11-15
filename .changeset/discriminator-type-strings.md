---
"adcontextprotocol": patch
---

Add explicit type declarations to discriminator fields in JSON schemas.

All discriminator fields using `const` now include explicit `"type"` declarations (e.g., `"type": "string", "const": "value"`). This enables TypeScript generators to produce proper literal types instead of `Any`, improving type safety and IDE autocomplete.

**Fixed schemas:**
- daast-asset.json: delivery_type discriminators
- vast-asset.json: delivery_type discriminators
- preview-render.json: output_format discriminators
- deployment.json: type discriminators
- sub-asset.json: asset_kind discriminators
- preview-creative-response.json: response_type and success discriminators

**Documentation:**
- Updated CLAUDE.md with best practices for discriminator field typing
