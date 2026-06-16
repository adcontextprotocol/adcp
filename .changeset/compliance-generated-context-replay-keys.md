---
"adcontextprotocol": patch
---

Use generated storyboard context values for idempotency replay keys so the
initial, replay, and conflict requests share one UUID while the fresh-key path
uses a distinct generated UUID.
