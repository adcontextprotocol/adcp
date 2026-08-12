---
"adcontextprotocol": patch
---

Preserve Trusted Match Context targeting key-values in router-authored, provider-attributed buckets.

Migration for experimental TMP adopters: providers continue to return
`signals.targeting_kvs`, but routers must stop returning that flattened field to
publishers. Instead, copy each provider's pairs unchanged into
`signals_by_provider[provider_id].targeting_kvs` and validate the publisher hop
against `context-match-response.json`.
