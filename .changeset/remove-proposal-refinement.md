---
"adcontextprotocol": major
---

Consolidate `feedback`, `product_ids`, and `proposal_id` into a single `refine` object on `get_products`

The previous refinement interface spread across three top-level fields. The new `refine` object consolidates all refinement intent: `overall` direction, per-product actions (`include`, `omit`, `more_like_this`), and per-proposal adjustments. This is a breaking change — the old `feedback`, `product_ids`, and `proposal_id` fields are removed.
