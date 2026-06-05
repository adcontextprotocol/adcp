---
"adcontextprotocol": minor
---

Registry: community-mirror catalog lifecycle (#2176).

Makes AAO catalog-only adagents.json mirrors first-class registry resources. A community mirror is the catalog-only adagents.json (`authorized_agents: []` + formats/properties/placements) AAO publishes on behalf of a platform that hasn't adopted AdCP, served at `creative.adcontextprotocol.org/translated/<platform>/adagents.json`. Builds on #5352/#5353, which made `authorized_agents: []` valid.

- **Store:** new `community_mirrors` table (migration 506) keyed by `platform`, with the adagents.json body, `catalog_etag`, `superseded_by`, and provenance.
- **Endpoints** (`/api/registry/mirrors`):
  - `GET /api/registry/mirrors` — list mirrors with their `catalog_etag` (public).
  - `GET /api/registry/mirrors/:platform` — read one mirror (public).
  - `PUT /api/registry/mirrors/:platform` — idempotent publish/upsert (registry moderators or admins). Forces `authorized_agents: []`, requires catalog content, validates the proposal.
- **Serving:** `GET /translated/:platform/adagents.json` on the creative agent serves the stored mirror with an `ETag` (from `catalog_etag`, falling back to a content hash), `If-None-Match` → `304`, `Cache-Control`, and a `superseded_by` → `Link: rel="successor-version"` header.

Read-back by platform and listing close the gap where published mirrors could not be retrieved; the idempotent upsert lets audit fixes update in place instead of duplicating.
