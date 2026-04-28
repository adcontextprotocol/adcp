---
---

Universal `resolveUserOrgMembership(workos, userId, orgId)` helper for the "is this user a member of this org, in what role?" auth-check pattern.

Replaces 14 copy-pasted call sites across `organizations.ts` and `member-profiles.ts` that did:

```ts
const memberships = await workos.userManagement.listOrganizationMemberships({ userId, organizationId });
if (memberships.data.length === 0) return res.status(403)...;
const role = resolveUserRole(memberships.data);
```

Two problems with the old pattern:
- Every admin-only org endpoint 403'd in dev mode because WorkOS doesn't know about `DEV_USERS`. Each route would need to copy the dev-mode bypass that lived in only one place (`member-profiles.ts`'s GET handler), and most didn't.
- Drift: 14 different versions of the same auth check, each with subtly different error messages and role logic.

The helper does it once: in dev mode it reads from local `organization_memberships` (seeded by `dev-setup.ts`), in prod it defers to WorkOS as source of truth. Returns `{ role, status } | null` — callers send their own 403 with appropriate message text.

Verified: every admin endpoint hit by the team page (`/api/organizations/:orgId/{domains,settings,roles,seat-requests,join-requests,members,...}`) now responds 200 to a dev-mode admin user. Previously most returned 403.
