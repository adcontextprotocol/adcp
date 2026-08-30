---
"adcontextprotocol": patch
---

Make the compliance refresh endpoint asynchronous. POST /refresh now returns 202 with an operation handle; the storyboard suite runs in the background and persists results on completion. A new polling endpoint at GET /compliance/refresh-status lets callers observe running, completed, or failed state. Concurrent requests for the same agent are coalesced via a DB unique constraint. Fixes #7083.
