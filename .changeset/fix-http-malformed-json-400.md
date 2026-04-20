---
---

Fix http-server logging malformed JSON request bodies as unhandled server errors. body-parser `entity.parse.failed`, `entity.verify.failed`, `encoding.unsupported`, and 413/4xx errors now respond with their proper status and log at `warn` instead of paging as `error`-level "Unhandled error". This stops noisy Slack alerts (`System error: http-server [web]`) from bad client input.
