---
---

Add `force_refresh` boolean parameter to `validate_agent` MCP tool to bypass the 15-minute in-memory cache. When `true`, the tool fetches the publisher's `adagents.json` live rather than returning a cached result. Fixes the issue where publishers iterating on their `adagents.json` saw stale `authorized: false` responses up to 15 minutes after updating the file. A 30-second per-domain cooldown bounds upstream fetches when callers repeatedly pass `force_refresh: true`; within the cooldown the tool returns the most recent live result. No protocol schema change.
