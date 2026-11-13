---
"adcontextprotocol": minor
---

`image_carousel` gains an optional `cta_values` parameter (adcp#8960), the same type as `cta_values` on `native_in_feed` and `image`. It governs each card's `cta`: when declared, every card's `cta` must be one of the listed values, and a seller refuses any other value with `CREATIVE_VALUE_NOT_ALLOWED`, with `error.field` pointing at that card's `cta`. A card may still omit `cta`. Without `cta_values`, a card's `cta` takes free text and a seller does not refuse it as `CREATIVE_VALUE_NOT_ALLOWED`. Additive and optional: existing declarations are unchanged. A seller that carried `cta_values` on a carousel option as an undeclared extra parameter can keep the same value; it is now the declared field.
