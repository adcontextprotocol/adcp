---
---

Addie can now diagnose and resolve sign-in problems through four typed admin tools: `diagnose_signin_block` returns a verdict (needs_signin / needs_resend / needs_invite / needs_human) by composing person, invite, and org-membership state; `list_invites_for_org` lists pending+expired invites by default with a token suffix per row; `resend_invite` and `revoke_invite` wrap the existing endpoints. The DB-side `revokeMembershipInvite` and `getMembershipInviteByToken` helpers now accept an optional `org_id` for SQL-level scope enforcement (closes #3624). Companion to #3581.
