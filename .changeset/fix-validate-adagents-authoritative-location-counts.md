---
---

Fix `validate_adagents` counts when `/.well-known/adagents.json` is a pointer stub. We now expose the resolved authoritative manifest as `raw_data` after following `authoritative_location`, so Addie's `agent_count` and `property_count` are derived from the canonical file instead of the stub.
