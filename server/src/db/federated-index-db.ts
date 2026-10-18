import { getClient, query, queryWithTimeout } from './client.js';
import type { PoolClient } from 'pg';
import { canonicalizePublisherDomain } from '../services/publisher-domain.js';
import {
  isSpecExactAgentMatch,
  registryAgentUrlLookupKey,
} from './registry-agent-url-key.js';

/**
 * Discovered agent from adagents.json or list_authorized_properties
 */
export interface DiscoveredAgent {
  id?: string;
  agent_url: string;
  source_type: 'adagents_json' | 'list_authorized_properties';
  source_domain: string;
  name?: string;
  agent_type?: string;
  protocol?: string;
  discovered_at?: Date;
  last_validated?: Date;
  expires_at?: Date;
  probe_failure_count?: number;
  next_probe_after?: Date;
}

/**
 * Discovered publisher from sales agent list_authorized_properties
 */
export interface DiscoveredPublisher {
  id?: string;
  domain: string;
  discovered_by_agent: string;
  discovered_at?: Date;
  last_validated?: Date;
  has_valid_adagents?: boolean;
  expires_at?: Date;
}

/**
 * Agent-publisher authorization.
 *
 * `source` distinguishes how strongly the row is attested:
 *  - `adagents_json`: the publisher's origin actually serves a valid
 *    adagents.json (either directly at /.well-known or via a stub with
 *    `authoritative_location`). Origin-verified.
 *  - `aao_hosted`: AAO is hosting the canonical document on the
 *    publisher's behalf, but the publisher's origin has NOT been
 *    verified to point at us yet. The hosted document represents the
 *    publisher's intent; it does not yet carry the same trust weight as
 *    an origin-verified row. Promotion to `adagents_json` requires a
 *    successful round-trip fetch of the publisher's /.well-known.
 *  - `agent_claim`: the agent claimed authorization via a
 *    list_authorized_properties response; the publisher has not
 *    confirmed it.
 */
export interface AgentPublisherAuthorization {
  id?: string;
  agent_url: string;
  publisher_domain: string;
  authorized_for?: string;
  property_ids?: string[];
  source: 'adagents_json' | 'aao_hosted' | 'agent_claim';
  discovered_at?: Date;
  last_validated?: Date;
}

/**
 * Detailed agent → publisher row for the AAO directory inverse-lookup
 * endpoint (adcp#4823). Layered on top of AgentPublisherAuthorization
 * with provenance, per-publisher counts, and lifecycle status — all
 * computed from the cached publishers.adagents_json blob.
 */
export interface AgentPublisherDetailRow {
  publisher_domain: string;
  source: 'adagents_json' | 'agent_claim';
  authz_last_validated: Date | null;
  publisher_last_validated: Date | null;
  discovery_method: 'direct' | 'authoritative_location' | 'ads_txt_managerdomain' | 'adagents_authoritative' | 'community_catalog' | null;
  manager_domain: string | null;
  properties_total: number;
  properties_authorized: number;
  property_ids: string[] | null;
  signing_keys_pinned: boolean;
  status: 'authorized' | 'revoked';
}

/**
 * Property identifier from adagents.json
 */
export interface PropertyIdentifier {
  type: string;  // domain, ios_bundle, android_package, etc.
  value: string;
}

/**
 * Discovered property from adagents.json properties array
 */
export interface DiscoveredProperty {
  id?: string;
  property_id?: string;  // Optional ID from adagents.json
  publisher_domain: string;
  property_type: string;  // website, mobile_app, ctv_app, etc.
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  source_type?: 'adagents_json' | 'aao_hosted' | 'community';
  discovered_at?: Date;
  last_validated?: Date;
  expires_at?: Date;
}

/**
 * Agent-property authorization
 */
export interface AgentPropertyAuthorization {
  id?: string;
  agent_url: string;
  property_id: string;  // UUID of discovered_properties row
  authorized_for?: string;
  discovered_at?: Date;
}

/**
 * Publisher property selector from AdCP Product schema.
 * Supports three selection patterns: all, by_id, by_tag
 */
export type PublisherPropertySelector =
  | { publisher_domain: string; selection_type: 'all' }
  | { publisher_domain: string; selection_type: 'by_id'; property_ids: string[] }
  | { publisher_domain: string; selection_type: 'by_tag'; property_tags: string[] };

/**
 * Database operations for federated discovery index
 */
export class FederatedIndexDatabase {
  // ============================================
  // Reverse Lookups (indexed for fast queries)
  // ============================================

  /**
   * Get all agents authorized for a specific domain.
   *
   * UNION over the legacy `agent_publisher_authorizations` table and the
   * catalog-side `v_effective_agent_authorizations` (publisher-wide rows
   * only — `property_rid IS NULL`) during the #3177 dual-read window.
   * Legacy wins on (agent_url, publisher_domain, source) collisions so
   * callers that hold a legacy row's `property_ids` keep seeing them
   * during cutover. Catalog evidence values are coerced to the legacy
   * source vocabulary: 'override' → 'adagents_json' (moderator-authoritative),
   * 'community' → 'agent_claim' (lower trust). After PR 5 the legacy
   * arm is removed and the query collapses to catalog-only.
   */
  async getAgentsForDomain(domain: string): Promise<AgentPublisherAuthorization[]> {
    const result = await query<AgentPublisherAuthorization>(
      `WITH unioned AS (
         SELECT agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated, 0 AS src_priority
           FROM agent_publisher_authorizations
          WHERE publisher_domain = $1
         UNION ALL
         SELECT
           v.agent_url,
           v.publisher_domain,
           v.authorized_for,
           NULL::text[] AS property_ids,
           CASE v.evidence
             WHEN 'adagents_json'          THEN 'adagents_json'
             WHEN 'agent_claim'            THEN 'agent_claim'
             WHEN 'override'               THEN 'adagents_json'
             WHEN 'community'              THEN 'agent_claim'
             WHEN 'adagents_authoritative' THEN 'adagents_json'
           END AS source,
           v.created_at AS discovered_at,
           v.updated_at AS last_validated,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.publisher_domain = $1
            AND v.property_rid IS NULL
            AND v.property_id_slug IS NULL
       ), deduped AS (
         SELECT DISTINCT ON (agent_url, publisher_domain, source)
                agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated
           FROM unioned
          ORDER BY agent_url, publisher_domain, source, src_priority
       )
       SELECT * FROM deduped ORDER BY source, agent_url`,
      [domain]
    );
    return result.rows;
  }

  /**
   * The raw `agent_url` values stored under this agent's identity key that
   * are SPEC-EXACTLY the same agent (#7829 semantics, trailing slash
   * significant).
   *
   * The key folds a trailing slash so one agent has one row (#7830). The
   * directory must not: if a publisher authorized `https://a.example/mcp/`,
   * a listing for `https://a.example/mcp` must not report it. So every
   * per-agent authorization read looks rows up by key — which is what the
   * indexes are on — and then restricts to these raw values.
   *
   * Cheap: the key lookup is indexed and a single agent has a handful of
   * distinct raw spellings, so this is one small indexed read regardless of
   * registry size. Returns `[]` when nothing matches, which makes every
   * caller's `= ANY($n)` correctly match nothing.
   */
  private async specExactAgentUrls(agentUrl: string): Promise<string[]> {
    const key = registryAgentUrlLookupKey(agentUrl);
    const result = await query<{ agent_url: string }>(
      `SELECT DISTINCT agent_url FROM v_effective_agent_authorizations
        WHERE agent_url_canonical = $1`,
      [key],
    );
    return result.rows
      .map(row => row.agent_url)
      .filter(rowUrl => isSpecExactAgentMatch(rowUrl, agentUrl));
  }

