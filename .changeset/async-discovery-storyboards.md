---
"adcontextprotocol": minor
---

Add compliance storyboards for async `get_products` and `get_signals` discovery. The new optional cases force submitted discovery envelopes, verify task visibility through `list_tasks`, force deterministic completion, poll `get_task_status` with terminal results, and assert terminal webhook delivery. Also adds `get_products` to the task-type enum, documents the new controller directives `force_get_products_arm` and `force_get_signals_arm`, and aligns account scoping across legacy and alias task polling schemas.
