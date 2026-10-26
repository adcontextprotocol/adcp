---
"adcontextprotocol": patch
---

Known limitations: the collection-coverage entry drops the SDK context-key (adcp-client#3396) and feed-restart (adcp-client#3397) caveats, both fixed in `@adcp/sdk` 16.5. It also records that the omitted-`media_buy_status` false failure (adcp-client#3395) persists through 17.0.0-beta.0 and is fixed upstream by adcp-client#3439, not yet released.
