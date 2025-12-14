---
"adcontextprotocol": minor
---

Align Deals Protocol with Media Buy Protocol patterns for consistency across AdCP.

**New features:**
- Added `deal-filters.json` schema with structured filtering capabilities (deal_type, ad_type, platforms, date ranges, status, countries, devices)
- Added `brand_manifest` support to `get_deals` request (optional, inline or URL reference)
- Added `ext` extension field support to all Deals protocol requests and responses
- Added `filters` parameter to `get_deals` for structured deal discovery

**Breaking changes:**
- Renamed `deal_spec` to `brief` in `get_deals` request to match `get_products` pattern
- Made all `get_deals` request fields optional (removed `required: ["deal_spec"]`)

**Improvements:**
- Updated all `context` fields to use `$ref` to `/schemas/core/context.json` instead of inline definitions
- Added `ext` field references to both success and error variants in discriminated union responses
- Improved schema consistency across all Deals protocol tasks

**Migration guide:**
```javascript
// Before
await client.getDeals({ deal_spec: "Premium video deals" });

// After
await client.getDeals({ brief: "Premium video deals" });

// New capabilities
await client.getDeals({
  brief: "Premium video deals",
  filters: {
    deal_type: ["Curated"],
    ad_type: ["Video"],
    countries: ["US", "CA"]
  },
  brand_manifest: "https://example.com/brand.json"
});
```
