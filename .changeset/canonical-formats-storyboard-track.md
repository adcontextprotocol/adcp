---
"adcontextprotocol": patch
---

Add a media-buy canonical-formats scenario that seeds a dual-emitted product and verifies the seeded `get_products` response carries matching v1 `format_ids` and v2 `format_options`.

Also refresh the canonical get_products response fixture so it satisfies the current 3.1 response envelope and cache-scope requirements.
