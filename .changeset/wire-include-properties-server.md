---
---

server: wire `?include=properties` through the registry endpoint so `property_ids[]` is returned in each `PublisherEntry` when the flag is set (#4890).

The spec-only changeset (`4890-aao-include-properties.md`) already documented the schema delta and docs. This changeset covers the server implementation:

- `federated-index-db.ts`: `AgentPublisherDetailRow` gains `property_ids?: string[] | null`; `getPublishersForAgentDetail` accepts `includePropertyIds` opt; SQL adds `CASE WHEN $6 THEN ARRAY_AGG(dp.property_id)` subquery that short-circuits when false.
- `federated-index.ts`: passes `includePropertyIds` through to the DB layer.
- `registry-api.ts`: parses `?include` (repeated-key, same encoding as `?status`; comma-separated form rejected 400; unknown values rejected 400); passes flag to service; serializes `property_ids` when set; updates ETag to cover the include flag and resolved IDs; updates `AgentPublishersEntrySchema` and OpenAPI query schema.
- Integration tests: DB-level (`registry-agent-publishers-detail.test.ts`) and HTTP-level (`registry-api-agent-publishers.test.ts`) coverage.
