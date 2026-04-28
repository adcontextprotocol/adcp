---
---

Agent-side sync endpoints for the property-registry agent/authorization
catalog (PR 4b-snapshots of #3177). Two new endpoints under
`/api/registry/authorizations` give verification consumers (DSPs, sales
houses, agencies) a way to pull authorization rows without scraping
publisher manifests.

- **`GET /api/registry/authorizations?agent_url=<canonical>`** — narrow
  per-agent pull, the default for most adopters. Indexed via
  `idx_caa_by_agent`; returns the rows where the requested agent appears
  as `agent_url` (typically ≤ a few hundred rows). Pairs with
  `/api/registry/feed?entity_type=authorization` via the `X-Sync-Cursor`
  response header — consumers tail subsequent changes from the cursor
  position.

- **`GET /api/registry/authorizations/snapshot`** — bootstrap for
  inline verifiers that maintain a local copy. Streams gzipped NDJSON
  via a Postgres cursor in 10K-row batches so memory stays bounded as
  the table grows toward long-run scale (~5M rows, ~150-300 MB on the
  wire). `ETag` is the hash of the X-Sync-Cursor; clients can
  `If-None-Match` to skip a re-pull when nothing has changed.

Both endpoints accept `?include=raw|effective` (default `effective` —
applies the override layer via `v_effective_agent_authorizations`) and
`?evidence=<csv>` (default `adagents_json` only). `agent_claim` is
opt-in (`?evidence=adagents_json,agent_claim`) per spec line 391 to
prevent buy-side trust misuse.

`X-Sync-Cursor` is the most recent authorization event_id from
`catalog_events` — read via `ORDER BY event_id DESC LIMIT 1` since
Postgres has no `MAX(uuid)`. When zero events exist the all-zero
UUIDv7 sentinel `00000000-0000-7000-8000-000000000000` is returned so
the consumer can hand it to the feed endpoint unchanged.

Refs #3177. Spec: `specs/registry-authorization-model.md:374-401`.
Builds on #3244 (property-side readers), #3274 (catalog schema), #3314
(writer extension), #3312 (change-feed authorization events), #3352
(reader UNION cutover).