  /**
   * Get all publisher domains for a specific agent.
   *
   * UNION over legacy + catalog (publisher-wide rows). See
   * getAgentsForDomain for evidence→source mapping and dual-read
   * rationale. The catalog arm is keyed on the registry key the app
   * computed ($2) — spec canonicalization needs IDN, dot-segment and
   * percent-encoding handling that SQL cannot do (#7830). The legacy arm is
   * keyed on the raw input to preserve historical behavior on non-canonical
   * legacy data.
   */
  async getDomainsForAgent(agentUrl: string): Promise<AgentPublisherAuthorization[]> {
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await query<AgentPublisherAuthorization>(
      `WITH unioned AS (
         SELECT agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated, 0 AS src_priority
           FROM agent_publisher_authorizations
          WHERE agent_url = $1
         UNION ALL
         SELECT
           v.agent_url,
           v.publisher_domain,
           v.authorized_for,
           NULL::text[] AS property_ids,
           CASE v.evidence
             WHEN 'adagents_json'          THEN 'adagents_json'
             WHEN 'agent_claim'            THEN 'agent_claim'
             WHEN 'override'               THEN 'adagents_json'
             WHEN 'community'              THEN 'agent_claim'
             WHEN 'adagents_authoritative' THEN 'adagents_json'
           END AS source,
           v.created_at AS discovered_at,
           v.updated_at AS last_validated,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = $2
            AND v.agent_url = ANY($3::text[])
            AND v.property_rid IS NULL
            AND v.property_id_slug IS NULL
       ), deduped AS (
         SELECT DISTINCT ON (agent_url, publisher_domain, source)
                agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated
           FROM unioned
          ORDER BY agent_url, publisher_domain, source, src_priority
       )
       SELECT * FROM deduped ORDER BY source, publisher_domain`,
      [agentUrl, registryAgentUrlLookupKey(agentUrl), specExact]
    );
    return result.rows;
  }

  /**
   * Detailed publisher row for the AAO directory inverse-lookup endpoint
   * (adcp#4823 / GET /v1/agents/{agent_url}/publishers). Layered on top of
   * the existing publisher → agent authorization edge with provenance
   * (discovery_method, manager_domain), per-publisher property counts,
   * signing-key pin status, and revocation lifecycle.
   *
   * Computed at query time from the cached `publishers.adagents_json`
   * JSONB blob — no per-row HTTP fetches. Every derivation that does not
   * need the registry agent-URL key lives in SQL; `signing_keys_pinned`
   * needs it (manifest entries carry raw URLs), so it is resolved in one
   * follow-up query over the page's publishers and matched in the app —
   * SQL cannot reproduce the spec canonicalization (#7830).
   */
  async getPublishersForAgentDetail(
    agentUrl: string,
    opts: {
      cursor?: string;
      since?: Date;
      includeRevoked?: boolean;
      includePropertyIds?: boolean;
      limit: number;
    },
  ): Promise<AgentPublisherDetailRow[]> {
    const since = opts.since ?? null;
    const cursor = opts.cursor ?? '';
    const limit = opts.limit;
    const includeRevoked = opts.includeRevoked ?? false;
    const includePropertyIds = opts.includePropertyIds ?? false;

    // Dual-read pattern matches getDomainsForAgent / getAgentsForDomain:
    // UNION ALL with explicit src_priority (legacy=0 wins on collision) +
    // DISTINCT ON ordered by (publisher_domain, src_priority,
    // authz_last_validated DESC) so the surviving row is deterministic and
    // freshest. The catalog arm matches on the registry key the app computed
    // ($7); the legacy arm stays keyed on the raw input.
    const agentKey = registryAgentUrlLookupKey(agentUrl);
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await query<AgentPublisherDetailRow>(
      `WITH authz_unioned AS (
         SELECT publisher_domain, source, last_validated AS authz_last_validated, 0 AS src_priority
           FROM agent_publisher_authorizations
          WHERE agent_url = $1
         UNION ALL
         SELECT
           v.publisher_domain,
           CASE v.evidence
             WHEN 'adagents_json'          THEN 'adagents_json'
             WHEN 'agent_claim'            THEN 'agent_claim'
             WHEN 'override'               THEN 'adagents_json'
             WHEN 'community'              THEN 'agent_claim'
             WHEN 'adagents_authoritative' THEN 'adagents_json'
           END AS source,
           v.updated_at AS authz_last_validated,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = $7
            AND v.agent_url = ANY($8::text[])
            AND v.property_rid IS NULL
            AND v.property_id_slug IS NULL
       ), dedup AS (
         SELECT DISTINCT ON (publisher_domain)
                publisher_domain, source, authz_last_validated
           FROM authz_unioned
          ORDER BY publisher_domain, src_priority, authz_last_validated DESC NULLS LAST
       ), enriched AS (
         -- Derive is_revoked once per row and reuse it in both the SELECT
         -- and the WHERE. Walking the JSONB twice (status CASE + WHERE NOT
         -- EXISTS) per row dominates the query plan at managed-network
         -- fan-outs. signing_keys_pinned used to be derived here too; it
         -- moved to signingKeysPinnedByPublisher when matching a manifest
         -- entry to an agent became app-side key equality (#7830).
         --
         -- For fan-out children (publishers.adagents_json IS NULL, with
         -- manager_domain set), revocation must consult the MANAGER's
         -- blob — that's where revoked_publisher_domains[] lives for a
         -- managed-network parent file. Without the manager-side check
         -- the spec's "Revocation under inline resolution" rule (adagents
         -- .mdx §Resolution paths) is unenforceable for the canonical
         -- cafemedia case.
         SELECT
           d.publisher_domain,
           d.source,
           d.authz_last_validated,
           pub.last_validated AS publisher_last_validated,
           pub.discovery_method,
           pub.manager_domain,
           (
             EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                   COALESCE(pub.adagents_json->'revoked_publisher_domains', '[]'::jsonb)
                 ) AS rpd
                WHERE rpd->>'publisher_domain' = d.publisher_domain
             )
             OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                   COALESCE(mgr.adagents_json->'revoked_publisher_domains', '[]'::jsonb)
                 ) AS rpd
                WHERE rpd->>'publisher_domain' = d.publisher_domain
             )
           ) AS is_revoked
         FROM dedup d
         LEFT JOIN publishers pub ON pub.domain = d.publisher_domain
         LEFT JOIN publishers mgr ON mgr.domain = pub.manager_domain
       )
       SELECT
         e.publisher_domain,
         e.source,
         e.authz_last_validated,
         e.publisher_last_validated,
         e.discovery_method,
         e.manager_domain,
         -- properties_total: count of properties under THIS publisher_domain
         -- in discovered_properties. Per-publisher scope; never network-wide.
         COALESCE((
           SELECT COUNT(*)::int
             FROM discovered_properties dp
            WHERE dp.publisher_domain = e.publisher_domain
         ), 0) AS properties_total,
         -- properties_authorized: count of canonical property_id strings under
         -- THIS publisher_domain the agent is authorized for. Filtered to
         -- dp.property_id IS NOT NULL so this count is symmetric with the
         -- property_ids ARRAY_AGG below (MUST len(property_ids) ==
         -- properties_authorized per spec).
         COALESCE((
           SELECT COUNT(DISTINCT dp.property_id)::int
             FROM agent_property_authorizations apa
             JOIN discovered_properties dp ON dp.id = apa.property_id
            WHERE apa.agent_url = $1
              AND dp.publisher_domain = e.publisher_domain
              AND dp.property_id IS NOT NULL
         ), 0) AS properties_authorized,
         -- property_ids: resolved property_id strings, present only when
         -- ?include=properties was requested ($6=true). CASE WHEN short-circuits
         -- the subquery when false, so there is no cost on default calls.
         -- Only properties with a non-null property_id are included.
         CASE WHEN $6::boolean THEN (
           SELECT ARRAY_AGG(DISTINCT dp.property_id ORDER BY dp.property_id)
             FROM agent_property_authorizations apa
             JOIN discovered_properties dp ON dp.id = apa.property_id
            WHERE apa.agent_url = $1
              AND dp.publisher_domain = e.publisher_domain
              AND dp.property_id IS NOT NULL
         ) ELSE NULL END AS property_ids,
         CASE WHEN e.is_revoked THEN 'revoked' ELSE 'authorized' END AS status
       FROM enriched e
       WHERE e.publisher_domain > $2
         AND ($3::timestamptz IS NULL OR COALESCE(e.publisher_last_validated, e.authz_last_validated) >= $3)
         AND ($4::boolean OR NOT e.is_revoked)
       ORDER BY e.publisher_domain
       LIMIT $5`,
      [agentUrl, cursor, since, includeRevoked, limit, includePropertyIds, agentKey, specExact],
    );
    const pinned = await this.signingKeysPinnedByPublisher(
      agentKey,
      result.rows.map(row => row.publisher_domain),
    );
    return result.rows.map(row => ({
      ...row,
      signing_keys_pinned: pinned.has(row.publisher_domain),
    }));
  }

