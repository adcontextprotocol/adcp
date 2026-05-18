---
---

Apply the `requireGlobalAdmin` chain (added in #4646) to `/api/admin/feeds` and `/api/admin/notification-channels` — the two cousin admin routers that the round-3 security review on #4646 flagged at LOW severity. Both operate on cross-org / global state (industry-feeds rows and notification-channel config have no `organization_id` column) but were still gated only by `requireAuth, requireAdmin`, accepting any tenant-scoped WorkOS `admin:*` key. Migrating to `...requireGlobalAdmin` brings them to the same posture as `/api/admin/users` without waiting for `admin:*` issuance to broaden. Closes #4501.
