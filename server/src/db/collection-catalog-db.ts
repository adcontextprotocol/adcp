/**
 * Collection Catalog Database — fact graph for publisher-authored collections.
 *
 * Collections are addressed canonically by (publisher_domain, collection_id)
 * and aliased by distribution identifiers such as
 * youtube.com/youtube_channel_id/uck...
 */

import type { PoolClient } from 'pg';
import { getClient, query } from './client.js';
import { uuidv7 } from './uuid.js';
import { CatalogEventsDatabase } from './catalog-events-db.js';
import {
  isValidCollectionKind,
  isValidCollectionPublisherDomain,
  isValidDistributionIdentifierType,
  normalizeCollectionDistributionIdentifier,
} from '../services/collection-identifier-normalization.js';
import { canonicalizePublisherDomain } from '../services/publisher-domain.js';

export interface CatalogCollection {
  collection_rid: string;
  publisher_domain: string;
  collection_id: string | null;
  name: string | null;
  kind: string | null;
  source: string;
  status: string;
  adagents_url: string | null;
  collection_json: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  source_updated_at: Date;
}

export interface CatalogCollectionIdentifier {
  id: string;
  collection_rid: string;
  distribution_publisher_domain: string;
  identifier_type: string;
  identifier_value: string;
  evidence: string;
  confidence: string;
  disputed: boolean;
  created_at: Date;
}

export interface CatalogCollectionWithIdentifiers extends CatalogCollection {
  identifiers: CatalogCollectionIdentifier[];
}

export interface CatalogCollectionSyncEntry {
  collection_rid: string;
  publisher_domain: string;
  collection_id: string | null;
  name: string | null;
  kind: string | null;
  source: string;
  status: string;
  identifiers: Array<{
    publisher_domain: string;
    type: string;
    value: string;
  }>;
  collection?: Record<string, unknown>;
}

export interface CollectionProjectionInput {
  publisherDomain: string;
  collection: Record<string, unknown>;
  evidence: 'adagents_json' | 'community' | 'feed_import' | 'manual_review';
  confidence: 'authoritative' | 'strong' | 'medium' | 'weak';
  source: 'authoritative' | 'enriched' | 'contributed';
  adagentsUrl?: string | null;
  createdBy: string;
}

export interface CollectionProjectionEvent {
  event_type: 'collection.created' | 'collection.updated' | 'collection.removed';
  collection_rid: string;
  publisher_domain: string;
  collection_id: string | null;
  name: string | null;
  kind: string | null;
  source: string;
  status: string;
  identifiers: Array<{
    publisher_domain: string;
    type: string;
    value: string;
  }>;
  collection?: Record<string, unknown>;
}

export interface CollectionListFilters {
  publisher_domain?: string;
  source?: string;
  status?: string;
  identifier_type?: string;
  distribution_publisher_domain?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

function normalizeCollectionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDistributionIdentifier(type: string, value: string): { type: string; value: string } {
  return normalizeCollectionDistributionIdentifier(type, value);
}

function normalizeCollectionName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function normalizeCollectionKind(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isValidCollectionKind(value)) return undefined;
  return value;
}

function extractDistributionIdentifiers(collection: Record<string, unknown>): Array<{
  publisher_domain: string;
  type: string;
  value: string;
}> {
  const distribution = Array.isArray(collection.distribution) ? collection.distribution : [];
  const identifiers: Array<{ publisher_domain: string; type: string; value: string }> = [];

  for (const entry of distribution) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.publisher_domain !== 'string') continue;

    const publisherDomain = canonicalizePublisherDomain(record.publisher_domain);
    if (!isValidCollectionPublisherDomain(publisherDomain)) continue;
    const rawIdentifiers = Array.isArray(record.identifiers) ? record.identifiers : [];

    for (const raw of rawIdentifiers) {
      if (!raw || typeof raw !== 'object') continue;
      const ident = raw as Record<string, unknown>;
      if (typeof ident.type !== 'string' || typeof ident.value !== 'string') continue;
      const rawType = ident.type.trim();
      const rawValue = ident.value.trim();
      if (!isValidDistributionIdentifierType(rawType) || rawValue.length === 0) continue;
      const norm = normalizeDistributionIdentifier(ident.type, ident.value);
      identifiers.push({
        publisher_domain: publisherDomain,
        type: norm.type,
        value: norm.value,
      });
    }
  }

  return identifiers;
}

