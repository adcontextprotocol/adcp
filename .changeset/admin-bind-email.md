---
---

Admin "bind sign-in email" tool (Phase 2b of identity layer).

New endpoint `POST /api/admin/users/:userId/linked-emails` that creates a
fresh WorkOS user for a given email and binds it as a non-primary
credential under the existing user's identity. After this, the user can
sign in with either email; the auth middleware id-swaps non-primary logins
to the canonical workos_user_id so they see the same workspace.

UI: an "Add sign-in email" button on the admin /admin/people detail
panel for users that have a `workos_user_id` (i.e., have ever signed in
via WorkOS, not Slack-only people).

Trust model: admin asserts the email belongs to the person. No verification
email is sent. The endpoint refuses if the email is already an existing
AAO account — that case is the higher-risk consolidation path tracked in
issue #3719.

Direct fix for Ahmed-class escalations (lost sign-in via gmail after the
old delete-the-secondary merge flow): admin clicks "Add sign-in email,"
enters gmail, done.
