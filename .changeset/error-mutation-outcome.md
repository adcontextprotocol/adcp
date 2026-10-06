---
"adcontextprotocol": minor
---

Add optional `mutation_outcome` (`not_applied`, `unknown`, `applied`; open wire type) to `core/error.json` so a seller can tell a buyer whether a failed state-changing request changed seller state. Defines "pre-commit evidence" (a timeout or exception from within or after a write call is never pre-commit evidence), scopes `unknown` on compound mutations to the whole request envelope, extends the same no-re-plan obligation to async `failed` tasks and webhooks, and sets `applied` on `COMMITTED_RESOURCE_PURGED`, and gates the new seller MUSTs on sellers declaring 3.3+. Buyers that ignore the field behave as before; absent-field guidance asks buyers to read state before re-planning after a `transient` mutation error.
