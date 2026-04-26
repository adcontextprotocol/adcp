---
---

Auto-provision users into verified-domain orgs more aggressively, give org admins a self-service way to manage members by email, and let them opt out per org.

Closes the gap surfaced by the Triton Digital escalation: an org owner tried to promote someone with a verified-domain email to admin, but the system 404'd because the user wasn't yet a member of the org in WorkOS.

## Server changes

- `autoLinkByVerifiedDomain` runs on every authenticated request. The helper short-circuits internally when the user already has a row in the candidate org's local membership cache, so the cost stays close to one indexed query. Always provisions as `member`; the existing race-safe `upsertOrganizationMembership` SQL handles auto-promotion to `owner` for ownerless orgs (atomically, against the live table — no cache-skew risk).
- New `user.created` webhook step provisions users with verified emails into their employer's verified-domain org proactively, instead of lazily on first API hit.
- New `auto_provision_verified_domain` column on `organizations` (default `true`) — org owners and admins can flip it via `PATCH /api/organizations/:orgId/settings` to require explicit invites only.
- New `POST /api/organizations/:orgId/members/by-email` endpoint walks the four-state machine for callers (invite / create membership / update role / no-op). Authz mirrors the existing patterns: org admin/owner OR AAO super-admin can add members; only org owner OR AAO super-admin can change an existing member's role; only owner or AAO super-admin can assign the owner role.
- The invite path always invites as `member` regardless of the requested role (matching the bearer-credential downgrade discipline used in `routes/invites.ts`); admins promote after acceptance via the same endpoint.

## Migration

`433_auto_provision_verified_domain.sql` adds the opt-out flag with default `TRUE`.
