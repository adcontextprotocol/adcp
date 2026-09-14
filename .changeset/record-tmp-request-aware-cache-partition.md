---
"adcontextprotocol": minor
---

Record the v3.1.22 emergency security correction that replaced the
placement-only Context Match cache key with request-aware partitioning
by `{provider_id, context_hash}`. This change shipped in v3.1.22 as an
emergency governance exception to the six-week notice rule, after
`3.2.0-rc.1` was cut, and therefore carried no changeset on `main`.
Adding the release record here so the 3.2 changelog captures the
prerequisite request-partition step that `cache_namespace` enforcement
builds on.
