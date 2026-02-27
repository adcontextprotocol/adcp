---
"adcontextprotocol": minor
---

Add seller-generated creative support for catalog-driven campaigns.

New `creative-preview` schema for sample creatives on products. Sellers that generate creatives from buyer catalogs (dynamic job ads, sponsored product cards, etc.) can now include preview renders on products in `get_products` responses. Each preview has a `generated_creative_ref` for per-creative refinement feedback.

New `creative_generation` capability on `media_buy` in `get_adcp_capabilities` declares which catalog types drive generation and typical sample count.
