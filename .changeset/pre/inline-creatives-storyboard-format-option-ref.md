---
"adcontextprotocol": patch
---

`media_buy_seller/inline_creatives_without_sync`: the product-scoped and publisher-scoped inline creatives carry `format_option_ref`, built from the captured declaration, so a seller that declares several options of the same `format_kind` can route them (adcp#8625). No schema changes.
