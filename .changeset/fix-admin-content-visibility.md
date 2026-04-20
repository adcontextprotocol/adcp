---
---

Fix admin content visibility in `/dashboard/content`.

- `/api/me` now returns `isAdmin: true` for users in the `aao-admin` working group, matching the `requireAdmin` middleware. Previously it only checked the `ADMIN_EMAILS` env var, so working-group admins saw no "All Content" tab and no admin filters.
- Admins now land on the "All Content" tab by default. Editors need a full view of the library on entry, not just their own authored items.
