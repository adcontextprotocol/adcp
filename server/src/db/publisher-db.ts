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

export interface AdagentsManifest {
  authorized_agents?: unknown;
  properties?: AdagentsProperty[];
  [key: string]: unknown;
}

export interface UpsertAdagentsCacheInput {
  domain: string;
  manifest: AdagentsManifest;
  expiresAt?: Date;
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
  async upsertAdagentsCache(input: UpsertAdagentsCacheInput): Promise<void> {
    const domain = input.domain.toLowerCase();
    const client = await getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO publishers (domain, adagents_json, source_type, last_validated, expires_at)
         VALUES ($1, $2::jsonb, 'adagents_json', NOW(), $3)
         ON CONFLICT (domain) DO UPDATE SET
           adagents_json = EXCLUDED.adagents_json,
           source_type = 'adagents_json',
           last_validated = NOW(),
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [domain, JSON.stringify(input.manifest), input.expiresAt ?? null]
      );

      const properties = Array.isArray(input.manifest.properties) ? input.manifest.properties : [];
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

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
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
      await client.query(
        `UPDATE catalog_properties SET
           source_updated_at = NOW(),
           updated_at = NOW(),
           adagents_url = COALESCE(adagents_url, $2),
           property_id = COALESCE(property_id, $3)
         WHERE property_rid = $1`,
        [propertyRid, adagentsUrl, property.property_id ?? null]
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
}
