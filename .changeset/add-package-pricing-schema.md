---
"adcontextprotocol": minor
---

Add required package-level pricing fields to delivery reporting schema to match documentation.

**Schema Changes:**
- Added required `pricing_model` field to `by_package` items in `get-media-buy-delivery-response.json`
- Added required `rate` field to `by_package` items for pricing rate information
- Added required `currency` field to `by_package` items to support per-package currency

These required fields enable buyers to see pricing information directly in delivery reports for better cost analysis and reconciliation, as documented in the recently enhanced reporting documentation (#179).
