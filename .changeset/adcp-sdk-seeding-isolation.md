---
---

chore(deps): bump `@adcp/sdk` to `9.0.0-beta.22`

Pulls in the storyboard runner fix for adcontextprotocol/adcp#5247 via
adcontextprotocol/adcp-client#2156: generated `__controller_seeding__` calls
now carry a storyboard-scoped `context.correlation_id`, letting sellers isolate
seeded fixtures per storyboard instead of accumulating state across a full
suite run.
