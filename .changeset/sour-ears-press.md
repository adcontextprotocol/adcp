---
---

Improve documentations. Specfically:

- Clarify that completed/failed statuses use Task object with data in .artifacts
- Clarify that interim statuses (working, input-required) use TaskStatusUpdateEvent with data in status.message.parts
- Add best practice guidance for URL-based routing (task_type and operation_id in URL)
- Deprecate task_type and operation_id fields in webhook payload (backward compatible)
- Update webhook handler examples to use URL parameters - Consistent guidance across both MCP and A2A protocols
