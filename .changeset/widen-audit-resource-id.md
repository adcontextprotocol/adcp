---
---

Widen `registry_audit_log.resource_id` from `VARCHAR(255)` to `TEXT`. Several admin actions write resource identifiers (notably agent URLs) that can exceed 255 chars; overflow raised `22001` mid-transaction and rolled back the originating mutation. Closes #4502.
