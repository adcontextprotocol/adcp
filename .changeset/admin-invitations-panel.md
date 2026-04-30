---
---

Admin account-detail page now has an Invitations panel showing every membership invite for the org with status (pending, accepted, expired, revoked) plus per-row reinvite, revoke, and copy-link actions. A new `POST /api/admin/accounts/:orgId/invites/:token/reinvite` endpoint atomically revokes the original and issues a fresh invite. Sending an invite to an email that already has one pending now prompts to reinvite rather than silently creating a duplicate token. Companion to issue #3581.
