---
"adcontextprotocol": minor
---

Split `pending_activation` media buy status into `pending_creatives` and `pending_start` for finer-grained lifecycle tracking. Replace InMemoryTaskStore with PostgresTaskStore for distributed MCP task handling. Refactor comply test controller to use SDK TestControllerStore pattern.
