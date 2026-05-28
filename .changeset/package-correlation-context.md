---
"adcontextprotocol": minor
---

spec(media-buy): clarify package correlation across mixed seller versions.

Sellers now have explicit normative guidance to echo `product_id` on package responses created from explicit `create_media_buy` package requests. Buyers targeting mixed seller populations should use package-level `context`, commonly `context.buyer_ref`, as the legacy-safe fallback for sellers that do not echo `product_id`; read surfaces now document persisted media-buy and package context so that fallback is recoverable, and deprecated top-level `buyer_ref` is removed from not-found recovery guidance.
