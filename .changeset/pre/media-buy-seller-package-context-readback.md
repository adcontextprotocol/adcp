---
"adcontextprotocol": patch
---

`media_buy_seller` now checks that `get_media_buys` returns each package's persisted `context`. The `create_media_buy` sample requests (both the default and the buyer-selected-timezone branches) send a distinct `context.buyer_ref` on each of their two packages, and `check_buy_status` requires each package to come back with its own `product_id` and that `context`, in any order (`field_contains` over `media_buys[0].packages[*]`).

`get_media_buys` already says sellers MUST include a package's persisted `context` when the package was created through AdCP with one, but only `pending_creatives_to_start` checked it, and that scenario is `not_applicable` for any seller without auto-approval and a creative library. A seller that drops package `context` on readback now fails the core lifecycle. No schema, task definition or released artifact changes.
