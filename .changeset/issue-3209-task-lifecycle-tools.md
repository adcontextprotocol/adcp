---
"adcontextprotocol": minor
---

Add non-colliding AdCP task-lifecycle aliases in the protocol namespace:
`get_task_status` and `list_tasks`.

These are aliases for AdCP's application-layer lifecycle tools, not aliases for
transport-native MCP/A2A `tasks/*` APIs. The existing `core/tasks-get-*` and
`core/tasks-list-*` schemas remain valid through 3.x for compatibility; the
new aliases avoid transport-name collisions without changing AdCP async task
polling or reconciliation semantics.