function collectionWithNormalizedDistribution(
  collection: Record<string, unknown>,
  collectionId: string,
  name: string,
  kind: string | null,
  identifiers: Array<{ publisher_domain: string; type: string; value: string }>,
): Record<string, unknown> {
  const grouped = new Map<string, Array<{ type: string; value: string }>>();
  for (const identifier of identifiers) {
    const existing = grouped.get(identifier.publisher_domain) ?? [];
    existing.push({ type: identifier.type, value: identifier.value });
    grouped.set(identifier.publisher_domain, existing);
  }

  const normalized: Record<string, unknown> = {
    ...collection,
    collection_id: collectionId,
    name,
  };
  if (kind) {
    normalized.kind = kind;
  } else {
    delete normalized.kind;
  }
  if (Array.isArray(collection.distribution)) {
    normalized.distribution = [...grouped.entries()].map(([publisher_domain, ids]) => ({
      publisher_domain,
      identifiers: ids,
    }));
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',') + '}';
}

function identifierSignature(identifiers: Array<{ publisher_domain: string; type: string; value: string }>): string {
  return identifiers
    .map((i) => `${i.publisher_domain}:${i.type}:${i.value}`)
    .sort()
    .join('\n');
}

async function deleteStaleIdentifiersForEvidence(
  client: PoolClient,
  collectionRid: string,
  identifiers: Array<{ publisher_domain: string; type: string; value: string }>,
  evidence: string,
): Promise<void> {
  const domains = identifiers.map((i) => i.publisher_domain);
  const types = identifiers.map((i) => i.type);
  const values = identifiers.map((i) => i.value);
  await client.query(
    `DELETE FROM catalog_collection_identifiers cci
      WHERE cci.collection_rid = $1
        AND cci.evidence = $2
        AND NOT EXISTS (
          SELECT 1
            FROM (
              SELECT
                unnest($3::text[]) AS distribution_publisher_domain,
                unnest($4::text[]) AS identifier_type,
                unnest($5::text[]) AS identifier_value
            ) AS keep
           WHERE keep.distribution_publisher_domain = cci.distribution_publisher_domain
             AND keep.identifier_type = cci.identifier_type
             AND keep.identifier_value = cci.identifier_value
        )`,
    [collectionRid, evidence, domains, types, values],
  );
}

async function disputeSupersededLowerConfidenceIdentifiers(
  client: PoolClient,
  collectionRid: string,
  identifiers: Array<{ publisher_domain: string; type: string; value: string }>,
): Promise<void> {
  const domains = identifiers.map((i) => i.publisher_domain);
  const types = identifiers.map((i) => i.type);
  const values = identifiers.map((i) => i.value);
  await client.query(
    `UPDATE catalog_collection_identifiers cci
        SET disputed = TRUE
      WHERE cci.collection_rid = $1
        AND cci.confidence <> 'authoritative'
        AND cci.disputed = FALSE
        AND NOT EXISTS (
          SELECT 1
            FROM (
              SELECT
                unnest($2::text[]) AS distribution_publisher_domain,
                unnest($3::text[]) AS identifier_type,
                unnest($4::text[]) AS identifier_value
            ) AS keep
           WHERE keep.distribution_publisher_domain = cci.distribution_publisher_domain
             AND keep.identifier_type = cci.identifier_type
             AND keep.identifier_value = cci.identifier_value
        )`,
    [collectionRid, domains, types, values],
  );
}

