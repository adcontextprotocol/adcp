---
"adcontextprotocol": minor
---

Add non-colliding AdCP task-lifecycle aliases in the protocol namespace:
`get_task_status` and `list_tasks`.

The existing `core/tasks-get-*` and `core/tasks-list-*` schemas remain valid
through 3.x for compatibility. The new aliases give SDKs and sellers a
non-colliding path before the legacy AdCP polling surfaces can be reconsidered
in 4.0.
