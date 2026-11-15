---
"adcontextprotocol": minor
---

`image_carousel` gains an optional `cta_values` parameter (adcp#8960), the same shape as `cta_values` on `native_in_feed` and `image`. When it is declared, every card's `cta` MUST be one of the listed values, and a seller refuses any other value with `CREATIVE_VALUE_NOT_ALLOWED`, with `error.field` pointing at that card's `cta`. When it is absent, a card's `cta` takes free text and is not refused as `CREATIVE_VALUE_NOT_ALLOWED`. The `card-asset` `cta` description now names `image_carousel` `cta_values` as the governing set. Additive and optional: existing declarations are unchanged. Before 3.3 a carousel option could carry `cta_values` only as an undeclared parameter on the open `params` object.

New optional compliance scenario `media_buy_seller/declared_carousel_cta_values` (3.3, gated on `creative.has_creative_library`). It seeds an `image_carousel` option that declares `cta_values`, expects `sync_creatives` to refuse a creative whose third card's `cta` is outside the set with `CREATIVE_VALUE_NOT_ALLOWED`, and expects the same creative with a declared value to be accepted.
