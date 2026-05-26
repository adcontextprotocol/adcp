---
---

fix(compliance): make storyboard pricing selection deterministic across fixed-price and auction flows (#4953)

`get_products` fixed-price filtering now returns only matching pricing options so storyboard buyers can reuse the discovered `pricing_option_id` without auction/fixed ambiguity. Fixed-price storyboards request fixed-price products and omit auction-only `bid_price`; non-guaranteed auction storyboards derive initial and updated bids from discovered bid guidance instead of using a hardcoded bid.
