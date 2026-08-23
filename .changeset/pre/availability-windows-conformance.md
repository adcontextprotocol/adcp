---
"adcontextprotocol": minor
---

Add conformance surface for flexible-window availability discovery. New `media_buy.availability_horizon` capability declaration gates the new `media_buy_seller/availability_windows` scenario (required by the sales-guaranteed specialism): horizon partitioning into coalesced half-open time windows, eligibility-aware `availability_status` (a gap shorter than the product's minimum bookable duration is `unavailable` even with no competing hold), forecast excluded from `list_products` conditional reads, and `PRODUCT_UNAVAILABLE` on buys against closed or too-short windows. Product fixtures accept an optional seller-internal `availability` calendar (`min_bookable_days`, `booked_windows`) consumed by seeding. Adds schema test vectors for the `availability_horizon` mutual-exclusion and time-dimension shapes.