export class CollectionCatalogDatabase {
  async projectCollection(
    client: PoolClient,
    input: CollectionProjectionInput,
  ): Promise<CollectionProjectionEvent | null> {
    const publisherDomain = canonicalizePublisherDomain(input.publisherDomain);
    if (!isValidCollectionPublisherDomain(publisherDomain)) return null;
    const collectionId = normalizeCollectionId(input.collection.collection_id);
    if (!collectionId) return null;

    const name = normalizeCollectionName(input.collection.name);
    if (!name) return null;
    const kind = normalizeCollectionKind(input.collection.kind);
    if (kind === undefined) return null;
    const identifiers = extractDistributionIdentifiers(input.collection);
    const normalizedCollection = collectionWithNormalizedDistribution(
      input.collection,
      collectionId,
      name,
      kind,
      identifiers,
    );
    const adagentsUrl = input.adagentsUrl ?? `https://${publisherDomain}/.well-known/adagents.json`;

    const existing = await client.query<CatalogCollection>(
      `SELECT *
         FROM catalog_collections
        WHERE publisher_domain = $1 AND collection_id = $2
        LIMIT 1`,
      [publisherDomain, collectionId],
    );

    let collectionRid: string;
    let eventType: CollectionProjectionEvent['event_type'] | null = null;
    if (existing.rows.length > 0) {
      collectionRid = existing.rows[0].collection_rid;
      const existingIdentifiers = await client.query<{
        distribution_publisher_domain: string;
        identifier_type: string;
        identifier_value: string;
      }>(
        `SELECT distribution_publisher_domain, identifier_type, identifier_value
           FROM catalog_collection_identifiers
          WHERE collection_rid = $1 AND evidence = $2 AND disputed = FALSE`,
        [collectionRid, input.evidence],
      );
      const existingIdentifierSignature = identifierSignature(existingIdentifiers.rows.map((row) => ({
        publisher_domain: row.distribution_publisher_domain,
        type: row.identifier_type,
        value: row.identifier_value,
      })));
      const nextIdentifierSignature = identifierSignature(identifiers);
      const changed = existing.rows[0].status !== 'active'
        || stableStringify(existing.rows[0].collection_json) !== stableStringify(normalizedCollection)
        || existingIdentifierSignature !== nextIdentifierSignature;
      eventType = changed ? 'collection.updated' : null;
      await client.query(
        `UPDATE catalog_collections SET
           name = $2,
           kind = $3,
           source = $4,
           status = 'active',
           adagents_url = COALESCE($5, adagents_url),
           collection_json = $6::jsonb,
           created_by = $7,
           updated_at = NOW(),
           source_updated_at = NOW()
         WHERE collection_rid = $1`,
        [
          collectionRid,
          name,
          kind,
          input.source,
          adagentsUrl,
          JSON.stringify(normalizedCollection),
          input.createdBy,
        ],
      );
    } else {
      collectionRid = uuidv7();
      eventType = 'collection.created';
      await client.query(
        `INSERT INTO catalog_collections
           (collection_rid, publisher_domain, collection_id, name, kind, source, status,
            adagents_url, collection_json, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8::jsonb, $9)`,
        [
          collectionRid,
          publisherDomain,
          collectionId,
          name,
          kind,
          input.source,
          adagentsUrl,
          JSON.stringify(normalizedCollection),
          input.createdBy,
        ],
      );
    }

    await deleteStaleIdentifiersForEvidence(client, collectionRid, identifiers, input.evidence);
    if (input.confidence === 'authoritative') {
      await disputeSupersededLowerConfidenceIdentifiers(client, collectionRid, identifiers);
    }

    await client.query(
      `INSERT INTO catalog_collection_facts
         (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
       VALUES ($1, 'identity', 'publisher_collection', $2, 'exists', $3, $4, $5, $6)`,
      [
        uuidv7(),
        `${publisherDomain}:${collectionId}`,
        collectionRid,
        input.evidence,
        input.confidence,
        input.createdBy,
      ],
    );

    for (const ident of identifiers) {
      const linked = await client.query<{ id: string }>(
        `INSERT INTO catalog_collection_identifiers
           (id, collection_rid, distribution_publisher_domain, identifier_type, identifier_value, evidence, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (distribution_publisher_domain, identifier_type, identifier_value)
         DO UPDATE SET
           collection_rid = EXCLUDED.collection_rid,
           evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence,
           disputed = FALSE
         WHERE catalog_collection_identifiers.collection_rid = EXCLUDED.collection_rid
            OR (
              EXCLUDED.confidence = 'authoritative'
              AND catalog_collection_identifiers.confidence <> 'authoritative'
            )
         RETURNING id`,
        [
          uuidv7(),
          collectionRid,
          ident.publisher_domain,
          ident.type,
          ident.value,
          input.evidence,
          input.confidence,
        ],
      );
      if ((linked.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO catalog_collection_facts
             (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
           VALUES ($1, 'linking', 'identifier', $2, 'identifier_conflict', $3, $4, $5, $6)`,
          [
            uuidv7(),
            `${ident.publisher_domain}:${ident.type}:${ident.value}`,
            collectionRid,
            input.evidence,
            input.confidence,
            input.createdBy,
          ],
        );
        continue;
      }
      await client.query(
        `INSERT INTO catalog_collection_facts
           (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
         VALUES ($1, 'linking', 'identifier', $2, 'has_identifier', $3, $4, $5, $6)`,
        [
          uuidv7(),
          `${ident.publisher_domain}:${ident.type}:${ident.value}`,
          collectionRid,
          input.evidence,
          input.confidence,
          input.createdBy,
        ],
      );
    }

    if (!eventType) return null;
    const storedIdentifiers = await client.query<{
      distribution_publisher_domain: string;
      identifier_type: string;
      identifier_value: string;
    }>(
      `SELECT distribution_publisher_domain, identifier_type, identifier_value
         FROM catalog_collection_identifiers
        WHERE collection_rid = $1 AND disputed = FALSE
        ORDER BY distribution_publisher_domain, identifier_type, identifier_value`,
      [collectionRid],
    );
    return {
      event_type: eventType,
      collection_rid: collectionRid,
      publisher_domain: publisherDomain,
      collection_id: collectionId,
      name,
      kind,
      source: input.source,
      status: 'active',
      identifiers: storedIdentifiers.rows.map((i) => ({
        publisher_domain: i.distribution_publisher_domain,
        type: i.identifier_type,
        value: i.identifier_value,
      })),
      collection: normalizedCollection,
    };
  }

  async retireMissingAdagentsCollections(
    client: PoolClient,
    publisherDomain: string,
    activeCollectionIds: string[],
    createdBy: string,
    evidence: CollectionProjectionInput['evidence'] = 'adagents_json',
  ): Promise<CollectionProjectionEvent[]> {
    const domain = canonicalizePublisherDomain(publisherDomain);
    const result = await client.query<CatalogCollection>(
      `UPDATE catalog_collections
          SET status = 'removed',
              updated_at = NOW()
        WHERE publisher_domain = $1
          AND created_by = $2
          AND status <> 'removed'
          AND NOT (collection_id = ANY($3::text[]))
        RETURNING *`,
      [domain, createdBy, activeCollectionIds],
    );

    const events: CollectionProjectionEvent[] = [];
    for (const row of result.rows) {
      const identifiers = await client.query<{
        distribution_publisher_domain: string;
        identifier_type: string;
        identifier_value: string;
      }>(
        `SELECT distribution_publisher_domain, identifier_type, identifier_value
           FROM catalog_collection_identifiers
          WHERE collection_rid = $1 AND disputed = FALSE
          ORDER BY distribution_publisher_domain, identifier_type, identifier_value`,
        [row.collection_rid],
      );
      events.push({
        event_type: 'collection.removed',
        collection_rid: row.collection_rid,
        publisher_domain: row.publisher_domain,
        collection_id: row.collection_id,
        name: row.name,
        kind: row.kind,
        source: row.source,
        status: 'removed',
        identifiers: identifiers.rows.map((i) => ({
          publisher_domain: i.distribution_publisher_domain,
          type: i.identifier_type,
          value: i.identifier_value,
        })),
        collection: row.collection_json,
      });
    }
    if (result.rows.length > 0) {
      await client.query(
        `DELETE FROM catalog_collection_identifiers
          WHERE collection_rid = ANY($1::uuid[])
            AND evidence = $2`,
        [result.rows.map((row) => row.collection_rid), evidence],
      );
    }
    return events;
  }

  async getCollection(collectionRid: string): Promise<CatalogCollectionWithIdentifiers | null> {
    const collectionResult = await query<CatalogCollection>(
      'SELECT * FROM catalog_collections WHERE collection_rid = $1',
      [collectionRid],
    );
    if (collectionResult.rows.length === 0) return null;

    const identifierResult = await query<CatalogCollectionIdentifier>(
      `SELECT *
         FROM catalog_collection_identifiers
        WHERE collection_rid = $1 AND disputed = FALSE
        ORDER BY created_at`,
      [collectionRid],
    );

    return { ...collectionResult.rows[0], identifiers: identifierResult.rows };
  }

  async lookupByDistributionIdentifier(
    publisherDomain: string,
    identifierType: string,
    identifierValue: string,
  ): Promise<CatalogCollectionWithIdentifiers | null> {
    const domain = canonicalizePublisherDomain(publisherDomain);
    const ident = normalizeDistributionIdentifier(identifierType, identifierValue);
    const result = await query<{ collection_rid: string }>(
      `SELECT cci.collection_rid
         FROM catalog_collection_identifiers cci
         JOIN catalog_collections cc ON cc.collection_rid = cci.collection_rid
        WHERE cci.distribution_publisher_domain = $1
          AND cci.identifier_type = $2
          AND cci.identifier_value = $3
          AND cci.disputed = FALSE
          AND cc.status = 'active'
        LIMIT 1`,
      [domain, ident.type, ident.value],
    );
    const rid = result.rows[0]?.collection_rid;
    return rid ? this.getCollection(rid) : null;
  }

  async listCollections(filters: CollectionListFilters): Promise<{
    collections: CatalogCollection[];
    total: number;
    next_offset: number | null;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    conditions.push(`cc.status = $${paramIdx++}`);
    params.push(filters.status ?? 'active');

    if (filters.publisher_domain) {
      conditions.push(`cc.publisher_domain = $${paramIdx++}`);
      params.push(canonicalizePublisherDomain(filters.publisher_domain));
    }
    if (filters.source) {
      conditions.push(`cc.source = $${paramIdx++}`);
      params.push(filters.source);
    }
    if (filters.search) {
      conditions.push(`(
        cc.name ILIKE $${paramIdx} ESCAPE '\\'
        OR cc.collection_id ILIKE $${paramIdx} ESCAPE '\\'
      )`);
      params.push(`%${filters.search.replace(/[%_\\]/g, '\\$&')}%`);
      paramIdx++;
    }
    if (filters.identifier_type) {
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_collection_identifiers cci
        WHERE cci.collection_rid = cc.collection_rid
          AND cci.identifier_type = $${paramIdx++}
          AND cci.disputed = FALSE
      )`);
      params.push(filters.identifier_type);
    }
    if (filters.distribution_publisher_domain) {
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_collection_identifiers cci
        WHERE cci.collection_rid = cc.collection_rid
          AND cci.distribution_publisher_domain = $${paramIdx++}
          AND cci.disputed = FALSE
      )`);
      params.push(canonicalizePublisherDomain(filters.distribution_publisher_domain));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 1000);
    const offset = Math.max(filters.offset ?? 0, 0);

    const countResult = await query<{ count: string }>(
      `SELECT count(*) FROM catalog_collections cc ${where}`,
      params,
    );

    const rows = await query<CatalogCollection>(
      `SELECT cc.*
         FROM catalog_collections cc
         ${where}
        ORDER BY cc.collection_rid
        LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...params, limit, offset],
    );

    const total = parseInt(countResult.rows[0].count, 10);
    const nextOffset = offset + rows.rows.length < total ? offset + rows.rows.length : null;
    return { collections: rows.rows, total, next_offset: nextOffset };
  }

  async syncCollections(limit: number = 1000, offset: number = 0): Promise<{
    collections: CatalogCollectionSyncEntry[];
    total: number;
    next_offset: number | null;
  }> {
    const page = Math.min(Math.max(limit, 1), 1000);
    const start = Math.max(offset, 0);
    const result = await query<CatalogCollection & {
      total_count: string;
      identifiers: Array<{ publisher_domain: string; type: string; value: string }> | null;
    }>(
      `SELECT
         cc.*,
         count(*) OVER() AS total_count,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'publisher_domain', cci.distribution_publisher_domain,
               'type', cci.identifier_type,
               'value', cci.identifier_value
             )
             ORDER BY cci.distribution_publisher_domain, cci.identifier_type, cci.identifier_value
           ) FILTER (WHERE cci.id IS NOT NULL),
           '[]'::jsonb
         ) AS identifiers
       FROM catalog_collections cc
       LEFT JOIN catalog_collection_identifiers cci
         ON cci.collection_rid = cc.collection_rid
        AND cci.disputed = FALSE
       WHERE cc.status = 'active'
       GROUP BY cc.collection_rid
       ORDER BY cc.collection_rid
       LIMIT $1 OFFSET $2`,
      [page, start],
    );

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const collections = result.rows.map((row) => ({
      collection_rid: row.collection_rid,
      publisher_domain: row.publisher_domain,
      collection_id: row.collection_id,
      name: row.name,
      kind: row.kind,
      source: row.source,
      status: row.status,
      identifiers: row.identifiers ?? [],
      collection: row.collection_json,
    }));
    const nextOffset = start + collections.length < total ? start + collections.length : null;

    return { collections, total, next_offset: nextOffset };
  }

  async mergeCollections(canonicalRid: string, aliasRid: string, evidence: string, actor: string): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE catalog_collection_identifiers SET collection_rid = $1 WHERE collection_rid = $2`,
        [canonicalRid, aliasRid],
      );
      await client.query(
        `INSERT INTO catalog_collection_aliases (alias_rid, canonical_rid, evidence, actor)
         VALUES ($1, $2, $3, $4)`,
        [aliasRid, canonicalRid, evidence, actor],
      );
      await client.query(
        `UPDATE catalog_collections SET status = 'removed', updated_at = NOW() WHERE collection_rid = $1`,
        [aliasRid],
      );
      await client.query(
        `INSERT INTO catalog_collection_facts
           (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
         VALUES ($1, 'linking', 'collection_rid', $2, 'merged_into', $3, $4, 'strong', $5)`,
        [uuidv7(), aliasRid, canonicalRid, evidence, actor],
      );
      await new CatalogEventsDatabase().writeEvent(
        {
          event_type: 'collection.merged',
          entity_type: 'collection',
          entity_id: aliasRid,
          payload: {
            alias_rid: aliasRid,
            canonical_rid: canonicalRid,
            evidence,
          },
          actor,
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
