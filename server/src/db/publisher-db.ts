import { getClient } from './client.js';
import { uuidv7 } from './uuid.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import { createLogger } from '../logger.js';
import type { PoolClient } from 'pg';

const log = createLogger('publisher-db');

/**
 * Property as it appears inside an adagents.json file. The manifest body is
 * untrusted (publisher-controlled), so callers should pass already-validated
 * data — see AdAgentsManager.validateDomain. Fields here are loose because
 * downstream projection only needs identifiers + property_id.
 */
export interface AdagentsProperty {
  property_id?: string;
  property_type?: string;
  name?: string;
  identifiers?: Array<{ type?: string; value?: string }>;
  tags?: string[];
}

/**
 * An authorized_agents[] entry from a publisher's adagents.json. Six
 * authorization_type variants exist per the spec; v1 of the catalog
 * projection covers the property-side cases (property_ids,
 * inline_properties, lexically-anchored publisher_properties).
 * property_tags / signal_ids / signal_tags are deferred — the legacy
 * agent_publisher_authorizations table continues to serve them via the
 * UNION reader during the dual-read window.
 */
export interface AdagentsAuthorizedAgent {
  url?: string;
  authorized_for?: string;
  authorization_type?:
    | 'property_ids'
    | 'property_tags'
    | 'inline_properties'
    | 'publisher_properties'
    | 'signal_ids'
    | 'signal_tags';
  property_ids?: string[];
  properties?: AdagentsProperty[];           // for inline_properties variant
  publisher_properties?: Array<{
    publisher_domain?: string;
    selection_type?: 'all' | 'by_id' | 'by_tag';
    property_ids?: string[];
    property_tags?: string[];
  }>;
}

export interface AdagentsManifest {
  authorized_agents?: AdagentsAuthorizedAgent[];
  properties?: AdagentsProperty[];
  [key: string]: unknown;
}

export interface UpsertAdagentsCacheInput {
  domain: string;
  manifest: AdagentsManifest;
  expiresAt?: Date;
  /**
   * HTTP status code from the fetch that produced this manifest. When
   * supplied, written to publishers.last_http_status. Phase B of the
   * publisher-page redesign — surfaces verifier-grade chrome.
   */
  statusCode?: number;
  /**
   * Response body byte length (post-decompression). When
   * authoritative_location was followed, measures the canonical
   * document body, not the stub.
   */
  responseBytes?: number;
  /**
   * Final URL after following redirects + authoritative_location.
   * Differs from the publisher's expected /.well-known URL when
   * `self_redirected` or `aao_hosted`.
   */
  resolvedUrl?: string;
  /**
   * How the publisher's adagents.json was discovered. Mirrors
   * AdAgentsValidationResult.discovery_method. Written to
   * publishers.discovery_method so the API can surface provenance.
   */
  discoveryMethod?: string;
  /**
   * When discoveryMethod is 'ads_txt_managerdomain', the manager domain
   * whose adagents.json was used. Written to publishers.manager_domain.
   */
  managerDomain?: string;
}

const ADAGENTS_CREATED_BY_PREFIX = 'adagents_json:';

function adagentsCreatedBy(publisherDomain: string): string {
  return `${ADAGENTS_CREATED_BY_PREFIX}${publisherDomain}`;
}

/**
 * Whether a domain/subdomain identifier lexically belongs to the publisher.
 *
 * Bundle IDs, RSS URLs, and other non-domain identifier types have no
 * lexical relationship to the publisher's hostname, so they are never
 * anchors. This is what stops a manifest hosted at attacker.example from
 * legitimately claiming `domain:victim.example` — the anchor check rejects
 * the cross-publisher domain claim before it can land in the catalog.
 */
function isPublisherDomainAnchor(publisherDomain: string, type: string, value: string): boolean {
  if (type !== 'domain' && type !== 'subdomain') return false;
  if (value === publisherDomain) return true;
  return value.endsWith(`.${publisherDomain}`);
}

