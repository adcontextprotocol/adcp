---
"adcontextprotocol": patch
---

Deprecate the single-value form of the 17 scalar-or-list unions (#8477): the `brand.json` color values and `get_brand_identity` colors, `envelope_field` on `REQUOTE_REQUIRED` details, the creative asset maps, `status_filter` on `get_media_buys` and `get_media_buy_delivery`, and audience characteristic `value`. Each scalar branch carries `deprecated: true` and `x-deprecated-in: "3.3.0"`, with `x-removed-in: "4.0.0"`, or `"5.0.0"` for the `brand.json` color values, which are read without version negotiation. Senders send a one-item array, except in a creative asset map to a 3.0 peer, since those maps accept an array only from 3.1; receivers keep accepting the single value through 3.x. No payload validates differently.
