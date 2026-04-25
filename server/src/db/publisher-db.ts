import { getClient } from './client.js';
import { uuidv7 } from './uuid.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import type { PoolClient } from 'pg';

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

/**
 * Database operations for the publisher overlay (migration 432).
 *
 * Caches the source-of-truth adagents.json file body and projects the parsed
 * manifest into the property catalog (catalog_properties + catalog_identifiers)
 * in the same transaction. Mirrors brand registry's writer pattern (brand-db.ts
 * upsertDiscoveredBrand + crawler.ts upsertBrandProperties), keeping the cache
 * write and the catalog projection atomic so the catalog never has a partial
 * view of a successful crawl.
 */
export class PublisherDatabase {
  /**
   * Cache an adagents.json manifest and project its properties into the
   * catalog. Run as a single transaction so a successful crawl always lands
   * both the cache and the catalog rows together (or neither).
   *
   * ON CONFLICT preserves org/ownership metadata; the manifest body itself is
   * always overwritten because the crawler is authoritative for it.
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
      for (const prop of properties) {
        await this.projectPropertyToCatalog(client, domain, prop);
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
   * catalog_identifiers. Reuses an existing property_rid when one of this
   * property's identifiers is already in the catalog (so re-crawls don't
   * fork identity), otherwise mints a new rid.
   *
   * evidence='adagents_json' / confidence='authoritative' matches the seed
   * migration (336_catalog_seed_from_existing.sql) so a property crawled now
   * is indistinguishable from one seeded earlier.
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
      .map((i) => normalizeIdentifier(i.type, i.value));

    if (identifiers.length === 0) return;

    const tupleParams: unknown[] = [];
    const tuplePlaceholders = identifiers
      .map((ident, i) => {
        tupleParams.push(ident.type, ident.value);
        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      })
      .join(', ');

    const existing = await client.query<{ property_rid: string }>(
      `SELECT property_rid FROM catalog_identifiers
        WHERE (identifier_type, identifier_value) IN (${tuplePlaceholders})
        LIMIT 1`,
      tupleParams
    );

    const adagentsUrl = `https://${publisherDomain}/.well-known/adagents.json`;
    let propertyRid: string;

    if (existing.rows.length > 0) {
      propertyRid = existing.rows[0].property_rid;
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
        [propertyRid, property.property_id ?? null, adagentsUrl, `adagents_json:${publisherDomain}`]
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

export const publisherDb = new PublisherDatabase();
