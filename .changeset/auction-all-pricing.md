---
"adcontextprotocol": minor
---

Add auction pricing variants for all pricing models

Previously only CPM and vCPM supported both fixed and auction pricing. This change adds auction variants for:
- CPC (Cost Per Click)
- CPCV (Cost Per Completed View)
- CPV (Cost Per View)
- CPP (Cost Per Point)
- Flat Rate

All pricing models now support both `is_fixed: true` (fixed rate with `rate` field) and `is_fixed: false` (auction-based with `price_guidance` object).

**New schemas:**
- cpc-auction-option.json
- cpcv-auction-option.json
- cpv-auction-option.json
- cpp-auction-option.json
- flat-rate-auction-option.json

**Renamed schemas (for consistency):**
- cpc-option.json → cpc-fixed-option.json
- cpcv-option.json → cpcv-fixed-option.json
- cpv-option.json → cpv-fixed-option.json
- cpp-option.json → cpp-fixed-option.json
- flat-rate-option.json → flat-rate-fixed-option.json
