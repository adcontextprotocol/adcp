---
---

Drop boot-time `OrganizationDatabase.syncFromWorkOS` call. The production WorkOS API key doesn't carry the workspace-level scope `listOrganizations` requires, so this call failed on every cold start with `UnauthorizedException: Could not authorize the request`, polluting the error stream. Orgs are created lazily via `ensureOrganizationExists` at first login and via the `organization.created` webhook, so the boot-time mirror is unnecessary. Closes #3954.