/**
 * Canonicalize an agent_url to match the schema's invariant
 * (lowercase, no trailing slash, wildcard '*' is the sentinel).
 * Returns null when the input is not a usable URL — callers skip those
 * rows rather than fail the whole projection.
 *
 * Exported so the agent-side sync endpoints
 * (server/src/db/authorization-snapshot-db.ts) canonicalize the
 * agent_url query parameter through the same function the writer uses
 * for stored rows. Drift between the two would silently miss matches.
 */
// Phase B fetch-metadata hardening. The HTTP status writer column is a
// SMALLINT (-32768..32767), broader than the RFC 100..599 range. Clamp
// at write time so a malicious origin returning, e.g., status 999 can't
// surface that to verifiers — text-only display is harmless, but the
// schema docstring promises 100..599 and we should match it.
function clampHttpStatus(status: number | undefined): number | null {
  if (typeof status !== 'number' || !Number.isFinite(status)) return null;
  return Math.max(100, Math.min(599, Math.trunc(status)));
}

// Phase B: cap resolved_url length at write. `Response.url` is built
// from chained Location headers — undici defaults bound each hop but
// not the resulting string. A pathological redirect chain could
// otherwise stuff a multi-KB URL into the column. 2048 covers every
// real publisher CDN URL with comfortable headroom.
const RESOLVED_URL_MAX = 2048;
function truncateResolvedUrl(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  return url.length > RESOLVED_URL_MAX ? url.slice(0, RESOLVED_URL_MAX) : url;
}

export function canonicalizeAgentUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === '*') return '*';
  // Reject embedded wildcards — the schema CHECK in migration 440 only
  // accepts '*' as exact-match. Anything else (e.g. *foo*) would fail
  // the CHECK and abort the whole transaction.
  if (trimmed.includes('*')) return null;
  // Reject internal whitespace and control chars. A URL with embedded
  // newlines or tabs would land in the canonical form and become
  // unmatchable by lookup callers. URL.parse() at the validator level
  // doesn't enforce this hard.
  if (/[\s\x00-\x1f]/.test(trimmed)) return null;
  let canonical = trimmed.toLowerCase();
  while (canonical.endsWith('/')) canonical = canonical.slice(0, -1);
  if (canonical.length === 0) return null;
  return canonical;
}

/**
 * Database operations for the publisher overlay (migration 432).
 *
 * Caches the source-of-truth adagents.json file body and projects the parsed
 * manifest into the property catalog (catalog_properties + catalog_identifiers).
 * The cache write and the per-property projections share one transaction;
 * each property is wrapped in a savepoint so a constraint violation on one
 * malformed property does not lose the rest of the manifest.
 */
export class PublisherDatabase {
  /**
   * Cache an adagents.json manifest and project its properties into the
   * catalog.
   *
   * ON CONFLICT for the publishers row only touches the manifest body and the
   * crawl-tracking columns; org/ownership and review state are preserved so a
   * later org claim isn't wiped by a routine re-crawl.
   */
  /**
   * Record a failed adagents.json fetch attempt. The crawl returned a
   * non-200 response (404, 5xx, etc.) so there is no manifest to cache,
   * but the fetch metadata still belongs on the publishers row so the
   * verifier-facing UI can show "Last attempted: <ts> · HTTP <code>".
   * Does not touch adagents_json (preserves the last successful body
   * if one exists) and does not bump source_type.
   */
  async recordFailedAdagentsFetch(input: {
    domain: string;
    statusCode?: number;
    responseBytes?: number;
    resolvedUrl?: string;
  }): Promise<void> {
    const domain = input.domain.toLowerCase();
    const client = await getClient();
    try {
      await client.query(
        `INSERT INTO publishers
           (domain, source_type, last_http_status, last_response_bytes, resolved_url)
         VALUES ($1, 'community', $2, $3, $4)
         ON CONFLICT (domain) DO UPDATE SET
           last_http_status = EXCLUDED.last_http_status,
           last_response_bytes = EXCLUDED.last_response_bytes,
           resolved_url = EXCLUDED.resolved_url,
           updated_at = NOW()`,
        [
          domain,
          clampHttpStatus(input.statusCode),
          input.responseBytes ?? null,
          truncateResolvedUrl(input.resolvedUrl),
        ],
      );
    } finally {
      client.release();
    }
  }

