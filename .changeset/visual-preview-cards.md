---
"adcontextprotocol": minor
---

Add visual card support for products and formats. Publishers and creative agents can now include optional card definitions that reference card formats and provide visual assets for display in user interfaces.

**New schema fields:**
- `product_card` and `product_card_detailed` fields in Product schema (both optional)
- `format_card` and `format_card_detailed` fields in Format schema (both optional)

**Two-tier card system:**
- **Standard cards**: Compact 300x400px cards (2x density support) for browsing grids
- **Detailed cards**: Responsive layout with description alongside hero carousel, markdown specs below

**Rendering flexibility:**
- Cards can be rendered dynamically via `preview_creative` task
- Or pre-generated and served as static CDN assets
- Publishers/agents choose based on infrastructure

**Standard card format definitions:**
- `product_card_standard`, `product_card_detailed`, `format_card_standard`, `format_card_detailed`
- Will be added to the reference creative-agent repository
- Protocol specification only defines the schema fields, not the format implementations

**Deprecation:**
- `preview_image` field in Format schema is now deprecated (but remains functional)
- Will be removed in v3.0.0
- Migrate to `format_card` for better flexibility and structure

**Benefits:**
- Improved product/format discovery UX with visual cards
- Detailed cards provide media-kit-style presentation (description left, carousel right, specs below)
- Consistent card rendering across implementations
- Uses AdCP's own creative format system for extensibility
- Non-breaking: Completely additive, existing implementations continue to work
