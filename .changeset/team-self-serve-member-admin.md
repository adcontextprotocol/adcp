---
---

feat(team): self-serve member admin in team.html, admins can change roles

Closes the self-service gap left after #3235 — an org owner can now do everything from the team UI without filing an escalation.

## What changed

- **Team UI consolidates "invite" and "promote" into one "Add member" flow** (`server/public/team.html`). The modal posts to the unified `POST /api/organizations/:orgId/members/by-email` endpoint that walks the four-state machine (invite / create / update / no-op). The same modal handles adding a new teammate and promoting an existing member.
- **Auto-provision toggle in the Verified Domains card** — owners can flip `auto_provision_verified_domain` per org via the existing `PATCH /api/organizations/:orgId/settings`. Hidden when no verified domain exists. Owner-only (admins shouldn't be able to widen org membership unilaterally, especially now that admins can promote auto-joined members to admin).
- **Admins can change member roles** — `PATCH /api/organizations/:orgId/members/:membershipId` and Path 3 of `/members/by-email` now allow org admins to promote `member ↔ admin`. Caps in place: admins can't assign `owner`, can't change a current owner's role, and (matching the existing PATCH endpoint) no caller of either endpoint can change their own role. Owners and AAO super-admins are unrestricted.
- **`/members/by-email` accepts `seat_type`** — the unified endpoint is now a true superset of `/invitations`. seat_type is staged via `invitation_seat_types` for both Path 1 (invite) and Path 2 (direct add) so the `organization_membership.created` webhook hands the right seat_type to the local cache. Path 2 clears any stale staging rows for the same `(org, email)` pair before staging, so a prior failed direct-add can't pollute a later invite.

## Tests

- New `server/tests/integration/member-by-email-policy.test.ts` (16 tests) covers all role-cap branches, self-role-change blocking on both endpoints, seat_type propagation, and the owner-only auto-provision toggle.
