---
---

test(compliance): add billing finality and out-of-band billing storyboards (refs #5030)

Adds two AdCP 3.1 storyboard paths:

- `media_buy_seller/billing_finality_delivery` verifies provisional versus final delivery finality markers and final `report_usage` metadata.
- `creative/billing_out_of_band` verifies `creative.bills_through_adcp: false` capability discovery and `BILLING_OUT_OF_BAND` placement on `report_usage` payload errors.

The training agent now supports the storyboard-only billing finality fields, exposes tenant-scoped creative out-of-band billing on `/creative`, and keeps 3.0 compatibility runs from advertising the new 3.1-only fields.
