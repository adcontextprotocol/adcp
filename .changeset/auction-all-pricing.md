---
"adcontextprotocol": minor
---

Add auction pricing for all pricing models with consolidated schema

Previously only CPM and vCPM supported both fixed and auction pricing. Now all pricing models support both variants:
- CPM, vCPM (already supported)
- CPC (Cost Per Click)
- CPCV (Cost Per Completed View)
- CPV (Cost Per View)
- CPP (Cost Per Point)
- Flat Rate

**Schema Architecture Change:**
Consolidated 14 individual pricing option schemas into a single unified `pricing-option.json` using a two-level discriminated union:
- Level 1: `is_fixed: true` (fixed rate with `rate` field) vs `is_fixed: false` (auction with `price_guidance` field)
- Level 2: `pricing_model` enum (cpm, vcpm, cpc, cpcv, cpv, cpp, flat_rate)

This eliminates the need to enumerate every pricing model + pricing type combination as separate files, making the schema more maintainable and scalable.

**Removed schemas:**
- All individual pricing option schemas (cpm-fixed-option.json, cpm-auction-option.json, etc.)
- The pricing-options directory

**TypeScript type safety maintained:**
Uses proper discriminated union with `is_fixed` as the discriminator, enabling TypeScript to narrow types correctly:
- `if (opt.is_fixed) { opt.rate... }`
- `else { opt.price_guidance... }`
