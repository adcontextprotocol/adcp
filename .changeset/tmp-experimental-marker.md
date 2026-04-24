---
"adcontextprotocol": patch
---

Add `x-status: experimental` to all 9 TMP schemas, completing the experimental-status contract already declared for `trusted_match.core` in `get_adcp_capabilities` and `experimental-status.mdx`. Mirrors the existing pattern on all 11 sponsored-intelligence schemas. Enables validators, doc generators, and tooling to identify TMP as an experimental surface. No wire-format or field changes.
