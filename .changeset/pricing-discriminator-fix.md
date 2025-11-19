---
"adcontextprotocol": minor
---

Add explicit `is_fixed` discriminator field to all pricing option schemas for consistent discrimination.

**What Changed:**
- Fixed-rate options (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate): Now include `is_fixed: true` as a required field
- Auction-based options (CPM Auction, vCPM Auction): Now include `is_fixed: false` as a required field

**Why This Change:**
Previously, only `flat-rate-option` had an explicit `is_fixed` field. Other pricing options had inconsistent discrimination:
- CPM Fixed vs CPM Auction: Both used `pricing_model: "cpm"`, differentiated only by presence of `rate` vs `price_guidance`
- vCPM Fixed vs vCPM Auction: Both used `pricing_model: "vcpm"`, same structural inference issue

This created two different discrimination patterns (explicit field-based vs structural inference), making it difficult for TypeScript generators and clients to properly discriminate between fixed and auction pricing.

**Benefits:**
- **Consistent discrimination**: All pricing options use the same explicit pattern
- **Type safety**: Discriminated unions work properly with `is_fixed` as discriminator
- **Client simplicity**: No need to check for `rate` vs `price_guidance` existence
- **API clarity**: Explicit is always better than implicit
- **Forward compatibility**: Adding new pricing models is easier with explicit discrimination

**Migration Guide:**
All pricing option objects must now include the `is_fixed` field:

```json
// Fixed-rate pricing (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate)
{
  "pricing_option_id": "cpm_usd_guaranteed",
  "pricing_model": "cpm",
  "is_fixed": true,
  "rate": 5.50,
  "currency": "USD"
}

// Auction pricing (CPM Auction, vCPM Auction)
{
  "pricing_option_id": "cpm_usd_auction",
  "pricing_model": "cpm",
  "is_fixed": false,
  "price_guidance": {
    "floor": 2.00
  },
  "currency": "USD"
}
```
