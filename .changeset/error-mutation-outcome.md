---
"adcontextprotocol": minor
---

Add optional `mutation_outcome` (`not_applied`, `unknown`, `applied`; open wire type) to `core/error.json` so a seller can tell a buyer whether a failed state-changing request changed seller state. Defines "pre-commit evidence" (a timeout or exception from within or after a write is never pre-commit evidence; `REFERENCE_DEFINITION_CHANGED` is the worked example of a pre-commit rejection), scopes `unknown` on compound mutations to the whole request envelope, extends the same no-re-plan obligation to async `failed` tasks and webhooks, and gives `COMMITTED_RESOURCE_PURGED` a SHOULD `applied` and a MUST NOT `not_applied`. Sellers declaring 3.3+ SHOULD emit `unknown` on a fenced claim in 3.3 (MUST from 3.4) and MUST NOT emit `unknown` without a fence. Buyers that ignore the field behave as before; absent-field guidance asks buyers to read state before re-planning after a `transient` mutation error.
