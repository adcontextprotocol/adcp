---
---

Server: three code-hygiene fixes in the admin org-membership path after #4909.

- Update stale comment in `autoLinkByVerifiedDomain` (membership-db.ts) to reflect #4909's ownerless-org-promotion flow (`resolveRoleWithWorkosFirstPromote` via WorkOS list, replacing the deleted NOT EXISTS subquery).
- Remove inner shadowed `orgDb` in workos-webhooks.ts (uses module-level instance instead).
- Add explicit type annotation for `let newMembership` in the admin add-users loop.

Refs #4911. Security items and the `organization_membership_already_exists` handler tracked separately in that issue.
