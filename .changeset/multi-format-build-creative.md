---
"adcontextprotocol": minor
---

build_creative: support multi-format output via target_format_ids

Add `target_format_ids` array as an alternative to `target_format_id` on build_creative requests. When provided, the creative agent produces one manifest per requested format and returns them in a `creative_manifests` array. This lets buyers request multiple format variants (e.g., 300x250 + 728x90 + 320x50) in a single call instead of making N sequential requests.

Closes #1395
