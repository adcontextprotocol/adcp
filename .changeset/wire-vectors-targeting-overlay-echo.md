---
---

Add wire-level positive vectors for `PackageStatus.targeting_overlay` echo on `get_media_buys` under `static/test-vectors/media-buy/`. Covers both the `MUST` specialism path (`PropertyListReference` + `CollectionListReference`) and the general `SHOULD` path (plain overlay fields: `geo_countries`, `device_type`, `frequency_cap`). The storyboard exercises behavior; these vectors lock the schema shape against regeneration drift and give downstream SDKs a canonical payload to validate code generators against. Follows #2488 / #2512.
