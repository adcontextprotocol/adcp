---
---

spec(accounts): caller-scope introspection via per-account `authorization` on sync/list + RBAC error codes

Caller-scope authorization model for AdCP. Sellers attach an optional `authorization` object to each per-account entry in `sync_accounts` and `list_accounts` responses — describing `allowed_tasks`, per-task `field_scopes`, an optional standard `scope_name`, and an optional `read_only` flag. Absence means the seller does not advertise introspectable scope; callers MUST NOT infer access from absence. Conceptually analogous to RFC 7662 OAuth 2.0 Token Introspection, specialized for AdCP's task-and-field authorization model and folded into existing account discovery rather than split into a new task.

Standard named scope `attestation_verifier` is spec-mandated (binds to Tier-2 Production Verified conformance). Other scope names are seller-specific and MUST use the `seller:` prefix so a typo of the standard value fails schema validation. Three new error codes surface RBAC decisions that previously had no standard code: `SCOPE_INSUFFICIENT`, `READ_ONLY_SCOPE`, `FIELD_NOT_PERMITTED`. `FIELD_NOT_PERMITTED` MUST populate `error.field`; `SCOPE_INSUFFICIENT` SHOULD carry an `introspection_hint` pointing at where to re-read scope. All four authz codes classify as `correctable` but are NOT agent-autonomous (scope broadening requires operator intervention) — agents SHOULD surface rather than auto-retry.

Closes #2964.
