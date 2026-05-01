---
---

Fix `PUT /api/me/linked-emails/primary` to call WorkOS before mutating the database, so a WorkOS rejection no longer leaves `users.email` and `organization_memberships.email` ahead of WorkOS. WorkOS email-collision errors (including the previously-unhandled `GenericServerException: This email is not available.`) are now classified by a dedicated `isEmailUnavailable` helper and surfaced as a friendly 409 instead of a generic 500.