  async upsertAdagentsCache(input: UpsertAdagentsCacheInput): Promise<void> {
    const domain = input.domain.toLowerCase();
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Normalize array fields before caching. The validator only enforces
      // `authorized_agents` shape, so a publisher serving a JSON-valid file
      // with `properties: "x"` could otherwise land non-array JSONB that
      // breaks downstream readers (jsonb_array_elements / jsonb_array_length
      // error on non-arrays). Belt-and-suspenders for the SQL-side guards.
      const safeManifest: AdagentsManifest = {
        ...input.manifest,
        properties: Array.isArray(input.manifest.properties) ? input.manifest.properties : [],
        authorized_agents: Array.isArray(input.manifest.authorized_agents)
          ? input.manifest.authorized_agents
          : [],
      };

      await client.query(
        `INSERT INTO publishers
           (domain, adagents_json, source_type, last_validated, expires_at,
            last_http_status, last_response_bytes, resolved_url,
            discovery_method, manager_domain)
         VALUES ($1, $2::jsonb, 'adagents_json', NOW(), $3, $4, $5, $6, $7, $8)
         ON CONFLICT (domain) DO UPDATE SET
           adagents_json = EXCLUDED.adagents_json,
           source_type = 'adagents_json',
           last_validated = NOW(),
           expires_at = EXCLUDED.expires_at,
           last_http_status = EXCLUDED.last_http_status,
           last_response_bytes = EXCLUDED.last_response_bytes,
           resolved_url = EXCLUDED.resolved_url,
           discovery_method = EXCLUDED.discovery_method,
           manager_domain = EXCLUDED.manager_domain,
           updated_at = NOW()`,
        [
          domain,
          JSON.stringify(safeManifest),
          input.expiresAt ?? null,
          clampHttpStatus(input.statusCode),
          input.responseBytes ?? null,
          truncateResolvedUrl(input.resolvedUrl),
          input.discoveryMethod ?? null,
          input.managerDomain ?? null,
        ]
      );

      const properties = Array.isArray(safeManifest.properties) ? safeManifest.properties : [];
      for (let i = 0; i < properties.length; i += 1) {
        const savepoint = `prop_${i}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await this.projectPropertyToCatalog(client, domain, properties[i]);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          log.warn(
            {
              domain,
              propertyId: properties[i]?.property_id,
              propertyIndex: i,
              err: err instanceof Error ? err.message : err,
            },
            'Catalog projection failed for property; skipping'
          );
        }
      }

      // Project authorized_agents → catalog_agent_authorizations. Each
      // entry runs in its own savepoint so a malformed entry doesn't
      // lose the rest of the manifest. Identity-side projection (above)
      // ran first so property_ids slugs can be resolved against
      // catalog_properties rows the writer just created.
      const authEntries = Array.isArray(safeManifest.authorized_agents)
        ? safeManifest.authorized_agents
        : [];
      for (let i = 0; i < authEntries.length; i += 1) {
        const savepoint = `auth_${i}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await this.projectAuthorizationToCatalog(client, domain, authEntries[i]);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          log.warn(
            {
              domain,
              agentUrl: authEntries[i]?.url,
              authIndex: i,
              err: err instanceof Error ? err.message : err,
            },
            'Catalog auth projection failed for entry; skipping'
          );
        }
      }

