---
"adcontextprotocol": minor
---

Add experimental collection cards (`media_buy.collection_cards`): `images` and `sample_content` on `core/collection.json`, a typed `brand_ref` on `core/talent.json` (wins over `brand_url` when both are present; `brand_url` is not deprecated), and a `sample_content` role on product card reference assets. Each array holds 1 to 10 entries. Refs #8092.
