---
"adcontextprotocol": patch
---

Clarify that v3 agents MUST NOT emit legacy status fields (`task_status`, `response_status`, or any alias) alongside the v3 `status` field. Adds a migration checklist row, a conformance warning in the task-lifecycle reference, and extends the protocol envelope schema's `status` description with the prohibition. Closes #2987.
