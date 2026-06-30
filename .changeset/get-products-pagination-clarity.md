---
"adcontextprotocol": patch
---

Clarify that `get_products` pagination is valid in all buying modes, with `brief` and `refine` pagination bounding returned `products[]` in curated results while `wholesale` pagination walks the product feed. Add conformance coverage for the deterministic wholesale cursor walk without treating brief/refine as exhaustive catalog enumeration.
