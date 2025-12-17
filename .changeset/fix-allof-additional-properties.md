---
"adcontextprotocol": patch
---

Fix JSON Schema validation failures when using allOf composition with additionalProperties: false.

Schemas using `allOf` to compose with base schemas (dimensions.json, push-notification-config.json) were failing AJV validation because each sub-schema independently rejected the other's properties.

**Fixed schemas:**
- `dimensions.json` - removed `additionalProperties: false` (composition-only schema)
- `push-notification-config.json` - removed `additionalProperties: false` (used via allOf in reporting_webhook)
- `video-asset.json` - inlined width/height properties, removed allOf
- `image-asset.json` - inlined width/height properties, removed allOf

**Added:**
- New `test:composed` script to validate data against schemas using allOf composition
- Added to CI pipeline to prevent regression
- Bundled (dereferenced) schemas at `/schemas/{version}/bundled/` for tools that don't support $ref resolution

Fixes #275.
