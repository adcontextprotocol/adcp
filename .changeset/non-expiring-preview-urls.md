---
"adcontextprotocol": patch
---

spec(preview_creative): allow non-expiring preview URLs by making `expires_at` optional

`preview_creative` responses previously required `expires_at` for single previews and successful batch results, but the spec did not define how agents should represent preview URLs that do not expire. The response schema now allows omitting `expires_at`; documentation clarifies that a present timestamp marks the time after which consumers should treat preview URLs as invalid, while an omitted timestamp means the preview URLs do not expire.

This relaxes validation for existing non-expiring implementations without changing the meaning of responses that already include `expires_at`. Closes #4453.