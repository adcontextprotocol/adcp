---
---

feat(aao): define directory inverse-lookup endpoint — `GET /v1/agents/{agent_url}/publishers` returns the set of publishers whose adagents.json authorizes a given agent_url, with provenance, per-publisher property counts, and lifecycle status.

**Why.** The push primitive (`verify_agent_authorization`) and the pull-with-list primitive (`fetch_agent_authorizations`) both presuppose the operator already knows the publisher set. At managed-network scale (Raptive: ~6,800 domains delegated to cafemedia.com) that presupposition fails. The AAO directory at `agenticadvertising.org` already indexes publisher adagents.json files — this RFC exposes the inverse map as a public HTTP endpoint so sales-agent operators can answer "what publishers have authorized my agent?" at sync time, without crawling the open web themselves.

**What this changeset defines** (spec-only — server implementation tracked separately, see Follow-ups).

1. **Endpoint shape** (`docs/aao/directory-api.mdx`). `GET /v1/agents/{agent_url}/publishers` with `since`, `cursor`, `status`, `limit` query parameters. Canonicalizes the `agent_url` lookup key the same way `verify_agent_authorization` does. Cursor-based pagination; opaque cursors.

2. **Response envelope schema** (`static/schemas/source/aao/agent-publishers.json`). Returns `{ agent_url, directory_indexed_at, publishers[], next_cursor }`. Each `PublisherEntry` carries `publisher_domain`, `discovery_method`, optional `manager_domain`, `properties_authorized`, `properties_total`, optional `signing_keys_pinned`, `status`, `last_verified_at`.

3. **`discovery_method` enum** — `direct`, `authoritative_location`, `adagents_authoritative`, `ads_txt_managerdomain`. Distinguishes the four trust profiles. The directory verifies the [`managerdomain` fallback safety rule](/docs/governance/property/adagents#safety-rules-for-this-fallback) before returning a row with `ads_txt_managerdomain` — bilateral verification done once, for everyone.

4. **Per-publisher scoped counts.** `properties_authorized` and `properties_total` are scoped to the row's `publisher_domain` only, never network-wide. Avoids the "12/12 = full auth but really 12-of-6800-network" misread that a flat count would produce on managed-network rows.

5. **Lifecycle status enum** (v1) — `authorized` and `revoked`. `unbound`, `pending`, `unreachable`, `no_properties` deferred — directory does not have the crawler state to emit them honestly. `revoked` propagates parent-file `revoked_publisher_domains[]` (from the managed-network-scale changeset) on the next sync, then drops the tombstone.

6. **HTTP semantics** — `200` (success, MAY be empty), `400` (malformed), `404` (never indexed; distinct from 200 + empty), `429` (rate-limited), `5xx` (retry). `ETag` + `Cache-Control` set; `If-None-Match` for conditional GET.

7. **Authentication** — none in v1. Publishers are public; the inverse map is public. Rate-limiting keyed on `agent_url` + IP. Identity-bound limits via RFC 9421 request signing arrive in a separate RFC if needed.

**Dependency.** `properties_total` on managed-network-shape parent files (the cafemedia case) depends on the [adcp#4825](https://github.com/adcontextprotocol/adcp/issues/4825) inline resolution rule. Strict federation at managed-network scale requires N HTTP fetches per directory refresh per publisher — the same scale problem operators have, moved one layer up. With inline resolution endorsed, the directory computes per-publisher counts from the parent file's inline `properties[]` filtered by matching `publisher_domain`.

**Follow-ups.**
- Server implementation in `server/src/routes/registry-api.ts` (new endpoint), backed by `server/src/db/federated-index-db.ts` (extends existing `getDomainsForAgent` shape with `discovery_method`, `manager_domain`, count resolution, `signing_keys_pinned`). Tracked: `feat(server): implement /v1/agents/{agent_url}/publishers endpoint` — to be filed.
- SDK companion: `fetch_agent_authorizations_from_directory(agent_url, directory_url)` in adcp-client-python (adcp-client-python#746) and TS/Go/Java mirrors.
- `?include=properties` for inline property detail — out of scope for v1; add later if operators ask.
