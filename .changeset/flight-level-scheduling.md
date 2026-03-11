---
"adcontextprotocol": minor
---

Add optional `start_time` and `end_time` to package schemas and product allocations for per-package flight scheduling.

- `core/package.json`, `media-buy/package-request.json`, `media-buy/package-update.json`: buyers can set independent flight windows per package within a media buy.
- `core/product-allocation.json`: publishers can propose per-flight scheduling in proposals.
