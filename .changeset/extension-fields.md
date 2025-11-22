---
"adcontextprotocol": minor
---

Add extension fields (`ext`) at three layers following IAB/OpenRTB conventions.

**Three-Layer Extension Architecture:**
- **Request extensions** - Operational metadata (tracing, test flags, caller context)
- **Response extensions** - Processing diagnostics (timing, debug info, operational hints)
- **Object extensions** - Domain-specific persistent data (platform IDs, custom fields)

**New capabilities:**
- All 17 task request schemas support optional `ext` for operational parameters
- All 16 task response schemas support optional `ext` for processing metadata
- Core objects (Product, MediaBuy, CreativeManifest, Package) support `ext` for persistent data
- Extension objects accept any valid JSON with `additionalProperties: true`
- Enables platform-specific metadata, testing, tracing, debugging, and experimental features
- Follows industry standard `ext` naming per OpenRTB specification

**Schema changes:**
- Added `ext` to all request schemas (17 files): create-media-buy-request, get-products-request, etc.
- Added `ext` to all response schemas (16 files): create-media-buy-response, get-products-response, etc.
- Added `ext` to core object schemas (4 files): product, media-buy, creative-manifest, package
- Distinct descriptions for request vs response vs object extension purposes

**Documentation:**
- New `docs/reference/extensions.md` with comprehensive three-layer extension guide
- Request/response/object extension use cases and examples
- Extension vs context clarification (opaque correlation vs parseable parameters)
- Layer separation anti-patterns to avoid redundancy
- Namespacing conventions and common patterns
- Testing, tracing, debugging, and measurement examples

**Testing:**
- New `tests/extension-fields.test.js` validating extension behavior
- Tests verify ext is optional, accepts various types, preserves unknown fields
- Integration with npm test suite via test:extensions script

Extension fields enable forward compatibility and platform-specific innovation at appropriate architectural layers while maintaining protocol stability. Each layer serves distinct purposes following proven OpenRTB patterns.
