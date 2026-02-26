---
"adcontextprotocol": minor
---

Flatten `deliver_to` in `get_signals` request into top-level `destinations` and `countries` fields.

Previously, callers were required to construct a nested `deliver_to` object with `deployments` and `countries` sub-fields, even when querying a platform's own signal agent where the destination is implicit. Both fields are now optional top-level parameters:

- `destinations`: Filter signals to those activatable on specific agents/platforms. When omitted, returns all signals available on the current agent.
- `countries`: Geographic filter for signal availability.