      // Reconcile: soft-delete catalog rows for agents that USED to be
      // authorized by this manifest but no longer appear. Without this
      // the writer is upsert-only and an agent removed from the
      // publisher's adagents.json would linger in the index forever
      // (the original wonderstruck-shaped follow-up bug). Scoped to
      // writer-sourced rows (`evidence='adagents_json'`,
      // `created_by='system'`) so promotions, agent_claim rows, and
      // third-party-attested rows are untouched.
      const currentCanonical = authEntries
        .map(e => (e?.url && typeof e.url === 'string' ? canonicalizeAgentUrl(e.url) : null))
        .filter((c): c is string => !!c);
      // Catalog rows for this publisher live under either
      //   publisher_domain = $1   (publisher-wide rows)
      //   property_rid IN (catalog_properties.created_by='adagents_json:$1')
      //   property_id_slug IS NOT NULL with created_by='adagents_json:$1' (slug-keyed)
      // The OR-chain covers all three writer shapes.
      await client.query(
        `UPDATE catalog_agent_authorizations caa
            SET deleted_at = NOW()
          WHERE caa.evidence = 'adagents_json'
            AND caa.created_by = 'system'
            AND caa.deleted_at IS NULL
            AND NOT (caa.agent_url_canonical = ANY($2::text[]))
            AND (
              caa.publisher_domain = $1
              OR caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $3
              )
              OR (caa.property_id_slug IS NOT NULL AND caa.property_rid IN (
                SELECT property_rid FROM catalog_properties WHERE created_by = $3
              ))
            )`,
        [domain, currentCanonical, adagentsCreatedBy(domain)],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the cached adagents.json body for a domain. Used by the crawler
   * to decide whether a re-fetch produced an actual content change before
   * fanning out manager re-validation. Returns null when the domain has
   * never been successfully crawled.
   */
  async getCachedAdagentsJson(domain: string): Promise<AdagentsManifest | null> {
    const client = await getClient();
    try {
      const r = await client.query<{ adagents_json: AdagentsManifest | null }>(
        `SELECT adagents_json FROM publishers WHERE domain = $1 LIMIT 1`,
        [domain.toLowerCase()],
      );
      return r.rows[0]?.adagents_json ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * Insert one queue row per publisher delegating to this manager via
   * ads.txt MANAGERDOMAIN. Idempotent: if a publisher is already queued
   * (e.g. previous fan-out hasn't drained yet), the row is reset to
   * "due now" with attempts=0 so the upstream manager change supersedes
   * any in-flight backoff. Returns the number of rows touched (inserts
   * + ON CONFLICT updates) — a delegating publisher with a stale row
   * still counts since the supersede is the load-bearing semantic.
   *
   * The SELECT scans the partial index added in migration 470
   * (idx_publishers_manager_domain) so the lookup stays cheap even at
   * managed-network scale.
   */
  async enqueueManagerRevalidation(managerDomain: string): Promise<number> {
    const client = await getClient();
    try {
      const r = await client.query(
        `INSERT INTO manager_revalidation_queue
           (publisher_domain, manager_domain, enqueued_at, next_attempt_after, attempts, last_attempted_at, last_error)
         SELECT domain, $1, NOW(), NOW(), 0, NULL, NULL
           FROM publishers
          WHERE manager_domain = $1
         ON CONFLICT (publisher_domain) DO UPDATE SET
           manager_domain = EXCLUDED.manager_domain,
           enqueued_at = NOW(),
           next_attempt_after = NOW(),
           attempts = 0,
           last_attempted_at = NULL,
           last_error = NULL`,
        [managerDomain.toLowerCase()],
      );
      return r.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  /**
   * Pull a bounded batch of due rows from the queue. The caller (crawler
   * worker tick) must call markRevalidationSucceeded / Failed for each
   * returned row to advance the queue.
   */
  async dequeueRevalidationBatch(
    limit: number,
  ): Promise<Array<{ publisher_domain: string; manager_domain: string; attempts: number }>> {
    const client = await getClient();
    try {
      const r = await client.query<{
        publisher_domain: string;
        manager_domain: string;
        attempts: number;
      }>(
        `SELECT publisher_domain, manager_domain, attempts
           FROM manager_revalidation_queue
          WHERE next_attempt_after <= NOW()
          ORDER BY enqueued_at ASC
          LIMIT $1`,
        [limit],
      );
      return r.rows;
    } finally {
      client.release();
    }
  }

  async markRevalidationSucceeded(publisherDomain: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query(
        `DELETE FROM manager_revalidation_queue WHERE publisher_domain = $1`,
        [publisherDomain.toLowerCase()],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Advance the queue row with exponential backoff. Schedule mirrors the
   * catalog_crawl_queue cadence (1h / 6h / 24h / 72h) so a manager whose
   * file is briefly unparseable doesn't clog the queue forever.
   */
  async markRevalidationFailed(publisherDomain: string, err: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query(
        `UPDATE manager_revalidation_queue
            SET attempts = attempts + 1,
                last_attempted_at = NOW(),
                last_error = LEFT($2, 500),
                next_attempt_after = NOW() + CASE
                  WHEN attempts < 1 THEN INTERVAL '1 hour'
                  WHEN attempts < 2 THEN INTERVAL '6 hours'
                  WHEN attempts < 3 THEN INTERVAL '1 day'
                  ELSE INTERVAL '3 days'
                END
          WHERE publisher_domain = $1`,
        [publisherDomain.toLowerCase(), err],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Project a single adagents.json property into catalog_properties +
   * catalog_identifiers. Catalog rows are tagged
   * evidence='adagents_json' / confidence='authoritative' so a property
   * crawled now is indistinguishable from one seeded by migration 336.
   *
   * Tenant isolation rules — load-bearing for catalog correctness:
   *
   *  1. Cross-publisher domain claims are refused. A `domain` or `subdomain`
   *     identifier in the property must lexically belong to the publisher
   *     (equal to or a subdomain of publisherDomain). Otherwise the entire
   *     property is dropped — a manifest at attacker.example cannot land an
   *     authoritative claim for `domain:victim.example`.
   *
   *  2. Cross-publisher rid reuse is refused. If any matched rid was
   *     authored by another publisher's adagents.json, refuse — even
   *     ON CONFLICT DO NOTHING on the identifier insert wouldn't stop a
   *     reuse-branch UPDATE from rebinding adagents_url.
   *
   *  3. Multi-rid conflation is refused. If the identifier set spans
   *     multiple distinct existing rids, silent merging requires human
   *     review (catalog_disputes).
   *
   *  4. Foreign-rid reuse requires an anchor. If the matched rid was created
   *     by a non-adagents source (system seed, community, brand_json, member
   *     resolve), reuse is only allowed when the property carries at least
   *     one publisher-anchored identifier. Without this, an unanchored
   *     manifest can reach a seed rid via a bundle ID and overwrite its
   *     adagents_url via COALESCE.
   *
   *  5. Otherwise, reuse the single matching own-rid (re-crawl) or mint
   *     a new one. Identifiers go in with ON CONFLICT DO NOTHING so a
   *     non-anchor identifier already claimed by another rid silently
   *     drops rather than rebinding.
   */
  private async projectPropertyToCatalog(
    client: PoolClient,
    publisherDomain: string,
    property: AdagentsProperty,
  ): Promise<void> {
    const rawIdentifiers = Array.isArray(property.identifiers) ? property.identifiers : [];
    const identifiers = rawIdentifiers
      .filter((i): i is { type: string; value: string } =>
        typeof i?.type === 'string' && typeof i?.value === 'string' && i.type.length > 0 && i.value.length > 0
      )
      .map((i) => {
        const norm = normalizeIdentifier(i.type, i.value);
        // catalog_identifiers.chk_identifier_lowercase requires the entire value
        // to be lowercase. normalizeRssUrl preserves URL path case, and any
        // future identifier type may also leak case; lowercase defensively to
        // match the migration 336 seed and avoid silent rollbacks.
        return { type: norm.type, value: norm.value.toLowerCase() };
      });

    if (identifiers.length === 0) return;

    // Rule 1 — refuse cross-publisher domain claims.
    const crossPublisherClaims = identifiers.filter(
      (i) =>
        (i.type === 'domain' || i.type === 'subdomain')
        && !isPublisherDomainAnchor(publisherDomain, i.type, i.value)
    );
    if (crossPublisherClaims.length > 0) {
      log.warn(
        {
          publisherDomain,
          propertyId: property.property_id,
          crossPublisherClaims,
        },
        'Catalog projection refused: property declares domain identifiers outside the publisher\'s domain'
      );
      return;
    }

    const hasAnchor = identifiers.some((i) =>
      isPublisherDomainAnchor(publisherDomain, i.type, i.value)
    );

    const tupleParams: unknown[] = [];
    const tuplePlaceholders = identifiers
      .map((ident, i) => {
        tupleParams.push(ident.type, ident.value);
        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      })
      .join(', ');

    // ORDER BY for determinism: when multiple distinct rids match, the same
    // input always picks the same one (oldest first), so re-runs converge.
    const existing = await client.query<{ property_rid: string; created_by: string | null }>(
      `SELECT DISTINCT cp.property_rid, cp.created_by
         FROM catalog_identifiers ci
         JOIN catalog_properties cp ON cp.property_rid = ci.property_rid
        WHERE (ci.identifier_type, ci.identifier_value) IN (${tuplePlaceholders})
        ORDER BY cp.created_by, cp.property_rid`,
      tupleParams
    );

    const expectedCreatedBy = adagentsCreatedBy(publisherDomain);

    // Rule 2 — refuse cross-publisher rid reuse.
    const conflicting = existing.rows.filter((r) =>
      typeof r.created_by === 'string'
      && r.created_by.startsWith(ADAGENTS_CREATED_BY_PREFIX)
      && r.created_by !== expectedCreatedBy
    );
    if (conflicting.length > 0) {
      log.warn(
        {
          publisherDomain,
          propertyId: property.property_id,
          conflictingCreatedBy: conflicting.map((r) => r.created_by),
          conflictingRids: conflicting.map((r) => r.property_rid),
        },
        'Catalog projection refused: property identifiers are claimed by another publisher manifest'
      );
      return;
    }

    // Rule 3 — refuse multi-rid conflation.
    const ownRids = Array.from(new Set(existing.rows.map((r) => r.property_rid)));
    if (ownRids.length > 1) {
      log.warn(
        { publisherDomain, propertyId: property.property_id, rids: ownRids },
        'Catalog projection refused: identifier set spans multiple existing properties (merge requires moderation)'
      );
      return;
    }

    const adagentsUrl = `https://${publisherDomain}/.well-known/adagents.json`;
    let propertyRid: string;

    if (ownRids.length === 1) {
      const matchedCreatedBy = existing.rows[0].created_by;
      const isOwnRecrawl = matchedCreatedBy === expectedCreatedBy;

      // Rule 4 — foreign rid reuse requires an anchor. The publisher must
      // produce a domain/subdomain identifier under their own domain to take
      // ownership of (or update adagents_url on) a rid created by another
      // source. Without this, a manifest declaring only a bundle ID could
      // reach a seed rid via that bundle ID and rebind adagents_url.
      if (!isOwnRecrawl && !hasAnchor) {
        log.warn(
          {
            publisherDomain,
            propertyId: property.property_id,
            matchedCreatedBy,
            matchedRid: ownRids[0],
          },
          'Catalog projection refused: cannot adopt a non-adagents rid without a publisher-anchored identifier'
        );
        return;
      }

      propertyRid = ownRids[0];
      // Anchor-adopt promotion: when a publisher's adagents.json claims a rid
      // previously created by community/enrichment/contributed flows AND
      // anchors via a domain identifier under their own host, the publisher
      // is now the source-of-truth pipeline for this property. Promote
      // source → 'authoritative' and rebind created_by →
      // 'adagents_json:<publisher>' so downstream queries that filter by
      // created_by (auth projection in projectAuthorizationToCatalog,
      // publisher_domain derivation in v_effective_agent_authorizations)
      // see this row as a publisher-owned authoritative entry. Without
      // this rebind, the auth projection's
      // `WHERE created_by = 'adagents_json:<pub>' AND property_id = ANY(...)`
      // returns 0 rows for properties that were already in the catalog
      // under a different pipeline — silently dropping the manifest's
      // authorized_agents[] entries on the floor.
      //
      // Own re-crawls (matchedCreatedBy === expectedCreatedBy) re-set
      // source_updated_at without changing created_by; the SET below is
      // idempotent for that case.
      await client.query(
        `UPDATE catalog_properties SET
           source_updated_at = NOW(),
           updated_at = NOW(),
           adagents_url = COALESCE(adagents_url, $2),
           property_id = COALESCE(property_id, $3),
           source = 'authoritative',
           created_by = $4
         WHERE property_rid = $1`,
        [propertyRid, adagentsUrl, property.property_id ?? null, expectedCreatedBy]
      );
    } else {
      propertyRid = uuidv7();
      await client.query(
        `INSERT INTO catalog_properties
           (property_rid, property_id, classification, source, status, adagents_url, created_by)
         VALUES ($1, $2, 'property', 'authoritative', 'active', $3, $4)`,
        [propertyRid, property.property_id ?? null, adagentsUrl, expectedCreatedBy]
      );
    }

    for (const ident of identifiers) {
      await client.query(
        `INSERT INTO catalog_identifiers
           (id, property_rid, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, 'adagents_json', 'authoritative')
         ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
        [uuidv7(), propertyRid, ident.type, ident.value]
      );
    }
  }

  /**
   * Project a single authorized_agents[] entry into
   * catalog_agent_authorizations.
   *
   * v1 covers three of the six authorization_type variants the spec
   * enumerates:
   *   - property_ids        — one row per resolved property_rid
   *   - inline_properties   — same shape using the entry's inline
   *                           properties[] (the writer projects those
   *                           to catalog first, then references them)
   *   - publisher_properties — only the lexical-anchor case lands
   *                            (entry.publisher_domain == publisherDomain)
   *                            with selection_type='all' or 'by_id'.
   *                            Cross-publisher claims and 'by_tag' are
   *                            refused per spec.
   *   - no authorization_type (publisher-wide) — one row with
   *                            property_rid IS NULL, publisher_domain set
   *
   * Variants explicitly skipped:
   *   - property_tags, signal_ids, signal_tags — deferred per spec.
   *     The legacy agent_publisher_authorizations table continues to
   *     serve these via the UNION reader during dual-read.
   *
   * Security:
   *   - agent_url canonicalization at the writer matches the schema
   *     CHECK (lowercase + no trailing slash; embedded '*' rejected).
   *   - publisher_properties cross-publisher refusal via the anchor rule.
   *   - property_ids slugs that don't resolve to a catalog_properties
   *     row owned by this publisher are skipped (legacy-only data
   *     served by UNION reader).
   *
   * evidence='adagents_json', created_by='system' for all writer-sourced
   * rows. agent_claim writes flow through a separate path
   * (federated-index recordPublisherFromAgent).
   */
  private async projectAuthorizationToCatalog(
    client: PoolClient,
    publisherDomain: string,
    entry: AdagentsAuthorizedAgent,
  ): Promise<void> {
    if (!entry?.url || typeof entry.url !== 'string') return;
    const agentCanonical = canonicalizeAgentUrl(entry.url);
    if (agentCanonical === null) {
      log.warn(
        { publisherDomain, agentUrl: entry.url },
        'Skipping auth projection: agent_url failed canonicalization'
      );
      return;
    }
    const agentRaw = entry.url.trim();
    const authorizedFor = typeof entry.authorized_for === 'string'
      ? entry.authorized_for.slice(0, 500)
      : null;

    const variant = entry.authorization_type;

    if (variant === 'property_tags' || variant === 'signal_ids' || variant === 'signal_tags') {
      // Deferred per spec. Legacy table serves these.
      log.debug(
        { publisherDomain, agentUrl: agentCanonical, variant },
        'Skipping auth projection: variant not supported in v1'
      );
      return;
    }

    // Resolve the set of (property_rid OR publisher-wide) targets for this entry.
    const targets: Array<{ propertyRid: string | null; slug: string | null }> = [];

    if (variant === 'property_ids') {
      const slugs = Array.isArray(entry.property_ids)
        ? entry.property_ids.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      if (slugs.length === 0) return;
      const rows = await client.query<{ property_rid: string; property_id: string }>(
        `SELECT property_rid, property_id
           FROM catalog_properties
          WHERE created_by = $1 AND property_id = ANY($2)`,
        [adagentsCreatedBy(publisherDomain), slugs]
      );
      for (const row of rows.rows) {
        targets.push({ propertyRid: row.property_rid, slug: row.property_id });
      }
    } else if (variant === 'inline_properties') {
      // Inline properties were just projected (they ride in entry.properties[]
      // and get the same security guards as top-level properties via the
      // existing project loop). Resolve their rids the same way as
      // property_ids, keyed on the publisher's manifest slug.
      const inline = Array.isArray(entry.properties) ? entry.properties : [];
      // First, project each inline property — the entry's own properties[]
      // wasn't visited by the top-level loop because they live inside this
      // auth entry, not the manifest's top-level properties[]. A failure
      // in any inline projection aborts the postgres transaction; the
      // outer per-entry SAVEPOINT (auth_${i} in upsertAdagentsCache) owns
      // the rollback boundary, so a single bad inline property drops the
      // whole entry — all-or-nothing per entry.
      for (const prop of inline) {
        await this.projectPropertyToCatalog(client, publisherDomain, prop);
      }
      const slugs = inline
        .map((p) => p?.property_id)
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (slugs.length > 0) {
        const rows = await client.query<{ property_rid: string; property_id: string }>(
          `SELECT property_rid, property_id
             FROM catalog_properties
            WHERE created_by = $1 AND property_id = ANY($2)`,
          [adagentsCreatedBy(publisherDomain), slugs]
        );
        for (const row of rows.rows) {
          targets.push({ propertyRid: row.property_rid, slug: row.property_id });
        }
      }
    } else if (variant === 'publisher_properties') {
      const sels = Array.isArray(entry.publisher_properties) ? entry.publisher_properties : [];
      for (const sel of sels) {
        const selPub = typeof sel?.publisher_domain === 'string' ? sel.publisher_domain.toLowerCase() : null;
        if (selPub !== publisherDomain) {
          // Cross-publisher third-party-sales claim. Refused per spec — the
          // writer cannot land an authoritative row for another publisher's
          // properties without out-of-band corroboration.
          log.warn(
            { publisherDomain, agentUrl: agentCanonical, selPub },
            'Skipping auth projection: publisher_properties claims a different publisher (cross-publisher refused)'
          );
          continue;
        }
        const selectionType = sel?.selection_type;
        if (selectionType === 'all') {
          const rows = await client.query<{ property_rid: string; property_id: string | null }>(
            `SELECT property_rid, property_id
               FROM catalog_properties
              WHERE created_by = $1`,
            [adagentsCreatedBy(publisherDomain)]
          );
          for (const row of rows.rows) {
            targets.push({ propertyRid: row.property_rid, slug: row.property_id });
          }
        } else if (selectionType === 'by_id') {
          const slugs = Array.isArray(sel.property_ids)
            ? sel.property_ids.filter((s): s is string => typeof s === 'string' && s.length > 0)
            : [];
          if (slugs.length === 0) continue;
          const rows = await client.query<{ property_rid: string; property_id: string }>(
            `SELECT property_rid, property_id
               FROM catalog_properties
              WHERE created_by = $1 AND property_id = ANY($2)`,
            [adagentsCreatedBy(publisherDomain), slugs]
          );
          for (const row of rows.rows) {
            targets.push({ propertyRid: row.property_rid, slug: row.property_id });
          }
        } else {
          // selection_type='by_tag' is deferred per spec.
          log.debug(
            { publisherDomain, agentUrl: agentCanonical, selectionType },
            'Skipping auth projection: publisher_properties.selection_type not supported in v1'
          );
        }
      }
    } else {
      // No authorization_type → publisher-wide auth (legacy
      // agent_publisher_authorizations shape). One row with
      // property_rid IS NULL, publisher_domain set.
      targets.push({ propertyRid: null, slug: null });
    }

    if (targets.length === 0) {
      log.debug(
        { publisherDomain, agentUrl: agentCanonical, variant },
        'Auth projection produced no rows (no resolved targets)'
      );
      return;
    }

    // Insert one CAA row per resolved target. Partial unique index
    // (active-set) handles re-crawls — second writer wins on collision.
    for (const target of targets) {
      const isPropertyScope = target.propertyRid !== null;
      await client.query(
        `INSERT INTO catalog_agent_authorizations
           (agent_url, agent_url_canonical, property_rid, property_id_slug,
            publisher_domain, authorized_for, evidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'adagents_json', 'system')
         ON CONFLICT (agent_url_canonical,
                      (COALESCE(property_rid::text, '')),
                      (COALESCE(publisher_domain, '')),
                      evidence)
                WHERE deleted_at IS NULL
         DO UPDATE SET
           authorized_for = EXCLUDED.authorized_for,
           updated_at = NOW()`,
        [
          agentRaw,
          agentCanonical,
          target.propertyRid,
          target.slug,
          isPropertyScope ? null : publisherDomain,
          authorizedFor,
        ]
      );
    }
  }
}
