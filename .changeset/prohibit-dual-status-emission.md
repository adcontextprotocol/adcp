---
---

Clarify that v3 agents MUST NOT emit legacy status fields (`task_status`, `response_status`, or any alias) alongside the v3 `status` field. Adds a migration checklist row, a conformance warning in the task-lifecycle reference, and an `x-adcp-conformance` annotation on the protocol envelope schema's `status` property. Closes #2987.
