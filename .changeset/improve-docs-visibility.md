---
"adcontextprotocol": patch
---

Improve documentation visibility and navigation

**Documentation Improvements:**

1. **Added Changelog Page**
   - Created comprehensive `/docs/reference/changelog` with v2.1.0 and v2.0.0 release notes
   - Includes developer migration guide with code examples
   - Documents breaking changes and versioning policy
   - Added to sidebar navigation in Reference section

2. **Improved Pricing Documentation Visibility**
   - Added Pricing Models to sidebar navigation (Media Buy Protocol > Advanced Topics)
   - Added pricing information callouts to key task documentation
   - Enhanced `get_products` with pricing_options field description
   - Added missing `pricing_option_id` field to `create_media_buy` Package Object
   - Added prominent tip box linking to pricing guide in media-products.md

3. **Added Release Banner**
   - Homepage now displays v2.1.0 release announcement with link to changelog
   - Makes new releases immediately visible to documentation readers

**Why These Changes:**

- Users reported difficulty finding changelog and version history
- Pricing documentation was comprehensive but hidden from navigation
- Critical fields like `pricing_option_id` were not documented in API reference
- Release announcements need better visibility on homepage

These are documentation-only changes with no code or schema modifications.
