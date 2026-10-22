---
"adcontextprotocol": patch
---

Fix the `sales_non_guaranteed` pilot's `fixture_resolution` match for the `outdoor_video_auction` handle: it matched `/channels contains_all [video]`, but `video` is not a value of `enums/channels.json`, so no schema-valid product could satisfy it and that handle's `discover` strategy was always `unavailable`. The clause now matches `[olv]`, the channel the seeded fixture already uses. Seeded runs are unchanged.
