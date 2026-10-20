---
"adcontextprotocol": minor
---

Add optional `prohibited_terms` (array of strings) to the `brand.json` brand definition: a brand-wide list of words and phrases the brand never uses. It combines by union with a format slot's `text-asset-requirements.prohibited_terms`, and neither list weakens the other. Matching is advisory and left to the receiver. Also fix the `brand_kit_override` description in `core/brand-ref.json`, which named the nonexistent `voice_attributes` field and pointed at a `prohibited_terms` field that did not exist.
