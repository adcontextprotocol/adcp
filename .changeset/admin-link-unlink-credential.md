---
---

Admin link-existing + unlink credential tools (Phase 2b cont.).

Two new admin endpoints on `/api/admin/users/:userId/credentials`:

- **`GET`** lists the WorkOS-user credentials bound to this user's identity.
- **`POST`** with `{ workos_user_id }` binds an EXISTING WorkOS user under
  this user's identity. Bypasses `createUser` entirely — fixes the case
  where an email already has a WorkOS user (e.g., a prior merge whose
  delete-secondary call silently failed) and `createUser` returns 400.
- **`DELETE /:credentialId`** unbinds a non-primary credential. The WorkOS
  user stays alive in WorkOS and gets a fresh singleton identity locally
  (becomes its own person again). Refuses on the primary credential to
  avoid locking the host out.

UI on `/admin/people` detail panel now lists the bound credentials, with
per-row "Remove" buttons (non-primary only) and a new "+ Link existing
WorkOS user" action alongside the existing "+ Add sign-in email."

Existing `POST /linked-emails` (the create-and-bind path) now surfaces the
real WorkOS error message when `createUser` fails, including the 400-
BadRequest-on-already-exists case, and points admins at the "Link
existing" tool.

Together these resolve the Ahmed-class escalation (email already in WorkOS
from a failed prior delete) and Pia's request (#291) to remove a linked
email. Closes #3719 (admin path for consolidating two existing accounts).
