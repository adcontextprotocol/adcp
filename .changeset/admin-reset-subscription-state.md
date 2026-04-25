---
---

Add `POST /api/admin/accounts/:orgId/reset-subscription-state` — admin-only endpoint that atomically clears all subscription fields to NULL for orgs whose Stripe state is gone but whose DB rows are stale. Includes live-subscription safety guard, org-name confirmation, required reason field, and before-state snapshot in registry_audit_log.