  /**
   * Which of `publisherDomains` pin at least one signing key for the agent
   * keyed as `agentKey`, read from each publisher's cached manifest.
   *
   * Split out of getPublishersForAgentDetail because matching a manifest
   * entry to an agent is registry-key equality, and the key is only
   * computable in the app (#7830). Bounded by the caller's page size.
   */
  private async signingKeysPinnedByPublisher(
    agentKey: string,
    publisherDomains: string[],
  ): Promise<Set<string>> {
    const pinned = new Set<string>();
    if (publisherDomains.length === 0) return pinned;
    const result = await query<{ publisher_domain: string; agent_url: string; has_keys: boolean }>(
      `SELECT pub.domain AS publisher_domain,
              agent->>'url' AS agent_url,
              (jsonb_typeof(agent->'signing_keys') = 'array'
               AND jsonb_array_length(agent->'signing_keys') > 0) AS has_keys
         FROM publishers pub
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(pub.adagents_json->'authorized_agents') = 'array'
               THEN pub.adagents_json->'authorized_agents'
               ELSE '[]'::jsonb END
        ) AS agent
        WHERE pub.domain = ANY($1::text[])
          AND jsonb_typeof(agent->'url') = 'string'`,
      [publisherDomains],
    );
    for (const row of result.rows) {
      if (!row.has_keys) continue;
      if (registryAgentUrlLookupKey(row.agent_url) !== agentKey) continue;
      pinned.add(row.publisher_domain);
    }
    return pinned;
  }

  /**
   * Bulk-fetch first authorization for multiple agents in a single query.
   * Returns a Map from agent_url to its first AgentPublisherAuthorization.
   *
   * UNION over legacy + catalog (publisher-wide rows). Legacy wins on
   * (agent_url) collision; within an arm, source ASC preserves the
   * "adagents_json over agent_claim" preference. Catalog evidence is
   * coerced to legacy source values ('override' → 'adagents_json',
   * 'community' → 'agent_claim') so the source field round-trips as
   * the literal 'adagents_json' | 'agent_claim' callers expect.
   */
  async bulkGetFirstAuthForAgents(agentUrls: string[]): Promise<Map<string, AgentPublisherAuthorization>> {
    if (agentUrls.length === 0) return new Map();

    const map = new Map<string, AgentPublisherAuthorization>();
    const BATCH_SIZE = 1000;

    for (let i = 0; i < agentUrls.length; i += BATCH_SIZE) {
      const batch = agentUrls.slice(i, i + BATCH_SIZE);
      // Registry key per input, computed in the app — SQL cannot reproduce
      // the spec canonicalization (#7830). The legacy arm is still keyed on
      // the raw input to preserve historical behavior on non-canonical
      // legacy data, and gets its dedup key from the same app-side mapping
      // ($1/$3 unnest side by side) rather than re-deriving it in SQL.
      const batchKeys = batch.map(registryAgentUrlLookupKey);
      // Spec-exact raw spellings across the whole batch: the catalog arm is
      // restricted to them so the directory cannot report an authorization
      // the #7829 validator would deny.
      const specExact = (await Promise.all(batch.map(url => this.specExactAgentUrls(url)))).flat();
      const canonicalToInput = new Map<string, string>();
      // First-wins: if multiple inputs share a key, the first one in the
      // batch is the lookup key. Callers don't pass duplicates today.
      batch.forEach((u, idx) => {
        const key = batchKeys[idx];
        if (!canonicalToInput.has(key)) canonicalToInput.set(key, u);
      });
      const canonical = Array.from(canonicalToInput.keys());
      // Both arms emit a `dedup_canonical` column (the registry key of
      // their agent_url). DISTINCT ON dedup_canonical collapses cases
      // where the same agent has both a legacy row and a catalog row.
      // src_priority=0 means legacy wins on collision.
      const result = await query<AgentPublisherAuthorization & { dedup_canonical: string }>(
        `WITH inputs AS (
           SELECT raw_url, registry_key FROM unnest($1::text[], $3::text[])
             AS t(raw_url, registry_key)
         ), unioned AS (
           SELECT
             i.registry_key AS dedup_canonical,
             apa.agent_url, apa.publisher_domain, apa.authorized_for,
             apa.property_ids, apa.source, apa.discovered_at, apa.last_validated,
             0 AS src_priority
             FROM agent_publisher_authorizations apa
             JOIN inputs i ON i.raw_url = apa.agent_url
           UNION ALL
           SELECT
             v.agent_url_canonical AS dedup_canonical,
             v.agent_url,
             v.publisher_domain,
             v.authorized_for,
             NULL::text[] AS property_ids,
             CASE v.evidence
               WHEN 'adagents_json'          THEN 'adagents_json'
               WHEN 'agent_claim'            THEN 'agent_claim'
               WHEN 'override'               THEN 'adagents_json'
               WHEN 'community'              THEN 'agent_claim'
               WHEN 'adagents_authoritative' THEN 'adagents_json'
             END AS source,
             v.created_at AS discovered_at,
             v.updated_at AS last_validated,
             1 AS src_priority
             FROM v_effective_agent_authorizations v
            WHERE v.agent_url_canonical = ANY($2)
              AND v.agent_url = ANY($4::text[])
              AND v.property_rid IS NULL
              AND v.property_id_slug IS NULL
         )
         SELECT DISTINCT ON (dedup_canonical)
                dedup_canonical,
                agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated
           FROM unioned
          ORDER BY dedup_canonical, src_priority, source, publisher_domain`,
        [batch, canonical, batchKeys, specExact]
      );
      for (const row of result.rows) {
        // Re-key the result to the input verbatim the caller asked
        // about (so map.get(input) works regardless of casing/slash
        // differences between input and stored value).
        const key = canonicalToInput.get(row.dedup_canonical) ?? row.agent_url;
        const { dedup_canonical, ...auth } = row as AgentPublisherAuthorization & { dedup_canonical: string };
        void dedup_canonical;
        map.set(key, auth);
      }
    }
    return map;
  }

  /**
   * Check whether a publisher domain has a valid adagents.json.
   *
   * Reads from both the catalog-side `publishers` overlay (PR 1 of #3177)
   * and the legacy `discovered_publishers` table during the dual-write
   * window. A presence in `publishers` with `source_type='adagents_json'`
   * means the crawler successfully validated and cached the publisher-origin
   * file. Community catalog rows are intentionally excluded here: they are
   * valid registry documents, but not origin validation, and must not suppress
   * crawl-on-view or turn hosting.mode into `self`.
   */
  async hasValidAdagents(domain: string): Promise<boolean | null> {
    const result = await query<{ catalog_present: boolean; catalog_invalid: boolean; legacy_or: boolean | null }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM publishers
            WHERE domain = $1
              AND adagents_json IS NOT NULL
              AND source_type = 'adagents_json'
              AND review_status = 'approved'
         ) AS catalog_present,
         EXISTS(
           SELECT 1 FROM publishers
            WHERE domain = $1
              AND source_type <> 'adagents_json'
              AND (
                last_validation_error IS NOT NULL
                OR last_validation_issues IS NOT NULL
              )
         ) AS catalog_invalid,
         (SELECT bool_or(has_valid_adagents)
            FROM discovered_publishers
           WHERE domain = $1) AS legacy_or`,
      [domain]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.catalog_present) return true;
    if (row.catalog_invalid) return false;
    if (row.legacy_or === null) return null;
    return row.legacy_or;
  }

  async markPublisherHasInvalidAdagents(domain: string): Promise<void> {
    await query(
      `UPDATE discovered_publishers
          SET has_valid_adagents = FALSE,
              last_validated = NOW()
        WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * Get sales agents that claim to sell for a domain
   * Uses idx_discovered_publishers_domain index
   */
  async getSalesAgentsClaimingDomain(domain: string): Promise<DiscoveredPublisher[]> {
    const result = await query<DiscoveredPublisher>(
      `SELECT domain, discovered_by_agent, discovered_at, last_validated, has_valid_adagents, expires_at
       FROM discovered_publishers
       WHERE domain = $1
       ORDER BY discovered_by_agent`,
      [domain]
    );
    return result.rows;
  }

  /**
   * Get all agent→domain pairs in a single query (for bulk snapshots).
   *
   * UNION over legacy + catalog (publisher-wide rows). SQL dedups what it
   * can see — a pair identical on both sides — and the one caller,
   * FederatedIndexService.getAllAgentDomainPairs, folds the rest by registry
   * key as it builds its Map. The legacy arm stores raw URLs and spec
   * canonicalization is app-only (#7830), so the cross-arm fold cannot
   * happen here; doing it twice would just move bytes around.
   */
  async getAllAgentDomainPairs(): Promise<Array<{ agent_url: string; publisher_domain: string }>> {
    const result = await query<{ agent_url: string; publisher_domain: string }>(
      `SELECT agent_url, publisher_domain
         FROM agent_publisher_authorizations
       UNION
       SELECT v.agent_url_canonical AS agent_url, v.publisher_domain
         FROM v_effective_agent_authorizations v
        WHERE v.property_rid IS NULL
          AND v.property_id_slug IS NULL
        ORDER BY agent_url`
    );
    return result.rows;
  }

