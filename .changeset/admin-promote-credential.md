---
---

Admin "promote credential to primary" tool.

New `POST /api/admin/users/:userId/credentials/:credentialId/promote`
endpoint and matching "Make primary" UI button on the `/admin/people`
detail panel.

Promote moves all of the current primary's app-state forward to the
target credential and swaps `is_primary` between the two. After this,
sign-ins via either bound credential resolve through the new primary
(via auth middleware id-swap) so reads land on the right workspace.

Use case (Ahmed-class): a credential ends up bound non-primary but is
the credential whose WorkOS org_membership puts the person in the org
they actually want to access. Without promote, sign-in via the canonical
primary lands on the wrong slice of data.
