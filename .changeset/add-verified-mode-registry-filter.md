---
---

Add `?verification_mode` and `?verified` query parameters to `GET /api/registry/agents`. Wires up the filter capability the docs at `aao-verified.mdx#registry-filter` already advertise. Supports AND semantics (repeat param for multiple axes) and reuses the prefetched badge map when `?compliance=true` is also set. Closes #3505.
