---
---

Make API key revoke idempotent: treat WorkOS 404 as success so double-clicks or already-deleted keys no longer surface as "Failed to revoke API key" errors to the user.
