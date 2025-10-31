---
"adcontextprotocol": minor
---

- Standardize webhook payload: protocol envelope at top-level; task-specific data moved under result.
- Result schema is bound to task_type via JSON Schema refs; result may be present for any status (including failed).
- Error remains a string; can appear alongside result.
- Required fields updated to: task_id, task_type, status, timestamp. Domain is no longer required.
- Docs updated to reflect envelope + result model.
- Compatibility: non-breaking for users of adcp/client (already expects result); breaking for direct webhook consumers that parsed task fields at the root.
