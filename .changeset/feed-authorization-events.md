---
---

Authorization events on the registry change feed. Migration 442 adds
Postgres triggers on `catalog_agent_authorizations` (PR 4b-prereq) and
`adagents_authorization_overrides` (PR 1) that emit
`authorization.granted` / `.revoked` / `.modified` events into
`catalog_events`. Wire format pinned in
`specs/registry-authorization-model.md` ("Change-feed event shape").

Reader side: zero changes. The existing `/api/registry/feed` endpoint
already supports `event_type` glob filtering, so consumers subscribe
with `?types=authorization.*` and the new events flow through.

Trigger emission semantics:
- `granted` on base-row insert / un-tombstone, on `add` override insert,
  on `suppress` override supersede.
- `revoked` on base-row tombstone, on `add` override supersede, on
  `suppress` override insert (fans out per affected base row).
- `modified` on base-row UPDATE of `authorized_for` / `expires_at` /
  `disputed`. seq_no rotation alone produces no event.
- Override layer scoped to `evidence='adagents_json'` only; agent_claim
  and community rows pass through unaffected.

Drive-by: scoped `registry-feed.test.ts` cleanups to its own actor and
filtered queryFeed reads by event_type so concurrent test files writing
events via the new triggers don't trample shared catalog_events state.

Refs #3177. Builds on #3274 (schema). Spec #3251.
