---
"adcontextprotocol": patch
---

Add admin user simulation support for Addie web chat debugging.

This change enables admins to view and debug user context when chatting with Addie via the web interface:

- Detect WorkOS impersonation sessions in auth middleware
- Add member context lookup for web-authenticated users (getWebMemberContext)
- Add admin endpoint to view user context (`GET /api/admin/users/:userId/context`)
- Add impersonation audit logging to track admin activities
- Database migration for impersonation tracking columns
