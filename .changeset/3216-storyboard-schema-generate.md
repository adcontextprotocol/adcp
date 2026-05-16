---
"adcontextprotocol": patch
---

Document `generate` as a sibling of `path` on `context_outputs[]` entries in `storyboard-schema.yaml`. Mutual-exclusion with `path` (exactly one required). Supported generators: `uuid_v4` and `opaque_id` (both mint a UUID v4; the two names exist for spec-vs-implementation framing). Aligns the spec-side schema with the runner-side support shipped in adcp-client#1006. Closes #3216.
