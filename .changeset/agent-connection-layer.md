---
"adcontextprotocol": minor
---

Extend the experimental principal layer per RFC #7015: caller-level webhook subscribers may carry account-anchored event types with fire-time authorization scoping and an explicit `include_future_event_types` opt-in; a new `declarations` section carries buyer-declared consumption facts (async payload versions, verifiable webhook signing algorithms, experimental opt-ins) with a seller-computed accepted intersection governing asynchronous interactions; and a new caller-anchored `principal.changed` invalidation webhook fires on seller-driven connection-state transitions with repair through `get_principal`. Capabilities advertise `caller_event_types` so buyers select from the offering instead of probing by rejection.
