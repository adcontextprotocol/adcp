---
"adcontextprotocol": minor
---

Two enums that had drifted now share one definition with their other sites (#8525). `brand.json` property `store` references `enums/app-store.json` and accepts `fire_tv` and `vizio`, as the brand claim requests already did. The `native_in_feed` canonical format's `asset_source` references `enums/asset-source.json` and accepts `publisher_host_recorded`, as every other canonical format already did. Both changes only add accepted values.
