---
"adcontextprotocol": patch
---

fix(server): align the WorkOS membership integrity invariant with the local membership cache schema.

The invariant no longer reads a nonexistent `organization_memberships.status` column when checking cached WorkOS memberships. This keeps the audit from failing before it can report stale local membership rows that should be reconciled by the WorkOS sync.
