---
"adcontextprotocol": patch
---

`media_buy_seller/audience_buy_flow` runs its member push only for a seller that accepts inline member pushes (#8998). The `audience_binding`, `create_buy_with_audience` and `delivery_check` phases are gated on `media_buy.audience_targeting.supported_activation_methods` being absent (the 3.2 meaning) or listing an entry whose `pattern` is `sync_audiences`. A 3.3 seller that declares `audience_targeting` without inline push (#8996) now grades those phases `not_applicable` instead of failing at the push, and still runs setup and the unbound-audience rejection. The gate uses the storyboard runner's `any_of` capability predicate and object-subset `contains` (adcontextprotocol/adcp-client#3711), so the bundle needs an `@adcp/sdk` release that supports them.
