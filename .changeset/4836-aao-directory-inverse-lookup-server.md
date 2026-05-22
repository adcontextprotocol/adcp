---
---

feat(aao): implement `GET /api/v1/agents/{agent_url}/publishers` directory inverse-lookup endpoint (#4836)

Server implementation of the spec landed in #4828. Returns the publishers whose `adagents.json` authorizes a given `agent_url`, with provenance (`discovery_method`, `manager_domain`), per-publisher property counts (`properties_authorized`, `properties_total`), signing-key pin status, and lifecycle state.

**What changes.**

1. **New SQL method** (`server/src/db/federated-index-db.ts`). `getPublishersForAgentDetail(agentUrl, opts)` unions the legacy `agent_publisher_authorizations` arm and the catalog-side `v_effective_agent_authorizations` arm (same dual-read pattern as the existing `getDomainsForAgent`), joins to the `publishers` overlay for `discovery_method` / `manager_domain` / cached `adagents_json` JSONB, and derives the response shape entirely in SQL:
   - `properties_total` / `properties_authorized`: correlated subqueries over `discovered_properties` and `agent_property_authorizations`, scoped to **this publisher only** (never network-wide — avoids the "12/12 vs 12-of-6800" misread that flat counts would produce on managed-network rows).
   - `signing_keys_pinned`: walks `adagents_json->'authorized_agents'` for entries whose canonicalized `url` matches the requested agent, returns `true` iff `signing_keys[]` is a non-empty array.
   - `status`: `revoked` when the parent file lists this `publisher_domain` in `revoked_publisher_domains[]`; otherwise `authorized`.

2. **New endpoint** (`server/src/routes/registry-api.ts`). `GET /api/v1/agents/:encodedUrl/publishers` mounted next to the existing legacy `/registry/lookup/agent/:agentUrl/domains` (which is kept; the new path is the richer public directory shape). Honors:
   - `since=<iso8601>` — incremental sync filter against `publishers.last_validated`.
   - `cursor=<opaque>` — base64url-encoded `publisher_domain` for stable ASC pagination.
   - `status=authorized,revoked` — comma-separated filter; default `authorized` only.
   - `limit=<1..1000>` — default 200. Caller-fetched `limit+1` enables next-page detection without a second round-trip.
   - `If-None-Match` — returns `304` when the response fingerprint (cursor + filter + content hash) matches.
   - `200` vs `404`: 404 only when **no filter is in effect AND** the directory has never indexed any publisher referencing this `agent_url`. Otherwise 200 with possibly-empty `publishers[]` — distinct semantics per the spec.

3. **Federated-index wrapper** (`server/src/federated-index.ts`). Re-exports the DB method behind `getPublishersForAgentDetail` so the route doesn't reach into the DB layer directly.

4. **Integration tests** (`server/tests/integration/registry-agent-publishers-detail.test.ts`). Covers: empty result, direct-discovery row with `signing_keys_pinned: true`, `ads_txt_managerdomain` with `manager_domain` populated, empty/missing `signing_keys` array, `status: revoked` from `revoked_publisher_domains[]`, agent-URL canonicalization on the JSONB side (mixed case + trailing slash), cursor pagination, `since` filter, and isolation from other agents' authorizations.

**Out of scope (deferred).**

- `adagents_authoritative` as a fourth `discovery_method` value — the spec schema allows it, but the crawler currently only emits the three values from migration 470 (`direct`, `authoritative_location`, `ads_txt_managerdomain`). Adding the fourth requires crawler changes to detect inline-resolution discovery via parent-file `properties[].publisher_domain` matching; tracked as follow-up under #4836 once cafemedia-shape parent files start indexing.
- `?include=properties` for inline property detail — counts-only v1 per the spec.
- Authentication. Public endpoint with anonymous rate limiting via `registryReadRateLimiter`.
