---
---

Add `force_refresh` boolean parameter to `validate_agent` MCP tool to bypass the 15-minute in-memory cache. When `true`, the tool fetches the publisher's `adagents.json` live rather than returning a cached result. Fixes the issue where publishers iterating on their `adagents.json` saw stale `authorized: false` responses up to 15 minutes after updating the file. Mirrors the existing `fresh` bypass pattern used by `resolve_brand` and `validate_brand_json`. No protocol schema change.
