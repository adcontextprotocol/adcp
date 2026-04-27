---
---

fix(team): static admin API key passes the AAO super-admin check on member endpoints

The new `/members/by-email` and `PATCH /:orgId/settings` endpoints used `isWebUserAAOAdmin(user.id)` for the super-admin override, which checks aao-admin working-group membership. The static admin API key (`ADMIN_API_KEY` env var, used by internal tooling and incident scripts) authenticates with a synthetic user id `admin_api_key` that isn't a real WorkOS user, so the working-group check returns false.

Both endpoints now also accept `req.isStaticAdminApiKey === true` (set by `requireAuth`) as super-admin equivalent — same posture every other admin-tooling-facing endpoint already takes. The `/members/by-email` path additionally skips the WorkOS `listOrganizationMemberships` lookup for the static-admin-API-key user, since the synthetic id has no memberships to find.

Adds `scripts/incidents/2026-04-triton-promote-hayem.ts` to resolve escalation #285 — a one-shot script that POSTs to `/api/organizations/org_01KC80TYK2QPPWQ7A8SGGGNHE7/members/by-email` for `raphael.hayem@tritondigital.com` as `admin`, walking whichever state the user is currently in.
