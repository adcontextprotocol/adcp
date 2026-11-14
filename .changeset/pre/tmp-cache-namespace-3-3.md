---
"adcontextprotocol": minor
---

Require experimental TMP Context Match caches in AdCP 3.3 to partition by
trusted evaluation namespace as well as request hash, re-authorize warm hits,
and bypass caching when the required context cannot be established. Keep
provider model-deployment changes under the existing cache_ttl policy, state
the stale-entry window, and recommend lowering TTL before such deployments.
The 3.1.22 emergency privacy and request-partitioning corrections remain in
force; no published 3.1 or 3.2 release artifact changes.
