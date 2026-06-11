---
"adcontextprotocol": patch
---

Clarify that brand.json may contain multiple same-type `agents[]` entries when
they use distinct endpoint URLs, such as one sales-agent URL per publisher
tenant. Each entry can publish its own static `jwks_uri` shard; dynamic key
routing is optional rather than required.
