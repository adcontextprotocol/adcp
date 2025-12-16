---
"adcontextprotocol": minor
---

Add auction pricing for all pricing models

Previously only CPM and vCPM supported both fixed and auction pricing. Now all pricing models support both variants:
- CPM, vCPM (already supported)
- CPC (Cost Per Click)
- CPCV (Cost Per Completed View)
- CPV (Cost Per View)
- CPP (Cost Per Point)
- Flat Rate

**Schema Architecture:**
Each pricing model has its own schema file that supports both fixed and auction variants using a discriminated union:
- `is_fixed: true` → uses `rate` field for fixed pricing
- `is_fixed: false` → uses `price_guidance` field for auction pricing

**7 pricing model schemas:**
- cpm-option.json
- vcpm-option.json
- cpc-option.json
- cpcv-option.json
- cpv-option.json
- cpp-option.json
- flat-rate-option.json

**TypeScript type safety:**
Uses proper discriminated union with `is_fixed` as the discriminator, enabling TypeScript to narrow types correctly:
- `if (opt.is_fixed) { opt.rate... }`
- `else { opt.price_guidance... }`
