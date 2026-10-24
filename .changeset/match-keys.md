---
"adcontextprotocol": minor
---

feat(media-buy): declare supported match keys and connect them to cross-publisher frequency capping (experimental, #8375).

Adds `core/match-key.json` (`uid_type`, `vendor` BrandRef, `scopes[]`, `uses[]`, seller-wide `property_types[]`) and `enums/match-key-use.json` (`audience_include`, `audience_exclude`, `frequency_cap`, `identity_match`, `conversion_attribution`). Match keys appear seller-wide as `media_buy.supported_match_keys` on `get_adcp_capabilities`, per product as `Product.identity.match_keys`, and on TMP provider registration as `match_keys` alongside `uid_types`.

`frequency_cap` covers caps the seller enforces; `identity_match` declares that a product forwards the key to buyer-side TMP Identity Match, the only place a cap can count across sellers. Two keys are compatible at a scope when they share `uid_type`, both list the scope, and their vendor domains match when both declare one. A product with `persistent_identifier: false` cannot declare `frequency_cap` or `identity_match` keys; `pairid` and `hashed_email` keys cannot declare `identity_match`. Match-key changes are material capability changes signalled through `adcp.capability_changes` and `capabilities.changed`.

All fields are additive and optional. Sellers using them list the new `media_buy.match_keys` experimental feature. `enums/uid-type.json`, `supported_uid_types`, and TMP routing on `uid_types` are unchanged.
