---
"adcontextprotocol": patch
---

Add `publisher_domain` filter to `get_products`: buyers can now filter products by publisher domain, returning only products whose `publisher_properties` include an exact match for the specified domain. The training agent enforces this filter at runtime, and the schema documents the expected matching semantics (exact match, no subdomain expansion).
