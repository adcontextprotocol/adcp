---
"adcontextprotocol": patch
---

Docs: Choose your SDK, Versions and the creative33 sandbox note name `@adcp/sdk` 17.0.0-beta.31, which still bundles `3.3.0-rc.0`. It no longer records `context.media_buy_id` from an interim `create_media_buy` or `update_media_buy` envelope (adcontextprotocol/adcp-client#3683), so `webhook_emission` grades a `working` response that carries `media_buy_id` on its webhooks instead of classifying it as synchronous.