  // ============================================
  // List All
  // ============================================

  /**
   * Get all discovered agents, optionally filtered by type
   */
  async getAllDiscoveredAgents(agentType?: string): Promise<DiscoveredAgent[]> {
    let sql = `
      SELECT id, agent_url, source_type, source_domain, name, agent_type, protocol,
             discovered_at, last_validated, expires_at,
             probe_failure_count, next_probe_after
      FROM discovered_agents
    `;
    const params: unknown[] = [];

    if (agentType) {
      sql += ` WHERE agent_type = $1`;
      params.push(agentType);
    }

    sql += ` ORDER BY discovered_at DESC`;

    const result = await query<DiscoveredAgent>(sql, params);
    return result.rows;
  }

  /**
   * Get all discovered publishers
   */
  async getAllDiscoveredPublishers(): Promise<DiscoveredPublisher[]> {
    const result = await query<DiscoveredPublisher>(
      `SELECT DISTINCT ON (domain)
         domain, discovered_by_agent, discovered_at, last_validated, has_valid_adagents, expires_at
       FROM discovered_publishers
       ORDER BY domain, discovered_at DESC`
    );
    return result.rows;
  }

  /**
   * Get all unique domains from discovered publishers
   */
  async getAllDiscoveredDomains(): Promise<string[]> {
    const result = await query<{ domain: string }>(
      `SELECT DISTINCT domain FROM discovered_publishers ORDER BY domain`
    );
    return result.rows.map(r => r.domain);
  }

  // ============================================
  // CRUD Operations (for crawler)
  // ============================================

