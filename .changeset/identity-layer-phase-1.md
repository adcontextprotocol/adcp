---
---

Add identity layer foundation (Phase 1, no functional change).

A WorkOS user is one credential bundle for one email. An "identity" is the
person — and a person can have multiple emails, each backed by its own WorkOS
user. Today every user is its own singleton identity. Phase 2 will rewrite
the account-merge flow to bind multiple WorkOS users to one identity instead
of deleting the secondary user, so that "linked emails" actually work for
sign-in (each email is a real WorkOS user) and our DB becomes a truthful
cache of WorkOS state.

Migration 460 adds `identities` and `identity_workos_users`, backfills 1:1
from `users`, and installs an AFTER INSERT trigger so any new user
automatically gets a singleton identity. Auth middleware now resolves
`identityId` on `req.user` for real users (synthetic admin/API-key users skip
it). No app code reads `identityId` yet.
