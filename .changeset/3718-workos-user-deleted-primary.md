---
"adcontextprotocol": patch
---

Security: handle WorkOS `user.deleted` for primary-bound users (#3718).

When a WorkOS user that is the primary credential on a multi-credential
identity was deleted (operator action, account closure, or GDPR/CCPA erasure
webhook), the CASCADE on `identity_workos_users.workos_user_id` dropped the
binding and left the identity with zero primaries. `attachIdentityId` then
resolved `primary_workos_user_id` to NULL, skipped the id-swap, and the
surviving secondary signed in to an empty workspace — a denial-of-service
against any non-primary user, reachable end-user-initiated via GDPR/CCPA.

The `user.deleted` handler now promotes the longest-bound surviving secondary
to primary in a single transaction before the CASCADE fires, mirroring the
`findSuccessorForPromotion` pattern already used by `deleteMembership`. The
handler also invalidates the session/JWT cache for both the deleted user and
the promoted successor to close the 60-second window where a cached id-swap
could still route reads to the dead binding. Promotion failures emit
`logger.warn` (auto-routed to `#admin-errors`) plus an explicit
`notifySystemError` ops alert, then return 200 so WorkOS doesn't retry-storm
the webhook; the identity is left in a recoverable state for an admin to
repair.
