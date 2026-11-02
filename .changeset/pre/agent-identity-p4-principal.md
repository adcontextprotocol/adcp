---
"adcontextprotocol": minor
---

Agent identity, P4 (#8118, DR-0023): first contact, binding, and relationship status, all on experimental surfaces.

**First contact and binding.** A Web Bot Auth signed caller's stable subject is its canonical origin. Whether and how that origin gets a principal (rule R5) is documented in `L2/accounts-and-agents.mdx` §First contact and binding and in the `sync_principal` / `get_principal` identity text.

**Relationship status.** `get_principal` adds an optional `relationship` (`core/principal-relationship.json`: `status` from the new `enums/principal-relationship-status.json`: pending_approval|active|suspended|blocked, with `pending_approval` matching the account status of the same name, `expires_at`, and an applicant-specific `setup`) on `current`, `recognized`, and `unconfigured` results. It is omitted when no relationship or application exists, and is marked `x-added-in: 3.3.0`. `principal.changed` adds the reasons `relationship_changed` and `relationship_expiring`.
