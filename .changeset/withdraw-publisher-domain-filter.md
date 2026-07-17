---
"adcontextprotocol": minor
---

Withdraw the incorrectly specified `publisher_domain` filter from `get_products` before the next minor release. The filter was not patch-eligible for the stable 3.1.x line, and its implementation incorrectly accepted the plural `publisher_domains[]` form that product schemas reject.
