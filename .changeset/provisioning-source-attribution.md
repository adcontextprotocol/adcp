---
---

feat(membership): track provisioning source on each org membership

Each row in `organization_memberships` now carries a `provisioning_source` tag identifying how it came to exist:

- `verified_domain` — `autoLinkByVerifiedDomain` matched the user's email domain to a verified org with auto-provision on
- `invited` — accepted via `POST /:orgId/invitations` or `/members/by-email` Path 1
- `admin_added` — created via `/members/by-email` Path 2 (admin/owner direct add)
- `webhook` — surfaced by an `organization_membership.created` event with no staged source (e.g. someone added the membership directly in the WorkOS dashboard)
- `null` — pre-existing rows that haven't been touched since this migration

The originating endpoint stages source + seat_type into `invitation_seat_types` (a new `source` column there). The `organization_membership.created` webhook handler reads both back via `consumeInvitationSeatType` and writes `provisioning_source` on the local cache row. The upsert preserves an existing source on conflict, so a subsequent webhook upsert can't wipe a more-specific origin.

Sets up the new-member digest in the auto-provision notification feature so org owners can see which auto-joined members showed up via verified-domain vs. were explicitly invited.

## Migration

`436_organization_membership_provisioning_source.sql` adds the columns and an index keyed on `(workos_organization_id, provisioning_source, created_at DESC)` for the digest query.