  /**
   * Hard-delete legacy adagents_json authorization rows for a
   * publisher whose canonical agent_url is no longer in the latest
   * crawled manifest. Called once per domain after the per-agent
   * upsert loop. agent_claim rows are untouched (they belong to a
   * different publisher's discovery flow).
   *
   * `currentAgentUrls` is the manifest's agent URL list in any form; both
   * sides are reduced to the registry key here before comparison, so a
   * historical non-canonical row still matches.
   */
  async reconcileAdagentsAuthorizations(
    publisherDomain: string,
    currentAgentUrls: string[],
  ): Promise<void> {
    // Both sides are keyed in the app: SQL cannot reproduce the spec
    // canonicalization (#7830), and keying only one side would silently
    // delete every adagents_json row for the publisher.
    //
    // This reads the publisher's stored URLs first and then deletes the
    // stale ones by exact value, rather than expressing "not in the current
    // set" as a single SQL predicate. Both statements run in one transaction
    // with the read taken FOR UPDATE, so the pair is as atomic as the single
    // statement it replaced. Deleting by value is fail-safe in the same way
    // the old CASE expression was: a stored URL that cannot be keyed simply
    // doesn't match any current key and is removed, and an empty delete list
    // is a no-op.
    //
    // Cross-publisher safety: both statements are scoped by
    // `publisher_domain` and `source='adagents_json'`, so no row belonging
    // to another publisher or to the agent_claim flow is ever considered.
    const keep = new Set<string>();
    for (const url of currentAgentUrls) keep.add(registryAgentUrlLookupKey(url));
    const client = await getClient();
    try {
      await client.query('BEGIN');
      // FOR UPDATE, so a concurrent crawl of the same publisher either waits
      // for this delete or is already visible to it. Without the lock, a row
      // re-added between the read and the delete would be removed anyway —
      // the single-statement form this replaced could not do that.
      const stored = await client.query<{ agent_url: string }>(
        `SELECT agent_url
           FROM agent_publisher_authorizations
          WHERE publisher_domain = $1
            AND source = 'adagents_json'
          FOR UPDATE`,
        [publisherDomain],
      );
      const stale = [...new Set(stored.rows
        .map(row => row.agent_url)
        .filter(agentUrl => !keep.has(registryAgentUrlLookupKey(agentUrl))))];
      if (stale.length > 0) {
        await client.query(
          `DELETE FROM agent_publisher_authorizations
            WHERE publisher_domain = $1
              AND source = 'adagents_json'
              AND agent_url = ANY($2::text[])`,
          [publisherDomain, stale],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Upsert a discovered agent
   */
  async upsertAgent(agent: DiscoveredAgent): Promise<DiscoveredAgent> {
    const result = await query<DiscoveredAgent>(
      `INSERT INTO discovered_agents (
         agent_url, source_type, source_domain, name, agent_type, protocol, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (agent_url) DO UPDATE SET
         source_type = EXCLUDED.source_type,
         source_domain = EXCLUDED.source_domain,
         name = COALESCE(EXCLUDED.name, discovered_agents.name),
         agent_type = COALESCE(EXCLUDED.agent_type, discovered_agents.agent_type),
         protocol = COALESCE(EXCLUDED.protocol, discovered_agents.protocol),
         last_validated = NOW(),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        agent.agent_url,
        agent.source_type,
        agent.source_domain,
        agent.name || null,
        agent.agent_type || null,
        agent.protocol || 'mcp',
        agent.expires_at || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Upsert a discovered publisher
   */
  async upsertPublisher(publisher: DiscoveredPublisher): Promise<DiscoveredPublisher> {
    const result = await query<DiscoveredPublisher>(
      `INSERT INTO discovered_publishers (
         domain, discovered_by_agent, has_valid_adagents, expires_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain, discovered_by_agent) DO UPDATE SET
         last_validated = NOW(),
         has_valid_adagents = COALESCE(EXCLUDED.has_valid_adagents, discovered_publishers.has_valid_adagents),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        publisher.domain,
        publisher.discovered_by_agent,
        publisher.has_valid_adagents ?? false,
        publisher.expires_at || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Upsert an agent-publisher authorization
   */
  async upsertAuthorization(auth: AgentPublisherAuthorization): Promise<AgentPublisherAuthorization> {
    const result = await query<AgentPublisherAuthorization>(
      `INSERT INTO agent_publisher_authorizations (
         agent_url, publisher_domain, authorized_for, property_ids, source
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_url, publisher_domain, source) DO UPDATE SET
         authorized_for = COALESCE(EXCLUDED.authorized_for, agent_publisher_authorizations.authorized_for),
         property_ids = COALESCE(EXCLUDED.property_ids, agent_publisher_authorizations.property_ids),
         last_validated = NOW()
       RETURNING *`,
      [
        auth.agent_url,
        auth.publisher_domain,
        auth.authorized_for || null,
        auth.property_ids || null,
        auth.source,
      ]
    );
    return result.rows[0];
  }

  /**
   * Update agent metadata (name, type, protocol) after probing
   */
  async updateAgentMetadata(
    agentUrl: string,
    metadata: { name?: string; agent_type?: string; protocol?: string },
    client?: PoolClient,
  ): Promise<void> {
    const executeQuery: typeof query = client ? (text, params) => client.query(text, params) : query;
    await executeQuery(
      `UPDATE discovered_agents
       SET name = COALESCE($2, name),
           agent_type = COALESCE($3, agent_type),
           protocol = COALESCE($4, protocol),
           last_validated = NOW()
       WHERE agent_url = $1`,
      [agentUrl, metadata.name || null, metadata.agent_type || null, metadata.protocol || null]
    );
  }

  /**
   * Register an agent discovered via publisher_properties as a sales_candidate.
   * Only writes sales_candidate when the existing agent_type is NULL or 'unknown' —
   * never downgrades a confirmed type (sales, creative, signals, buyer).
   */
  async upsertSalesCandidate(agentUrl: string, sourceDomain: string): Promise<void> {
    await query(
      `INSERT INTO discovered_agents (agent_url, source_type, source_domain, agent_type)
       VALUES ($1, 'adagents_json', $2, 'sales_candidate')
       ON CONFLICT (agent_url) DO UPDATE SET
         agent_type = CASE
           WHEN discovered_agents.agent_type IS NULL OR discovered_agents.agent_type = 'unknown'
           THEN 'sales_candidate'
           ELSE discovered_agents.agent_type
         END,
         last_validated = NOW()`,
      [agentUrl, sourceDomain]
    );
  }

  /**
   * Return sales_candidate agents that are due for probing (backoff window has expired).
   */
  async getSalesCandidatesForProbe(): Promise<DiscoveredAgent[]> {
    const result = await query<DiscoveredAgent>(
      `SELECT id, agent_url, source_type, source_domain, name, agent_type, protocol,
              discovered_at, last_validated, expires_at,
              probe_failure_count, next_probe_after
       FROM discovered_agents
       WHERE agent_type = 'sales_candidate'
         AND (next_probe_after IS NULL OR next_probe_after <= NOW())`,
      []
    );
    return result.rows;
  }

  /**
   * Promote a sales_candidate to a confirmed sales agent and reset backoff.
   */
  async promoteSalesCandidateToSales(agentUrl: string): Promise<void> {
    await query(
      `UPDATE discovered_agents
       SET agent_type = 'sales',
           probe_failure_count = 0,
           next_probe_after = NULL,
           last_validated = NOW()
       WHERE agent_url = $1 AND agent_type = 'sales_candidate'`,
      [agentUrl]
    );
  }

  /**
   * Record a failed probe for a sales_candidate and advance the backoff window.
   * Schedule: first failure → 1 day, 1–2 failures → 7 days, 3+ → 30 days.
   */
  async recordSalesCandidateProbeFailure(agentUrl: string): Promise<void> {
    await query(
      `UPDATE discovered_agents
       SET probe_failure_count = probe_failure_count + 1,
           next_probe_after = NOW() + CASE
             WHEN probe_failure_count = 0 THEN INTERVAL '1 day'
             WHEN probe_failure_count < 3  THEN INTERVAL '7 days'
             ELSE INTERVAL '30 days'
           END,
           last_validated = NOW()
       WHERE agent_url = $1 AND agent_type = 'sales_candidate'`,
      [agentUrl]
    );
  }

  /**
   * Mark publisher as having valid adagents.json
   */
  async markPublisherHasValidAdagents(domain: string): Promise<void> {
    await query(
      `UPDATE discovered_publishers
       SET has_valid_adagents = TRUE, last_validated = NOW()
       WHERE domain = $1`,
      [domain]
    );
  }

  // ============================================
  // Property CRUD (for crawler)
  // ============================================

  /**
   * Upsert a discovered property
   */
  async upsertProperty(property: DiscoveredProperty): Promise<DiscoveredProperty> {
    const result = await query<DiscoveredProperty>(
      `INSERT INTO discovered_properties (
         property_id, publisher_domain, property_type, name, identifiers, tags, source_type, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (publisher_domain, name, property_type) DO UPDATE SET
         property_id = COALESCE(EXCLUDED.property_id, discovered_properties.property_id),
         identifiers = EXCLUDED.identifiers,
         tags = EXCLUDED.tags,
         last_validated = NOW(),
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        property.property_id || null,
        property.publisher_domain,
        property.property_type,
        property.name,
        JSON.stringify(property.identifiers),
        property.tags || [],
        property.source_type || 'adagents_json',
        property.expires_at || null,
      ]
    );
    return this.deserializeProperty(result.rows[0]);
  }

  /**
   * Link an agent to a property
   */
  async upsertAgentPropertyAuthorization(auth: AgentPropertyAuthorization): Promise<AgentPropertyAuthorization> {
    const result = await query<AgentPropertyAuthorization>(
      `INSERT INTO agent_property_authorizations (
         agent_url, property_id, authorized_for
       ) VALUES ($1, $2, $3)
       ON CONFLICT (agent_url, property_id) DO UPDATE SET
         authorized_for = COALESCE(EXCLUDED.authorized_for, agent_property_authorizations.authorized_for)
       RETURNING *`,
      [
        auth.agent_url,
        auth.property_id,
        auth.authorized_for || null,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get all properties for an agent (via agent_property_authorizations).
   *
   * UNION over legacy `agent_property_authorizations`-JOIN-`discovered_properties`
   * and the catalog-side per-property authorization rows (resolved
   * through `catalog_properties` → `publishers.adagents_json` JSONB to
   * recover name/type/identifiers/tags). Legacy wins on
   * (publisher_domain, name, property_type) collisions per the same
   * pattern as `getPropertiesForDomain` (PR 4a).
   */
  async getPropertiesForAgent(agentUrl: string): Promise<DiscoveredProperty[]> {
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await query<DiscoveredProperty>(
      `WITH unioned AS (
         SELECT p.id, p.property_id, p.publisher_domain, p.property_type, p.name,
                p.identifiers, p.tags, p.discovered_at, p.last_validated, p.expires_at,
                0 AS src_priority
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE apa.agent_url = $1
         UNION ALL
         SELECT
           cp.property_rid AS id,
           prop->>'property_id' AS property_id,
           pub.domain AS publisher_domain,
           prop->>'property_type' AS property_type,
           prop->>'name' AS name,
           CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
                THEN prop->'identifiers'
                ELSE '[]'::jsonb END AS identifiers,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(prop->'tags') = 'array'
                    THEN prop->'tags'
                    ELSE '[]'::jsonb END
             )),
             ARRAY[]::text[]
           ) AS tags,
           cp.created_at AS discovered_at,
           pub.last_validated AS last_validated,
           pub.expires_at AS expires_at,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
           JOIN catalog_properties cp ON cp.property_rid = v.property_rid
           JOIN publishers pub ON pub.domain = regexp_replace(cp.created_by, '^[^:]+:', '')
                              AND pub.source_type = 'adagents_json'
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(pub.adagents_json->'properties') = 'array'
                 THEN pub.adagents_json->'properties'
                 ELSE '[]'::jsonb END
          ) AS prop
          WHERE v.agent_url_canonical = $2
            AND v.agent_url = ANY($3::text[])
            AND v.property_rid IS NOT NULL
            -- Slug-match catalog row to manifest entry. Slugless catalog
            -- rows (cp.property_id IS NULL) can't be uniquely tied to a
            -- manifest entry without name+type on catalog_properties (a
            -- schema gap tracked as a follow-up). They're silently
            -- dropped from the catalog arm here; the legacy arm still
            -- surfaces them during the dual-read window.
            AND prop->>'property_id' IS NOT NULL
            AND cp.property_id IS NOT NULL
            AND prop->>'property_id' = cp.property_id
            AND prop->>'name' IS NOT NULL
            AND prop->>'property_type' IS NOT NULL
            AND LOWER(REGEXP_REPLACE(
                  REGEXP_REPLACE(
                    BTRIM(COALESCE(NULLIF(prop->>'publisher_domain', ''), pub.domain)),
                    '^https?://',
                    '',
                    'i'
                  ),
                  '[./]+$',
                  ''
                )) = pub.domain
       ), deduped AS (
         SELECT DISTINCT ON (publisher_domain, name, property_type)
                id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at
           FROM unioned
          ORDER BY publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY publisher_domain, property_type, name`,
      [agentUrl, registryAgentUrlLookupKey(agentUrl), specExact]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get an agent's authorized properties for one publisher domain.
   *
   * Publisher-facing reads must use this scoped form. Calling
   * getPropertiesForAgent() and filtering in application code makes response
   * time proportional to the agent's entire network. A network agent with
   * thousands of publishers can otherwise turn a one-property publisher read
   * into a registry-wide JSONB walk and sort.
   */
  async getPropertiesForAgentDomain(
    agentUrl: string,
    publisherDomain: string,
  ): Promise<DiscoveredProperty[]> {
    const canonicalDomain = canonicalizePublisherDomain(publisherDomain);
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await queryWithTimeout<DiscoveredProperty>(
      `WITH unioned AS (
         SELECT p.id, p.property_id, p.publisher_domain, p.property_type, p.name,
                p.identifiers, p.tags, p.discovered_at, p.last_validated, p.expires_at,
                0 AS src_priority
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE apa.agent_url = $1
            AND p.publisher_domain = $2
         UNION ALL
         SELECT
           cp.property_rid AS id,
           prop->>'property_id' AS property_id,
           pub.domain AS publisher_domain,
           prop->>'property_type' AS property_type,
           prop->>'name' AS name,
           CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
                THEN prop->'identifiers'
                ELSE '[]'::jsonb END AS identifiers,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(prop->'tags') = 'array'
                    THEN prop->'tags'
                    ELSE '[]'::jsonb END
             )),
             ARRAY[]::text[]
           ) AS tags,
           cp.created_at AS discovered_at,
           pub.last_validated AS last_validated,
           pub.expires_at AS expires_at,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
           JOIN catalog_properties cp ON cp.property_rid = v.property_rid
           JOIN publishers pub ON pub.domain = regexp_replace(cp.created_by, '^[^:]+:', '')
                              AND pub.source_type = 'adagents_json'
                              AND pub.domain = $2
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(pub.adagents_json->'properties') = 'array'
                 THEN pub.adagents_json->'properties'
                 ELSE '[]'::jsonb END
          ) AS prop
          WHERE v.agent_url_canonical = $3
            AND v.agent_url = ANY($4::text[])
            AND v.publisher_domain = $2
            AND v.property_rid IS NOT NULL
            AND prop->>'property_id' IS NOT NULL
            AND cp.property_id IS NOT NULL
            AND prop->>'property_id' = cp.property_id
            AND prop->>'name' IS NOT NULL
            AND prop->>'property_type' IS NOT NULL
            AND LOWER(REGEXP_REPLACE(
                  REGEXP_REPLACE(
                    BTRIM(COALESCE(NULLIF(prop->>'publisher_domain', ''), pub.domain)),
                    '^https?://',
                    '',
                    'i'
                  ),
                  '[./]+$',
                  ''
                )) = pub.domain
       ), deduped AS (
         SELECT DISTINCT ON (publisher_domain, name, property_type)
                id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at
           FROM unioned
          ORDER BY publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY publisher_domain, property_type, name`,
      [agentUrl, canonicalDomain, registryAgentUrlLookupKey(agentUrl), specExact],
      5_000,
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get all properties for a publisher domain.
   *
   * UNION over the legacy `discovered_properties` table and the catalog-side
   * `publishers.adagents_json` JSONB during the dual-write window of #3177.
   * The legacy half wins on (publisher_domain, name, property_type)
   * collisions so callers that hold a `discovered_properties.id` keep
   * dereferencing it correctly. Catalog-only rows surface for properties
   * that landed via the new writer path but didn't get a legacy row (e.g.
   * post-seed gatavo.com / Setupad #218). After PR 5 the legacy half is
   * removed and the query collapses to catalog-only.
   */
  async getPropertiesForDomain(domain: string): Promise<DiscoveredProperty[]> {
    const canonicalDomain = canonicalizePublisherDomain(domain);
    const result = await query<DiscoveredProperty>(
      `WITH unioned AS (
         SELECT id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at,
                source_type,
                CASE
                  WHEN source_type IN ('adagents_json', 'aao_hosted') THEN 0
                  WHEN source_type = 'community' THEN 2
                  ELSE 3
                END AS src_priority
           FROM discovered_properties
          WHERE publisher_domain = $1
         UNION ALL
         SELECT
           cp.property_rid AS id,
           prop->>'property_id' AS property_id,
           p.domain AS publisher_domain,
           prop->>'property_type' AS property_type,
           prop->>'name' AS name,
           CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
                THEN prop->'identifiers'
                ELSE '[]'::jsonb END AS identifiers,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(prop->'tags') = 'array'
                    THEN prop->'tags'
                    ELSE '[]'::jsonb END
             )),
             ARRAY[]::text[]
           ) AS tags,
           cp.created_at AS discovered_at,
           p.last_validated AS last_validated,
           p.expires_at AS expires_at,
           CASE
             WHEN p.source_type = 'community' THEN 'community'
             ELSE 'adagents_json'
           END AS source_type,
           CASE
             WHEN p.source_type = 'community' THEN 2
             ELSE 0
           END AS src_priority
           FROM publishers p
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.adagents_json->'properties') = 'array'
                 THEN p.adagents_json->'properties'
                 ELSE '[]'::jsonb END
          ) AS prop
           LEFT JOIN catalog_properties cp
                  ON cp.property_id = prop->>'property_id'
                 AND cp.created_by = CASE
                   WHEN p.source_type = 'community'
                    AND p.discovery_method = 'community_catalog'
                    AND p.created_by_user_id IS NOT NULL
                   THEN p.created_by_user_id
                   ELSE 'adagents_json:' || p.domain
                 END
          WHERE p.domain = $1
            AND p.source_type IN ('adagents_json', 'community')
            AND p.review_status = 'approved'
            AND prop->>'name' IS NOT NULL
            AND prop->>'property_type' IS NOT NULL
            AND LOWER(REGEXP_REPLACE(
                  REGEXP_REPLACE(
                    BTRIM(COALESCE(NULLIF(prop->>'publisher_domain', ''), p.domain)),
                    '^https?://',
                    '',
                    'i'
                  ),
                  '[./]+$',
                  ''
                )) = p.domain
       ), deduped AS (
         SELECT DISTINCT ON (publisher_domain, name, property_type)
                id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at,
                source_type
           FROM unioned
          ORDER BY publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY property_type, name`,
      [canonicalDomain]
    );
    return result.rows.map(row => this.deserializeProperty(row));
  }

  /**
   * Get publisher domains for an agent (from properties).
   *
   * UNION over legacy + catalog (per-property rows; UNION collapses
   * cross-arm duplicates so a domain that has both a legacy row and a
   * catalog row surfaces once).
   */
  async getPublisherDomainsForAgent(agentUrl: string): Promise<string[]> {
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await query<{ publisher_domain: string }>(
      `SELECT DISTINCT publisher_domain FROM (
         SELECT p.publisher_domain
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE apa.agent_url = $1
         UNION
         SELECT v.publisher_domain
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = $2
            AND v.agent_url = ANY($3::text[])
            AND v.property_rid IS NOT NULL
       ) sub
       ORDER BY publisher_domain`,
      [agentUrl, registryAgentUrlLookupKey(agentUrl), specExact]
    );
    return result.rows.map(r => r.publisher_domain);
  }

  /**
   * Find agents that can sell a specific property by identifier.
   *
   * UNION over legacy (JSONB containment lookup on
   * `discovered_properties.identifiers`) and catalog (lookup via
   * `catalog_identifiers` keyed on lowercased identifier_value, then
   * recover property metadata from `publishers.adagents_json` JSONB).
   * Legacy wins on (agent_url, publisher_domain, name, property_type)
   * collisions during the dual-read window.
   */
  async findAgentsForPropertyIdentifier(
    identifierType: string,
    identifierValue: string
  ): Promise<Array<{ agent_url: string; property: DiscoveredProperty; publisher_domain: string }>> {
    const result = await query<{
      agent_url: string;
      publisher_domain: string;
      id: string;
      property_id: string;
      property_type: string;
      name: string;
      identifiers: string;
      tags: string[];
    }>(
      `WITH unioned AS (
         SELECT apa.agent_url, p.publisher_domain, p.id, p.property_id,
                p.property_type, p.name, p.identifiers, p.tags, 0 AS src_priority
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE p.identifiers @> $1::jsonb
         UNION ALL
         SELECT
           v.agent_url,
           pub.domain AS publisher_domain,
           cp.property_rid AS id,
           prop->>'property_id' AS property_id,
           prop->>'property_type' AS property_type,
           prop->>'name' AS name,
           CASE WHEN jsonb_typeof(prop->'identifiers') = 'array'
                THEN prop->'identifiers'
                ELSE '[]'::jsonb END AS identifiers,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(prop->'tags') = 'array'
                    THEN prop->'tags'
                    ELSE '[]'::jsonb END
             )),
             ARRAY[]::text[]
           ) AS tags,
           1 AS src_priority
           FROM catalog_identifiers ci
           JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
           JOIN v_effective_agent_authorizations v ON v.property_rid = cp.property_rid
           JOIN publishers pub ON pub.domain = regexp_replace(cp.created_by, '^[^:]+:', '')
                              AND pub.source_type = 'adagents_json'
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(pub.adagents_json->'properties') = 'array'
                 THEN pub.adagents_json->'properties'
                 ELSE '[]'::jsonb END
          ) AS prop
          WHERE ci.identifier_type = $2
            -- Catalog stores identifier_value lowercase (schema CHECK).
            -- Legacy discovered_properties.identifiers JSONB containment
            -- match in arm 1 uses raw $1 — historical legacy data may
            -- not be lowercase. Asymmetry resolves at PR 5 (legacy drop).
            AND ci.identifier_value = LOWER($3)
            AND v.property_rid IS NOT NULL
            -- See getPropertiesForAgent: slugless catalog rows can't be
            -- uniquely tied to a manifest entry today (no name/type on
            -- catalog_properties). They drop here; legacy still serves.
            AND prop->>'property_id' IS NOT NULL
            AND cp.property_id IS NOT NULL
            AND prop->>'property_id' = cp.property_id
            AND prop->>'name' IS NOT NULL
            AND prop->>'property_type' IS NOT NULL
       ), deduped AS (
         SELECT DISTINCT ON (agent_url, publisher_domain, name, property_type)
                agent_url, publisher_domain, id, property_id, property_type,
                name, identifiers, tags
           FROM unioned
          ORDER BY agent_url, publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY publisher_domain, agent_url`,
      [
        JSON.stringify([{ type: identifierType, value: identifierValue }]),
        identifierType,
        identifierValue,
      ]
    );

    return result.rows.map(row => ({
      agent_url: row.agent_url,
      publisher_domain: row.publisher_domain,
      property: this.deserializeProperty(row),
    }));
  }

  /**
   * Deserialize property row (parse JSONB identifiers)
   */
  private deserializeProperty(row: any): DiscoveredProperty {
    return {
      ...row,
      identifiers: typeof row.identifiers === 'string'
        ? JSON.parse(row.identifiers)
        : row.identifiers || [],
    };
  }

  // ============================================
  // Validation Queries
  // ============================================

  /**
   * Validate agent authorization against publisher_properties array (Product schema format).
   * Returns detailed breakdown per selector showing what's authorized vs not.
   *
   * @param agentUrl - The agent URL to validate
   * @param publisherProperties - Array of publisher property selectors (same format as Product.publisher_properties)
   * @returns Detailed validation result per selector
   */
  async validateAgentForProduct(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<{
    authorized: boolean;
    coverage_percentage: number;
    total_requested: number;
    total_authorized: number;
    selectors: Array<{
      publisher_domain: string;
      selection_type: 'all' | 'by_id' | 'by_tag';
      requested_count: number;
      authorized_count: number;
      unauthorized_items?: string[];  // IDs or tags not covered
      source: 'adagents_json' | 'agent_claim' | 'none';
    }>;
  }> {
    const selectorResults: Array<{
      publisher_domain: string;
      selection_type: 'all' | 'by_id' | 'by_tag';
      requested_count: number;
      authorized_count: number;
      unauthorized_items?: string[];
      source: 'adagents_json' | 'agent_claim' | 'none';
    }> = [];

    let totalRequested = 0;
    let totalAuthorized = 0;

    for (const selector of publisherProperties) {
      let result: { requested: number; authorized: number; unauthorized?: string[]; source: 'adagents_json' | 'agent_claim' | 'none' };

      switch (selector.selection_type) {
        case 'all':
          result = await this.validateSelectorAll(agentUrl, selector.publisher_domain);
          break;
        case 'by_id':
          result = await this.validateSelectorByIds(agentUrl, selector.publisher_domain, selector.property_ids);
          break;
        case 'by_tag':
          result = await this.validateSelectorByTags(agentUrl, selector.publisher_domain, selector.property_tags);
          break;
      }

      selectorResults.push({
        publisher_domain: selector.publisher_domain,
        selection_type: selector.selection_type,
        requested_count: result.requested,
        authorized_count: result.authorized,
        unauthorized_items: result.unauthorized,
        source: result.source,
      });

      totalRequested += result.requested;
      totalAuthorized += result.authorized;
    }

    const coveragePercentage = totalRequested > 0 ? Math.round((totalAuthorized / totalRequested) * 100) : 0;

    return {
      authorized: totalAuthorized === totalRequested && totalRequested > 0,
      coverage_percentage: coveragePercentage,
      total_requested: totalRequested,
      total_authorized: totalAuthorized,
      selectors: selectorResults,
    };
  }

  /**
   * Validate "all" selector - agent must have authorization for the publisher domain.
   *
   * Counts both total and authorized properties from the unioned
   * (legacy ∪ catalog) view via the existing readers — that's the only
   * place the dual-read shape is materialized. In-memory derivation
   * keeps validateSelectorAll honest with whatever
   * getPropertiesForDomain / getAuthorizedPropertiesForDomain return.
   */
  private async validateSelectorAll(
    agentUrl: string,
    publisherDomain: string
  ): Promise<{ requested: number; authorized: number; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    const allProps = await this.getPropertiesForDomain(publisherDomain);
    const authorizedProps = await this.getAuthorizedPropertiesForDomain(agentUrl, publisherDomain);
    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);
    return {
      requested: allProps.length,
      authorized: authorizedProps.length,
      source,
    };
  }

  /**
   * Validate "by_id" selector - check specific property IDs.
   *
   * Derives authorized IDs from getAuthorizedPropertiesByIds so the
   * UNION'd authorization view answers in one place.
   */
  private async validateSelectorByIds(
    agentUrl: string,
    publisherDomain: string,
    propertyIds: string[]
  ): Promise<{ requested: number; authorized: number; unauthorized: string[]; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    if (propertyIds.length === 0) {
      return { requested: 0, authorized: 0, unauthorized: [], source: 'none' };
    }

    const authorizedProps = await this.getAuthorizedPropertiesByIds(agentUrl, publisherDomain, propertyIds);
    const authorizedIds = new Set(authorizedProps.map((p) => p.property_id).filter((id): id is string => !!id));
    const unauthorizedIds = propertyIds.filter((id) => !authorizedIds.has(id));
    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);

    return {
      requested: propertyIds.length,
      authorized: authorizedIds.size,
      unauthorized: unauthorizedIds,
      source,
    };
  }

  /**
   * Validate "by_tag" selector - check properties matching tags.
   *
   * Derives total count + authorized count + tag coverage from the
   * unioned property reads. requested counts properties whose tags
   * overlap propertyTags (matches `tags && $2` in the legacy SQL);
   * authorized counts the agent's authorized subset of those; tag
   * coverage is the union of all tags carried by authorized matches.
   */
  private async validateSelectorByTags(
    agentUrl: string,
    publisherDomain: string,
    propertyTags: string[]
  ): Promise<{ requested: number; authorized: number; unauthorized: string[]; source: 'adagents_json' | 'agent_claim' | 'none' }> {
    if (propertyTags.length === 0) {
      return { requested: 0, authorized: 0, unauthorized: [], source: 'none' };
    }

    const tagSet = new Set(propertyTags);
    const allProps = await this.getPropertiesForDomain(publisherDomain);
    const totalCount = allProps.filter((p) => (p.tags || []).some((t) => tagSet.has(t))).length;

    const authorizedProps = await this.getAuthorizedPropertiesByTags(agentUrl, publisherDomain, propertyTags);

    const coveredTags = new Set<string>();
    for (const prop of authorizedProps) {
      for (const tag of prop.tags || []) coveredTags.add(tag);
    }
    const unauthorizedTags = propertyTags.filter((tag) => !coveredTags.has(tag));

    const source = await this.getAuthorizationSource(agentUrl, publisherDomain);

    return {
      requested: totalCount,
      authorized: authorizedProps.length,
      unauthorized: unauthorizedTags,
      source,
    };
  }

  /**
   * Get authorization source for an agent/publisher pair.
   *
   * UNION over legacy + catalog (publisher-wide rows). Within each arm,
   * 'adagents_json' beats 'agent_claim'. Legacy wins on collision so a
   * fixture seeded as 'adagents_json' in legacy keeps surfacing as
   * 'adagents_json' even if catalog has a weaker (community → agent_claim)
   * row for the same pair. Catalog evidence values are mapped to the
   * legacy source vocabulary ('override' → 'adagents_json',
   * 'community' → 'agent_claim').
   */
  private async getAuthorizationSource(
    agentUrl: string,
    publisherDomain: string
  ): Promise<'adagents_json' | 'agent_claim' | 'none'> {
    const canonicalDomain = canonicalizePublisherDomain(publisherDomain);
    const specExact = await this.specExactAgentUrls(agentUrl);
    const authResult = await query<{ source: string }>(
      `WITH unioned AS (
         SELECT source, 0 AS src_priority
           FROM agent_publisher_authorizations
          WHERE agent_url = $1 AND publisher_domain = $2
         UNION ALL
         SELECT
           CASE v.evidence
             WHEN 'adagents_json'          THEN 'adagents_json'
             WHEN 'agent_claim'            THEN 'agent_claim'
             WHEN 'override'               THEN 'adagents_json'
             WHEN 'community'              THEN 'agent_claim'
             WHEN 'adagents_authoritative' THEN 'adagents_json'
           END AS source,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = $3
            AND v.agent_url = ANY($4::text[])
            AND v.publisher_domain = $2
            AND v.property_rid IS NULL
            AND v.property_id_slug IS NULL
       )
       SELECT source FROM unioned
        ORDER BY src_priority,
                 CASE source WHEN 'adagents_json' THEN 0 ELSE 1 END
        LIMIT 1`,
      [agentUrl, canonicalDomain, registryAgentUrlLookupKey(agentUrl), specExact]
    );

    if (authResult.rows.length === 0) return 'none';
    return authResult.rows[0].source as 'adagents_json' | 'agent_claim';
  }

  /**
   * Expand publisher_properties selectors to concrete property identifiers.
   * Used by real-time systems to cache all valid identifiers for a product.
   *
   * @param agentUrl - The agent URL
   * @param publisherProperties - Array of selectors to expand
   * @returns All property identifiers covered by the selectors
   */
  async expandPublisherPropertiesToIdentifiers(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<Array<{
    publisher_domain: string;
    property_id: string;
    property_name: string;
    property_type: string;
    identifiers: PropertyIdentifier[];
    tags: string[];
  }>> {
    const results: Array<{
      publisher_domain: string;
      property_id: string;
      property_name: string;
      property_type: string;
      identifiers: PropertyIdentifier[];
      tags: string[];
    }> = [];

    for (const selector of publisherProperties) {
      let properties: DiscoveredProperty[];

      switch (selector.selection_type) {
        case 'all':
          properties = await this.getAuthorizedPropertiesForDomain(agentUrl, selector.publisher_domain);
          break;
        case 'by_id':
          properties = await this.getAuthorizedPropertiesByIds(agentUrl, selector.publisher_domain, selector.property_ids);
          break;
        case 'by_tag':
          properties = await this.getAuthorizedPropertiesByTags(agentUrl, selector.publisher_domain, selector.property_tags);
          break;
      }

      for (const prop of properties) {
        results.push({
          publisher_domain: prop.publisher_domain,
          property_id: prop.property_id || prop.id || '',
          property_name: prop.name,
          property_type: prop.property_type,
          identifiers: prop.identifiers,
          tags: prop.tags || [],
        });
      }
    }

    return results;
  }

  /**
   * Get all authorized properties for an agent in a specific domain.
   *
   * Filters the unioned getPropertiesForAgent set to a single
   * publisher_domain. Keeps the dual-read shape co-located with
   * getPropertiesForAgent rather than duplicating the catalog JOINs.
   */
  private async getAuthorizedPropertiesForDomain(
    agentUrl: string,
    publisherDomain: string
  ): Promise<DiscoveredProperty[]> {
    const all = await this.getPropertiesForAgent(agentUrl);
    // Canonicalize both sides so a runtime query for `"https://cnn.com"` or
    // `"cnn.com."` resolves a stored property whose `publisher_domain` was
    // written as `"cnn.com"`. Read-side of the writer's canonicalization
    // boundary; legacy rows may also carry non-canonical forms.
    const target = canonicalizePublisherDomain(publisherDomain);
    return all
      .filter((p) => canonicalizePublisherDomain(p.publisher_domain) === target)
      .sort((a, b) => a.property_type.localeCompare(b.property_type) || a.name.localeCompare(b.name));
  }

  /**
   * Get authorized properties by specific IDs.
   */
  private async getAuthorizedPropertiesByIds(
    agentUrl: string,
    publisherDomain: string,
    propertyIds: string[]
  ): Promise<DiscoveredProperty[]> {
    if (propertyIds.length === 0) return [];
    const idSet = new Set(propertyIds);
    const inDomain = await this.getAuthorizedPropertiesForDomain(agentUrl, publisherDomain);
    return inDomain.filter((p) => p.property_id !== undefined && idSet.has(p.property_id));
  }

  /**
   * Get authorized properties by tags.
   */
  private async getAuthorizedPropertiesByTags(
    agentUrl: string,
    publisherDomain: string,
    propertyTags: string[]
  ): Promise<DiscoveredProperty[]> {
    if (propertyTags.length === 0) return [];
    const tagSet = new Set(propertyTags);
    const inDomain = await this.getAuthorizedPropertiesForDomain(agentUrl, publisherDomain);
    return inDomain.filter((p) => (p.tags || []).some((t) => tagSet.has(t)));
  }

  /**
   * Check if a specific property identifier is authorized for an agent.
   * Optimized for real-time ad request validation.
   *
   * @param agentUrl - The agent URL to check
   * @param identifierType - Type of identifier (domain, ios_bundle, android_package, etc.)
   * @param identifierValue - The identifier value to look up
   * @returns Quick validation result
   */
  async isPropertyAuthorizedForAgent(
    agentUrl: string,
    identifierType: string,
    identifierValue: string
  ): Promise<{
    authorized: boolean;
    property_id?: string;
    publisher_domain?: string;
  }> {
    const specExact = await this.specExactAgentUrls(agentUrl);
    const result = await query<{
      id: string;
      publisher_domain: string;
    }>(
      `WITH unioned AS (
         SELECT p.id::text AS id, p.publisher_domain
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE apa.agent_url = $1
            AND p.identifiers @> $2::jsonb
         UNION ALL
         SELECT
           cp.property_rid::text AS id,
           regexp_replace(cp.created_by, '^[^:]+:', '') AS publisher_domain
           FROM catalog_identifiers ci
           JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
           JOIN v_effective_agent_authorizations v ON v.property_rid = cp.property_rid
          WHERE ci.identifier_type = $3
            AND ci.identifier_value = LOWER($4)
            AND v.agent_url_canonical = $5
            AND v.agent_url = ANY($6::text[])
            AND v.property_rid IS NOT NULL
       )
       SELECT id, publisher_domain FROM unioned LIMIT 1`,
      [
        agentUrl,
        JSON.stringify([{ type: identifierType, value: identifierValue }]),
        identifierType,
        identifierValue,
        registryAgentUrlLookupKey(agentUrl),
        specExact,
      ]
    );

    if (result.rows.length === 0) {
      return { authorized: false };
    }

    return {
      authorized: true,
      property_id: result.rows[0].id,
      publisher_domain: result.rows[0].publisher_domain,
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Delete expired records
   */
  async deleteExpired(): Promise<{ agents: number; publishers: number; authorizations: number }> {
    const agentsResult = await query(
      `DELETE FROM discovered_agents WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    const publishersResult = await query(
      `DELETE FROM discovered_publishers WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    // Clean up authorizations for agents that no longer exist
    const authResult = await query(
      `DELETE FROM agent_publisher_authorizations
       WHERE agent_url NOT IN (SELECT agent_url FROM discovered_agents)
         AND agent_url NOT IN (
           SELECT a.url FROM member_profiles m, jsonb_array_elements(m.agents) AS a(url)
           WHERE a.url IS NOT NULL
         )`
    );

    return {
      agents: agentsResult.rowCount || 0,
      publishers: publishersResult.rowCount || 0,
      authorizations: authResult.rowCount || 0,
    };
  }

  /**
   * Clear all federated discovery data (for testing or reset)
   */
  async clearAll(): Promise<void> {
    await query('DELETE FROM agent_property_authorizations');
    await query('DELETE FROM discovered_properties');
    await query('DELETE FROM agent_publisher_authorizations');
    await query('DELETE FROM discovered_publishers');
    await query('DELETE FROM discovered_agents');
  }

  // ============================================
  // Stats
  // ============================================

  /**
   * Get statistics about the federated index
   */
  async getStats(): Promise<{
    discovered_agents: number;
    discovered_publishers: number;
    discovered_properties: number;
    authorizations: number;
    authorizations_by_source: { adagents_json: number; agent_claim: number };
    properties_by_type: Record<string, number>;
  }> {
    const [agentsResult, publishersResult, propertiesResult, authResult, authBySourceResult, propsByTypeResult] = await Promise.all([
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_agents'),
      query<{ count: string }>('SELECT COUNT(DISTINCT domain) as count FROM discovered_publishers'),
      query<{ count: string }>('SELECT COUNT(*) as count FROM discovered_properties'),
      query<{ count: string }>('SELECT COUNT(*) as count FROM agent_publisher_authorizations'),
      query<{ source: string; count: string }>(
        `SELECT source, COUNT(*) as count FROM agent_publisher_authorizations GROUP BY source`
      ),
      query<{ property_type: string; count: string }>(
        `SELECT property_type, COUNT(*) as count FROM discovered_properties GROUP BY property_type`
      ),
    ]);

    const bySource = { adagents_json: 0, agent_claim: 0 };
    for (const row of authBySourceResult.rows) {
      if (row.source === 'adagents_json') bySource.adagents_json = parseInt(row.count, 10);
      if (row.source === 'agent_claim') bySource.agent_claim = parseInt(row.count, 10);
    }

    const propsByType: Record<string, number> = {};
    for (const row of propsByTypeResult.rows) {
      propsByType[row.property_type] = parseInt(row.count, 10);
    }

    return {
      discovered_agents: parseInt(agentsResult.rows[0].count, 10),
      discovered_publishers: parseInt(publishersResult.rows[0].count, 10),
      discovered_properties: parseInt(propertiesResult.rows[0].count, 10),
      authorizations: parseInt(authResult.rows[0].count, 10),
      authorizations_by_source: bySource,
      properties_by_type: propsByType,
    };
  }
}
