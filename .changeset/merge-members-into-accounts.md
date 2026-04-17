---
---

Merge admin Members page into Accounts. `/admin/members` was a filtered slice of organizations with billing actions bolted on; `/admin/accounts` already supports `?view=members` and the detail page already renders subscription fields. This consolidates them:

- Account detail page gains a Billing card with Sync from Stripe, Payment History, and Delete Workspace actions.
- Accounts list page gains Sync from Stripe and Export CSV buttons when the Members tab is active.
- `/admin/members` and `/admin/members/:orgId` now 301 to `/admin/accounts`.
- Mislabeled "Organizations" sidebar entry (which actually pointed to `/admin/members`) removed.
- `/api/admin/members/*` endpoints moved under `/api/admin/accounts/*` (sync, payments, DELETE). The dead `PATCH /members/:orgId/memberships/:membershipId` endpoint was dropped — role updates go through `PUT /accounts/:orgId/members/:userId/role` in accounts.ts.
