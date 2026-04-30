---
"adcontextprotocol": minor
---

spec(accounts): caller-scope introspection via per-account `authorization` on sync/list + RBAC error codes

Caller-scope authorization model for AdCP. Vendor agents (media-buy, signals, governance, creative, brand) attach an optional `authorization` object to each per-account entry in `sync_accounts` and `list_accounts` responses — describing `allowed_tasks`, per-task `field_scopes`, an optional standard `scope_name`, and an optional `read_only` flag. Absence means the vendor agent does not advertise introspectable scope; callers MUST NOT infer access from absence. Conceptually analogous to RFC 7662 OAuth 2.0 Token Introspection, specialized for AdCP's task-and-field authorization model and folded into existing account discovery rather than split into a new task.

Standard named scope `attestation_verifier` is spec-mandated (binds to the AAO Verified (Live) qualifier; Media Buy Protocol). Other scope names are vendor-specific and MUST use the `custom:` prefix so a typo of the standard value fails schema validation. Three new error codes surface RBAC decisions that previously had no standard code: `SCOPE_INSUFFICIENT`, `READ_ONLY_SCOPE`, `FIELD_NOT_PERMITTED`. `FIELD_NOT_PERMITTED` MUST populate `error.field`; `SCOPE_INSUFFICIENT` SHOULD carry an `introspection_hint` pointing at where to re-read scope. All four authz codes classify as `correctable` but are NOT agent-autonomous (scope broadening requires operator intervention) — agents SHOULD surface rather than auto-retry.

Identity binding, refresh cadence, and consistency are normative: the authorization object is scoped to `(caller identity, account_id)` at read time; vendor agents MUST resolve identity from the authenticated request (not client-supplied fields) and reflect operator-initiated scope changes within 300 seconds. Sequential reads within the refresh window MUST return identical authorization objects (modulo operator-initiated changes) — flicker from load-balanced or eventually-consistent backends is non-conformant.

Closes #2964.
