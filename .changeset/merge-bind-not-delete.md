---
---

Account merge: bind, don't delete (Phase 2a of identity layer).

Rewrites `mergeUsers` so that confirming an "I have two accounts" link no
longer destroys the secondary WorkOS user. App-state rows still move to the
primary, but the secondary's WorkOS user stays alive — both emails remain
real, working sign-in credentials. The two WorkOS users end up bound to one
identity (the primary's); the secondary's orphan singleton identity is
dropped.

Auth middleware: when a non-primary binding signs in, swap `req.user.id` to
the identity's primary `workos_user_id` so existing app-state reads land on
the right person. The actual authenticated WorkOS user is preserved on
`req.user.authWorkosUserId` for WorkOS API calls and audit logs.

UI copy on the verify-email-link confirmation page now reads "signing in
with either email leads to the same workspace" instead of "this cannot be
undone." (It is, in fact, undoable now — Phase 2c will surface that.)

Future Ahmeds will be unblocked by Phase 2b (admin "create + bind" tool).
For Ahmed himself, the merge already happened under the old delete-the-
secondary semantics; he'll need that admin tool once it ships.
