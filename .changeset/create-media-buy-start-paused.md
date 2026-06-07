---
"adcontextprotocol": minor
---

Add top-level `paused` to `create_media_buy` so buyers can create campaigns with
delivery held from the outset. A start-paused buy returns `media_buy_status:
"paused"` once activation prerequisites are satisfied; missing creatives and
future start dates still surface as `pending_creatives` and `pending_start`.
