---
---

Replace the direct admin-invoice endpoint with a membership invitation flow. Admin picks a tier and enters a contact email; system creates an invite token, emails the prospect a link (`/invite/:token`), and no Stripe invoice is issued until the prospect signs in, accepts the membership agreement, and confirms billing. Kills `POST /api/admin/accounts/:orgId/invoice` (returns 410 on legacy prospects path). New endpoints: `POST /api/admin/accounts/:orgId/invite-membership`, `GET /api/admin/accounts/:orgId/invites`, `POST /api/admin/accounts/:orgId/invites/:token/revoke`. Removes the typo-prone free-text form that caused split Stripe customers.
