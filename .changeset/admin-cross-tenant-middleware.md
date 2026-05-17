---
---

Push cross-tenant WorkOS API key refusal into `requireAdmin` so every admin route with a `:orgId` path param inherits the gate by default. `admin:*` is tenant-scoped by issuance — the permission grants admin access *within* the issuing org, not across orgs — and previously each cross-org admin route had to opt in to the check (or, more commonly, didn't). The new gate runs before the existing `admin:*` / `admin:read` permission checks; static `ADMIN_API_KEY` and SSO admin users are not tenant-scoped and pass through unchanged. Closes #4501. Also removes the redundant per-route helper that was added on the agent-removal route in #4609 / #4498.
