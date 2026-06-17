---
---

Empty changeset: server registry behavior only. Treat ads.txt `managerdomain` delegation as authoritative when the manager `adagents.json` explicitly scopes the source publisher through `publisher_properties`, and keep delegated property authorization limited to the matching publisher and selector. Also isolates the agent-read rate-limit retry-after unit test from the production singleton limiter so parallel precommit runs stay deterministic.
