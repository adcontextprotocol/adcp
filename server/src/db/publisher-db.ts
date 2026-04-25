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
   * Identity reuse rules — load-bearing for tenant isolation:
   *
   *  - If any of this property's identifiers already point at a property_rid
   *    that was authored by *another* publisher's adagents.json, the
   *    projection is refused. Without this, a malicious manifest can name a
   *    victim's identifier (e.g. domain:cnn.com) alongside its own and
   *    rebind the victim's property_rid; ON CONFLICT DO NOTHING on the
   *    insert path doesn't protect against attacker-owned identifiers
   *    landing on the victim's rid.
   *
   *  - If the identifier set spans multiple distinct rids that we *do* own
   *    (or that came from seed/community sources), the projection is
   *    refused. Silent merging of two existing properties needs human
   *    review through the dispute layer (catalog_disputes).
   *
   *  - Otherwise, reuse the single matching rid (re-crawls don't fork
   *    identity) or mint a new one when nothing matches.
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
