import { query } from './client.js';

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
             WHEN 'adagents_json' THEN 'adagents_json'
             WHEN 'agent_claim'   THEN 'agent_claim'
             WHEN 'override'      THEN 'adagents_json'
             WHEN 'community'     THEN 'agent_claim'
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
   * Get all publisher domains for a specific agent.
   *
   * UNION over legacy + catalog (publisher-wide rows). See
   * getAgentsForDomain for evidence→source mapping and dual-read
   * rationale. Canonicalizes the input via lower(rtrim($1, '/')) to
   * match the writer's canonicalizer (publisher-db.ts:91-108) when
   * looking up the catalog arm; the legacy arm is keyed on the raw
   * input to preserve historical behavior on non-canonical legacy data.
   */
  async getDomainsForAgent(agentUrl: string): Promise<AgentPublisherAuthorization[]> {
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
             WHEN 'adagents_json' THEN 'adagents_json'
             WHEN 'agent_claim'   THEN 'agent_claim'
             WHEN 'override'      THEN 'adagents_json'
             WHEN 'community'     THEN 'agent_claim'
           END AS source,
           v.created_at AS discovered_at,
           v.updated_at AS last_validated,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = CASE WHEN $1 = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM($1), '/')) END
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
      [agentUrl]
    );
    return result.rows;
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
      // Canonicalize each input agent_url for the catalog-side lookup.
      // Wildcard '*' is preserved literally; other inputs are
      // lowercased and have trailing slashes stripped to match the
      // writer's canonicalizer (publisher-db.ts:91-108). The legacy arm
      // is keyed on the raw input to preserve historical behavior on
      // non-canonical legacy data.
      const canonicalToInput = new Map<string, string>();
      for (const u of batch) {
        let canon: string;
        const trimmed = u.trim();
        if (trimmed === '*') {
          canon = '*';
        } else {
          canon = trimmed.toLowerCase();
          while (canon.endsWith('/')) canon = canon.slice(0, -1);
        }
        // First-wins: if multiple inputs share a canonical form, the
        // first one in the batch is the lookup key. Callers don't pass
        // duplicates today.
        if (!canonicalToInput.has(canon)) canonicalToInput.set(canon, u);
      }
      const canonical = Array.from(canonicalToInput.keys());
      // Both arms emit a `dedup_canonical` column (the canonical form of
      // their agent_url). DISTINCT ON dedup_canonical collapses cases
      // where the same agent has both a legacy row and a catalog row.
      // src_priority=0 means legacy wins on collision.
      const result = await query<AgentPublisherAuthorization & { dedup_canonical: string }>(
        `WITH unioned AS (
           SELECT
             CASE WHEN agent_url = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM(agent_url), '/')) END
               AS dedup_canonical,
             agent_url, publisher_domain, authorized_for,
             property_ids, source, discovered_at, last_validated, 0 AS src_priority
             FROM agent_publisher_authorizations
            WHERE agent_url = ANY($1)
           UNION ALL
           SELECT
             v.agent_url_canonical AS dedup_canonical,
             v.agent_url,
             v.publisher_domain,
             v.authorized_for,
             NULL::text[] AS property_ids,
             CASE v.evidence
               WHEN 'adagents_json' THEN 'adagents_json'
               WHEN 'agent_claim'   THEN 'agent_claim'
               WHEN 'override'      THEN 'adagents_json'
               WHEN 'community'     THEN 'agent_claim'
             END AS source,
             v.created_at AS discovered_at,
             v.updated_at AS last_validated,
             1 AS src_priority
             FROM v_effective_agent_authorizations v
            WHERE v.agent_url_canonical = ANY($2)
              AND v.property_rid IS NULL
              AND v.property_id_slug IS NULL
         )
         SELECT DISTINCT ON (dedup_canonical)
                dedup_canonical,
                agent_url, publisher_domain, authorized_for, property_ids,
                source, discovered_at, last_validated
           FROM unioned
          ORDER BY dedup_canonical, src_priority, source, publisher_domain`,
        [batch, canonical]
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
   * means the crawler successfully validated and cached the file — that
   * always wins. Otherwise fall back to bool_or over discovered_publishers
   * so the historical three-state contract (true / false / null) is
   * preserved when only the legacy path has data.
   */
  async hasValidAdagents(domain: string): Promise<boolean | null> {
    const result = await query<{ catalog_present: boolean; legacy_or: boolean | null }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM publishers
            WHERE domain = $1 AND source_type = 'adagents_json'
         ) AS catalog_present,
         (SELECT bool_or(has_valid_adagents)
            FROM discovered_publishers
           WHERE domain = $1) AS legacy_or`,
      [domain]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.catalog_present) return true;
    if (row.legacy_or === null) return null;
    return row.legacy_or;
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
   * UNION over legacy + catalog (publisher-wide rows). Both arms emit
   * the canonical agent_url (lowercased + trailing-slash-stripped, with
   * '*' preserved literally) so set-dedup collapses cross-arm duplicates
   * even when one side stored a non-canonical form. Without this the
   * snapshot consumer in crawler.ts would emit phantom
   * agent.discovered/removed events for the casing delta.
   */
  async getAllAgentDomainPairs(): Promise<Array<{ agent_url: string; publisher_domain: string }>> {
    const result = await query<{ agent_url: string; publisher_domain: string }>(
      `SELECT
         CASE WHEN agent_url = '*' THEN '*'
              ELSE LOWER(RTRIM(BTRIM(agent_url), '/')) END AS agent_url,
         publisher_domain
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
             discovered_at, last_validated, expires_at
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
    metadata: { name?: string; agent_type?: string; protocol?: string }
  ): Promise<void> {
    await query(
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
         property_id, publisher_domain, property_type, name, identifiers, tags, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
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
          WHERE v.agent_url_canonical = CASE WHEN $1 = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM($1), '/')) END
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
       ), deduped AS (
         SELECT DISTINCT ON (publisher_domain, name, property_type)
                id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at
           FROM unioned
          ORDER BY publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY publisher_domain, property_type, name`,
      [agentUrl]
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
    const result = await query<DiscoveredProperty>(
      `WITH unioned AS (
         SELECT id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at,
                0 AS src_priority
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
           1 AS src_priority
           FROM publishers p
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.adagents_json->'properties') = 'array'
                 THEN p.adagents_json->'properties'
                 ELSE '[]'::jsonb END
          ) AS prop
           LEFT JOIN catalog_properties cp
                  ON cp.property_id = prop->>'property_id'
                 AND cp.created_by = 'adagents_json:' || p.domain
          WHERE p.domain = $1
            AND p.source_type = 'adagents_json'
            AND prop->>'name' IS NOT NULL
            AND prop->>'property_type' IS NOT NULL
       ), deduped AS (
         SELECT DISTINCT ON (publisher_domain, name, property_type)
                id, property_id, publisher_domain, property_type, name,
                identifiers, tags, discovered_at, last_validated, expires_at
           FROM unioned
          ORDER BY publisher_domain, name, property_type, src_priority
       )
       SELECT * FROM deduped ORDER BY property_type, name`,
      [domain]
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
    const result = await query<{ publisher_domain: string }>(
      `SELECT DISTINCT publisher_domain FROM (
         SELECT p.publisher_domain
           FROM discovered_properties p
           JOIN agent_property_authorizations apa ON apa.property_id = p.id
          WHERE apa.agent_url = $1
         UNION
         SELECT v.publisher_domain
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = CASE WHEN $1 = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM($1), '/')) END
            AND v.property_rid IS NOT NULL
       ) sub
       ORDER BY publisher_domain`,
      [agentUrl]
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
    const authResult = await query<{ source: string }>(
      `WITH unioned AS (
         SELECT source, 0 AS src_priority
           FROM agent_publisher_authorizations
          WHERE agent_url = $1 AND publisher_domain = $2
         UNION ALL
         SELECT
           CASE v.evidence
             WHEN 'adagents_json' THEN 'adagents_json'
             WHEN 'agent_claim'   THEN 'agent_claim'
             WHEN 'override'      THEN 'adagents_json'
             WHEN 'community'     THEN 'agent_claim'
           END AS source,
           1 AS src_priority
           FROM v_effective_agent_authorizations v
          WHERE v.agent_url_canonical = CASE WHEN $1 = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM($1), '/')) END
            AND v.publisher_domain = $2
            AND v.property_rid IS NULL
            AND v.property_id_slug IS NULL
       )
       SELECT source FROM unioned
        ORDER BY src_priority,
                 CASE source WHEN 'adagents_json' THEN 0 ELSE 1 END
        LIMIT 1`,
      [agentUrl, publisherDomain]
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
    return all
      .filter((p) => p.publisher_domain === publisherDomain)
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
            AND v.agent_url_canonical = CASE WHEN $1 = '*' THEN '*' ELSE LOWER(RTRIM(BTRIM($1), '/')) END
            AND v.property_rid IS NOT NULL
       )
       SELECT id, publisher_domain FROM unioned LIMIT 1`,
      [
        agentUrl,
        JSON.stringify([{ type: identifierType, value: identifierValue }]),
        identifierType,
        identifierValue,
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
