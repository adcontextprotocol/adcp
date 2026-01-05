---
"adcontextprotocol": minor
---

Add unified `assets` field to format schema for better asset discovery

- Add new `assets` array to format schema with `required` boolean per asset
- Deprecate `assets_required` (still supported for backward compatibility)
- Enables full asset discovery for buyers and AI agents to see all supported assets
- Optional assets like impression trackers can now be discovered and used

