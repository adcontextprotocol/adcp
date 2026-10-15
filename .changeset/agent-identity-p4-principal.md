---
"adcontextprotocol": minor
---

Agent identity, P4 (#8118, DR-0023): first contact, binding, and relationship status, all on experimental surfaces.

**First contact and binding.** A Web Bot Auth signed caller's stable subject is its canonical origin. Verification alone never creates a principal. A binding is an explicit seller record made after the trust record lists the origin, and an origin maps to at most one principal. Binding onto an existing RFC 9421 principal needs explicit out-of-band approval. Under an `open` onboarding mode, `sync_principal` may create a new principal limited to that mode. Documented in `L2/accounts-and-agents.mdx` §First contact and binding and in the `sync_principal` / `get_principal` identity text.

**Relationship status.** `get_principal` adds an optional `relationship` (`core/principal-relationship.json`: `status` from the new `enums/principal-relationship-status.json`: pending_approval|active|suspended|blocked, with `pending_approval` matching the account status of the same name, `expires_at`, and an applicant-specific `setup`) on `current`, `recognized`, and `unconfigured` results. It is returned only to the authenticated caller, omitted when no relationship or application exists, and sent only in responses served at 3.3 or later (`x-added-in: 3.3.0`), because the 3.2 result arms are closed. `principal.changed` adds the reasons `relationship_changed` and `relationship_expiring`.
