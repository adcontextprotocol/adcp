---
"adcontextprotocol": patch
---

Correct the v3.1.22 release record to include the request-aware Context Match
cache partitioning from #7397 alongside the single-user privacy protections
from #7396, document the emergency privacy/security notice exception and
immutable artifacts, and direct operators with unsafe caches to bypass caching
until both request and trusted provider-evaluation contexts are isolated, while
keeping the additional `cache_namespace` conformance contract in 3.2.
