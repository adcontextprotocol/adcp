---
---

docs: specify that inline creatives submitted with `create_media_buy` follow the same library lifecycle as `sync_creatives` uploads. If the buy is rejected, canceled, or never activates, only the package assignments are released — the creatives remain in the library and can be reused on a subsequent buy. Creative review is independent of the buy outcome (#2262)
