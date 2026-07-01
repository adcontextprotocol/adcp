/**
 * Property Catalog API routes.
 *
 * New /api/registry/catalog/* endpoints for the fact-graph property catalog.
 * Mounted alongside the existing registry-api.ts routes.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { CatalogDatabase, type ResolveMode, type Provenance } from '../db/catalog-db.js';
import { CollectionCatalogDatabase } from '../db/collection-catalog-db.js';
import { CatalogEventsDatabase } from '../db/catalog-events-db.js';
import { CatalogDisputesDatabase, type DisputeType } from '../db/catalog-disputes-db.js';
import { getClient } from '../db/client.js';
import { fileDispute } from '../services/catalog-governance.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import {
  COLLECTION_KIND_VALUES,
  DISTRIBUTION_IDENTIFIER_TYPE_VALUES,
  isValidCollectionPublisherDomain,
} from '../services/collection-identifier-normalization.js';
import { canonicalizePublisherDomain } from '../services/publisher-domain.js';
import { loadTrancoList, lookupTrancoRanks, isTrancoLoaded } from '../services/tranco-ingestion.js';
import { createLogger } from '../logger.js';

const logger = createLogger('catalog-api');
const catalogDb = new CatalogDatabase();
const collectionCatalogDb = new CollectionCatalogDatabase();
const catalogEventsDb = new CatalogEventsDatabase();
const disputesDb = new CatalogDisputesDatabase();

// ── Zod Schemas ─────────────────────────────────────────────────

const IdentifierSchema = z.object({
  type: z.string(),
  value: z.string(),
});

const DistributionIdentifierSchema = z.object({
  type: z.enum(DISTRIBUTION_IDENTIFIER_TYPE_VALUES),
  value: z.string().min(1),
});

const CollectionDistributionSchema = z.object({
  publisher_domain: z.string().min(1).transform((value) => canonicalizePublisherDomain(value))
    .refine(isValidCollectionPublisherDomain, 'Invalid publisher_domain'),
  identifiers: z.array(DistributionIdentifierSchema).min(1),
}).passthrough();

const CommunityCollectionUpsertSchema = z.object({
  collection_id: z.string().min(1).optional(),
  name: z.string().min(1).max(500),
  kind: z.enum(COLLECTION_KIND_VALUES).optional(),
  distribution: z.array(CollectionDistributionSchema).min(1),
}).passthrough();

const ProvenanceSchema = z.object({
  type: z.enum([
    'agency_allowlist', 'publisher_declaration', 'impression_log',
    'ssp_inventory', 'deal_history', 'crawl', 'data_partner', 'member_assertion',
  ]),
  context: z.string().optional(),
});

const ResolveRequestSchema = z.object({
  identifiers: z.array(IdentifierSchema).min(1).max(10000),
  provenance: ProvenanceSchema,
  mode: z.enum(['resolve', 'lookup']).default('resolve'),
});

const DisputeRequestSchema = z.object({
  dispute_type: z.enum(['identifier_link', 'classification', 'property_data', 'false_merge']),
  subject_type: z.string(),
  subject_value: z.string(),
  claim: z.string().min(10).max(2000),
  evidence: z.string().max(5000).optional(),
});

function parseOptionalQueryInt(
  value: unknown,
  name: string,
  options: { defaultValue?: number; min?: number; max?: number } = {},
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: options.defaultValue };
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${name} must be an integer` };
  }
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: `${name} must be an integer` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, error: `${name} must be a safe integer` };
  }
  if (options.min !== undefined && parsed < options.min) {
    return { ok: false, error: `${name} must be greater than or equal to ${options.min}` };
  }
  if (options.max !== undefined && parsed > options.max) {
    return { ok: false, error: `${name} must be less than or equal to ${options.max}` };
  }
  return { ok: true, value: parsed };
}

function collectionEventPayload(event: {
  collection_rid: string;
  publisher_domain: string;
  collection_id: string | null;
  name: string | null;
  kind: string | null;
  source: string;
  status: string;
  identifiers: Array<{ publisher_domain: string; type: string; value: string }>;
  collection?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    collection_rid: event.collection_rid,
    publisher_domain: event.publisher_domain,
    collection_id: event.collection_id,
    name: event.name,
    kind: event.kind,
    source: event.source,
    status: event.status,
    identifiers: event.identifiers,
    collection: event.collection,
  };
}

// ── Config ──────────────────────────────────────────────────────

export interface CatalogApiConfig {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
  requireGlobalAdmin?: RequestHandler[];
}

// ── Router factory ──────────────────────────────────────────────

export function createCatalogApiRouter(config: CatalogApiConfig): Router {
  const router = Router();
  const {
    requireAuth: authMiddleware,
    requireAdmin: adminAuthMiddleware,
    requireGlobalAdmin: globalAdminMiddleware,
  } = config;
  const adminMiddleware = adminAuthMiddleware
    ? (authMiddleware ? [authMiddleware, adminAuthMiddleware] : [adminAuthMiddleware])
    : authMiddleware ? [authMiddleware] : [];
  const collectionWriteMiddleware = globalAdminMiddleware ?? adminMiddleware;
  const requireCatalogWriteConfigured: RequestHandler = (_req, res, next) => {
    if (!globalAdminMiddleware && (!authMiddleware || !adminAuthMiddleware)) {
      return res.status(503).json({ error: 'Catalog write endpoints require authentication and admin middleware configuration' });
    }
    next();
  };

  // ── POST /api/registry/resolve ──────────────────────────────

  router.post('/resolve', async (req, res) => {
    try {
      const parsed = ResolveRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      }

      const { identifiers, provenance, mode } = parsed.data;

      // resolve mode requires authentication
      if (mode === 'resolve' && !req.user) {
        return res.status(401).json({ error: 'Authentication required for resolve mode' });
      }

      const memberId = req.user?.email ?? 'anonymous';
      const result = await catalogDb.resolveIdentifiers(
        identifiers,
        mode as ResolveMode,
        memberId,
        provenance as Provenance
      );

      return res.json(result);
    } catch (err) {
      logger.error(`Resolve error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog ───────────────────────────────

  router.get('/catalog', async (req, res) => {
    try {
      const filters = {
        classification: req.query.classification as string | undefined,
        source: req.query.source as string | undefined,
        status: req.query.status as string | undefined,
        identifier_type: req.query.identifier_type as string | undefined,
        search: req.query.search as string | undefined,
        min_resolves: req.query.min_resolves ? parseInt(req.query.min_resolves as string, 10) : undefined,
        active_since: req.query.active_since as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        cursor: req.query.cursor as string | undefined,
      };

      const result = await catalogDb.listProperties(filters);

      // For each property, include its identifiers
      const entries = await Promise.all(
        result.properties.map(async (prop) => {
          const full = await catalogDb.getProperty(prop.property_rid);
          return {
            property_rid: prop.property_rid,
            property_id: prop.property_id,
            classification: prop.classification,
            source: prop.source,
            status: prop.status,
            identifiers: full?.identifiers.map(i => ({ type: i.identifier_type, value: i.identifier_value })) ?? [],
          };
        })
      );

      return res.json({
        entries,
        total: result.total,
        next_cursor: result.next_cursor,
      });
    } catch (err) {
      logger.error(`Catalog browse error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/sync ──────────────────────────

  router.get('/catalog/sync', async (req, res) => {
    try {
      const since = req.query.since as string;
      if (!since) {
        return res.status(400).json({ error: 'Missing required parameter: since' });
      }

      const limit = Math.min(req.query.limit ? parseInt(req.query.limit as string, 10) : 10000, 10000);
      const result = await catalogDb.syncProperties(since, limit);

      return res.json(result);
    } catch (err) {
      logger.error(`Catalog sync error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/collections ───────────────────

  router.get('/catalog/collections', async (req, res) => {
    try {
      const limit = parseOptionalQueryInt(req.query.limit, 'limit', { min: 1, max: 1000 });
      if (!limit.ok) return res.status(400).json({ error: limit.error });
      const offset = parseOptionalQueryInt(req.query.offset, 'offset', { min: 0 });
      if (!offset.ok) return res.status(400).json({ error: offset.error });

      const result = await collectionCatalogDb.listCollections({
        publisher_domain: req.query.publisher_domain as string | undefined,
        source: req.query.source as string | undefined,
        status: req.query.status as string | undefined,
        identifier_type: req.query.identifier_type as string | undefined,
        distribution_publisher_domain: req.query.distribution_publisher_domain as string | undefined,
        search: req.query.search as string | undefined,
        limit: limit.value,
        offset: offset.value,
      });

      const entries = await Promise.all(
        result.collections.map(async (collection) => {
          const full = await collectionCatalogDb.getCollection(collection.collection_rid);
          return {
            collection_rid: collection.collection_rid,
            publisher_domain: collection.publisher_domain,
            collection_id: collection.collection_id,
            name: collection.name,
            kind: collection.kind,
            source: collection.source,
            status: collection.status,
            identifiers: full?.identifiers.map((i) => ({
              publisher_domain: i.distribution_publisher_domain,
              type: i.identifier_type,
              value: i.identifier_value,
            })) ?? [],
            collection: collection.collection_json,
          };
        }),
      );

      return res.json({
        entries,
        total: result.total,
        next_offset: result.next_offset,
      });
    } catch (err) {
      logger.error(`Collection catalog browse error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/collections/sync ──────────────

  router.get('/catalog/collections/sync', async (req, res) => {
    try {
      const limit = parseOptionalQueryInt(req.query.limit, 'limit', { defaultValue: 1000, min: 1, max: 1000 });
      if (!limit.ok) return res.status(400).json({ error: limit.error });
      const offset = parseOptionalQueryInt(req.query.offset, 'offset', { defaultValue: 0, min: 0 });
      if (!offset.ok) return res.status(400).json({ error: offset.error });
      const result = await collectionCatalogDb.syncCollections(limit.value, offset.value);
      return res.json(result);
    } catch (err) {
      logger.error(`Collection catalog sync error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PUT /api/registry/catalog/collections/:publisher/:collection ─

  router.put(
    '/catalog/collections/:publisherDomain/:collectionId',
    requireCatalogWriteConfigured,
    ...collectionWriteMiddleware,
    async (req, res) => {
      const publisherDomain = canonicalizePublisherDomain(req.params.publisherDomain);
      const collectionId = req.params.collectionId?.trim();
      if (!isValidCollectionPublisherDomain(publisherDomain)) {
        return res.status(400).json({ error: 'Invalid publisher_domain' });
      }
      if (!collectionId) {
        return res.status(400).json({ error: 'collection_id is required' });
      }

      try {
        const rawCollection = req.body?.collection
          && typeof req.body.collection === 'object'
          && !Array.isArray(req.body.collection)
          ? req.body.collection
          : req.body;
        const parsed = CommunityCollectionUpsertSchema.safeParse(rawCollection);
        if (!parsed.success) {
          return res.status(400).json({ error: 'Invalid collection', details: parsed.error.issues });
        }
        if (parsed.data.collection_id && parsed.data.collection_id !== collectionId) {
          return res.status(400).json({
            error: 'collection_id in body must match the collection_id path parameter',
          });
        }

        const client = await getClient();
        try {
          await client.query('BEGIN');
          const authoritative = await client.query<{ collection_rid: string }>(
            `SELECT collection_rid
               FROM catalog_collections
              WHERE publisher_domain = $1
                AND collection_id = $2
                AND source = 'authoritative'
                AND status <> 'removed'
              LIMIT 1`,
            [publisherDomain, collectionId],
          );
          if (authoritative.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'Cannot edit authoritative collection managed via publisher adagents.json',
              publisher_domain: publisherDomain,
              collection_id: collectionId,
            });
          }

          const collection = {
            ...parsed.data,
            collection_id: collectionId,
          };
          const actor = req.user?.id ? `api:community_collection:${req.user.id}` : 'api:community_collection';
          const event = await collectionCatalogDb.projectCollection(client, {
            publisherDomain,
            collection,
            evidence: 'community',
            confidence: 'strong',
            source: 'contributed',
            adagentsUrl: null,
            createdBy: actor,
          });
          if (event) {
            await catalogEventsDb.writeEvent(
              {
                event_type: event.event_type,
                entity_type: 'collection',
                entity_id: event.collection_rid,
                payload: collectionEventPayload(event),
                actor,
              },
              client,
            );
          }
          await client.query('COMMIT');
          return res.json({
            success: true,
            event_type: event?.event_type ?? null,
            collection: event
              ? collectionEventPayload(event)
              : {
                  publisher_domain: publisherDomain,
                  collection_id: collectionId,
                  source: 'contributed',
                  status: 'active',
                },
          });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error({ err, publisherDomain, collectionId }, 'Community collection upsert failed');
        return res.status(500).json({ error: 'Failed to upsert collection' });
      }
    },
  );

  async function sendCollectionIdentifierLookup(
    res: Parameters<RequestHandler>[1],
    publisherDomain: string,
    identifierType: string,
    identifierValue: string,
  ) {
    const collection = await collectionCatalogDb.lookupByDistributionIdentifier(
      publisherDomain,
      identifierType,
      identifierValue,
    );
    if (!collection) {
      return res.status(404).json({ error: 'Collection identifier not found in catalog' });
    }

    return res.json({
      collection_rid: collection.collection_rid,
      publisher_domain: collection.publisher_domain,
      collection_id: collection.collection_id,
      name: collection.name,
      kind: collection.kind,
      source: collection.source,
      status: collection.status,
      identifiers: collection.identifiers.map((i) => ({
        publisher_domain: i.distribution_publisher_domain,
        type: i.identifier_type,
        value: i.identifier_value,
      })),
      collection: collection.collection_json,
    });
  }

  // ── GET /api/registry/catalog/collections/distribution ───────

  router.get('/catalog/collections/distribution', async (req, res) => {
    try {
      const publisherDomain = req.query.publisher_domain;
      const identifierType = req.query.identifier_type;
      const identifierValue = req.query.identifier_value;
      if (
        typeof publisherDomain !== 'string'
        || typeof identifierType !== 'string'
        || typeof identifierValue !== 'string'
      ) {
        return res.status(400).json({
          error: 'publisher_domain, identifier_type, and identifier_value query parameters are required',
        });
      }
      return sendCollectionIdentifierLookup(res, publisherDomain, identifierType, identifierValue);
    } catch (err) {
      logger.error(`Collection identifier lookup error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/collections/distribution/:publisher/:type/:value ──

  router.get('/catalog/collections/distribution/:publisherDomain/:identifierType/:identifierValue', async (req, res) => {
    try {
      return sendCollectionIdentifierLookup(
        res,
        req.params.publisherDomain,
        req.params.identifierType,
        req.params.identifierValue,
      );
    } catch (err) {
      logger.error(`Collection identifier lookup error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/:identifier/activity ──────────

  router.get('/catalog/:identifierType/:identifierValue/activity', async (req, res) => {
    try {
      const { identifierType, identifierValue } = req.params;
      const norm = normalizeIdentifier(identifierType, identifierValue);

      // Look up the property_rid for this identifier
      const lookupResult = await catalogDb.resolveIdentifiers(
        [{ type: norm.type, value: norm.value }],
        'lookup',
        'system',
        { type: 'data_partner' }
      );

      const entry = lookupResult.resolved[0];
      if (!entry?.property_rid) {
        return res.status(404).json({ error: 'Identifier not found in catalog' });
      }

      const activity = await catalogDb.getPropertyActivity(entry.property_rid);

      return res.json({
        identifier: { type: norm.type, value: norm.value },
        property_rid: entry.property_rid,
        source: entry.source,
        activity,
      });
    } catch (err) {
      logger.error(`Activity error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/registry/catalog/disputes ─────────────────────

  router.post('/catalog/disputes', async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const parsed = DisputeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      }

      const result = await fileDispute({
        ...parsed.data,
        dispute_type: parsed.data.dispute_type as DisputeType,
        reported_by: req.user.email,
        reported_by_email: req.user.email,
      });

      return res.json(result);
    } catch (err) {
      logger.error(`Dispute error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/registry/catalog/disputes/:id ──────────────────

  router.get('/catalog/disputes/:id', async (req, res) => {
    try {
      const dispute = await disputesDb.getDispute(req.params.id);
      if (!dispute) {
        return res.status(404).json({ error: 'Dispute not found' });
      }
      return res.json(dispute);
    } catch (err) {
      logger.error(`Dispute lookup error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/registry/catalog/seed/gcs ────────────────────────
  // Admin endpoint: one-shot import from GCS CSVs into catalog tables.
  // Pulls CSVs directly from public GCS bucket, no local filesystem needed.

  router.post('/catalog/seed/gcs', async (req, res, next) => {
    if (!adminAuthMiddleware && !authMiddleware) {
      return res.status(503).json({ error: 'Admin endpoints require authentication configuration' });
    }
    next();
  }, ...adminMiddleware, async (req, res) => {
    const GCS_BASE = 'https://storage.googleapis.com/aao-catalog-seed';
    const actor = 'system:scope3_seed';
    // PostgreSQL max 65535 params. Worst case: 5 (property) + 6 (identifier) = 11 per row.
    // floor(65535 / 11) = 5957. Use 5000 for safety.
    const BATCH = 5000;
    const MAX_SEED_BYTES = 150 * 1024 * 1024; // 150MB per shard (1GB Fly machine)

    const { getClient } = await import('../db/client.js');
    const { uuidv7 } = await import('../db/uuid.js');
    const { normalizeIdentifier } = await import('../services/identifier-normalization.js');

    // Stream newline-delimited JSON progress to keep Fly proxy alive
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    function progress(data: Record<string, unknown>): void {
      res.write(JSON.stringify(data) + '\n');
    }

    try {
      const results: Record<string, unknown> = {};

      // Fetch a GCS shard, process CSV lines in batches
      async function processGcsShard(
        response: Response,
        url: string,
        prefix: string,
        shard: number,
        processor: (lines: string[]) => Promise<number>
      ): Promise<number> {
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_SEED_BYTES) {
          throw new Error(`Seed file too large: ${contentLength} bytes (max ${MAX_SEED_BYTES})`);
        }

        const text = await response.text();
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const dataLines = lines.slice(1); // skip CSV header

        let totalRows = 0;
        for (let i = 0; i < dataLines.length; i += BATCH) {
          totalRows += await processor(dataLines.slice(i, i + BATCH));
          if (i > 0 && i % 50000 === 0) {
            progress({ step: prefix, shard, rows: totalRows, batch: i });
          }
        }
        return totalRows;
      }

      // Iterate BigQuery EXPORT DATA shards (prefix-000000000000.csv, -000000000001.csv, ...)
      async function processGcsFile(
        prefix: string,
        processor: (lines: string[]) => Promise<number>
      ): Promise<{ rows: number; time_ms: number }> {
        const start = Date.now();
        let totalRows = 0;
        let shard = 0;

        while (true) {
          const shardId = String(shard).padStart(12, '0');
          const url = `${GCS_BASE}/${prefix}-${shardId}.csv`;
          logger.info(`Fetching ${url}`);

          const response = await fetch(url);
          if (response.status === 404) break;
          if (!response.ok) {
            throw new Error(`GCS fetch failed for ${url}: ${response.status} ${response.statusText}`);
          }

          totalRows += await processGcsShard(response, url, prefix, shard, processor);
          progress({ step: prefix, shard, rows: totalRows, status: 'shard_done' });
          logger.info(`  ${prefix}: shard ${shard} done (${totalRows.toLocaleString()} rows so far)`);
          shard++;
        }

        if (shard === 0) {
          throw new Error(`No shards found for ${prefix} at ${GCS_BASE}`);
        }

        return { rows: totalRows, time_ms: Date.now() - start };
      }

      // 1. Ad infra classifications (bulk insert)
      results.ad_infra = await processGcsFile('ad-infra', async (lines) => {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          const values: unknown[] = [];
          let idx = 0;

          for (const line of lines) {
            const domain = line.trim().toLowerCase();
            if (!domain || !domain.includes('.')) continue;
            values.push(uuidv7(), `domain:${domain}`, actor);
            idx++;
          }

          if (idx > 0) {
            const placeholders = Array.from({ length: idx }, (_, i) => {
              const base = i * 3;
              return `($${base + 1}, 'classification', 'identifier', $${base + 2}, 'classified_as', 'ad_infra', 'data_partner', 'strong', $${base + 3})`;
            }).join(',');

            await client.query(
              `INSERT INTO catalog_facts (fact_id, fact_type, subject_type, subject_value, predicate, object_value, source, confidence, actor)
               VALUES ${placeholders}
               ON CONFLICT DO NOTHING`,
              values
            );
          }

          await client.query('COMMIT');
          return idx;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });

      // 2. Web properties
      results.web_properties = await processGcsFile('web-properties', async (lines) => {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          const propValues: unknown[] = [];
          const identValues: unknown[] = [];
          let propIdx = 0;

          for (const line of lines) {
            const domain = line.trim().toLowerCase();
            if (!domain || !domain.includes('.')) continue;

            const norm = normalizeIdentifier('domain', domain);
            const rid = uuidv7();

            propValues.push(rid, 'property', 'contributed', 'active', actor);
            identValues.push(uuidv7(), rid, norm.type, norm.value, 'data_partner', 'strong');
            propIdx++;
          }

          if (propIdx > 0) {
            const propPlaceholders = Array.from({ length: propIdx }, (_, i) => {
              const base = i * 5;
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
            }).join(',');

            await client.query(
              `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
               VALUES ${propPlaceholders}
               ON CONFLICT (property_rid) DO NOTHING`,
              propValues
            );

            const identPlaceholders = Array.from({ length: propIdx }, (_, i) => {
              const base = i * 6;
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
            }).join(',');

            await client.query(
              `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
               VALUES ${identPlaceholders}
               ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
              identValues
            );
          }

          await client.query('COMMIT');
          return propIdx;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });

      // 3. App properties
      results.app_properties = await processGcsFile('app-properties', async (lines) => {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          const propValues: unknown[] = [];
          const identValues: unknown[] = [];
          let propIdx = 0;

          for (const line of lines) {
            const comma = line.indexOf(',');
            if (comma === -1) continue;
            const inventoryType = line.substring(0, comma).trim();
            const identifier = line.substring(comma + 1).trim();
            if (!identifier) continue;

            let identType: string;
            let identValue: string;
            switch (inventoryType) {
              case 'GOOGLE_PLAY_STORE':
                if (/^[a-z]/.test(identifier) && identifier.includes('.')) {
                  identType = 'android_package';
                  identValue = identifier.toLowerCase();
                } else {
                  identType = 'google_play_id';
                  identValue = identifier;
                }
                break;
              case 'APPLE_APP_STORE':
                if (/^\d+$/.test(identifier)) {
                  identType = 'apple_app_store_id';
                  identValue = identifier;
                } else {
                  identType = 'ios_bundle';
                  identValue = identifier.toLowerCase();
                }
                break;
              case 'ROKU':
                identType = 'roku_store_id'; identValue = identifier; break;
              case 'SAMSUNG':
                identType = 'samsung_app_id'; identValue = identifier; break;
              case 'AMAZON':
                identType = 'fire_tv_asin'; identValue = identifier; break;
              default:
                continue;
            }

            const norm = normalizeIdentifier(identType, identValue);
            const rid = uuidv7();

            propValues.push(rid, 'property', 'contributed', 'active', actor);
            identValues.push(uuidv7(), rid, norm.type, norm.value, 'data_partner', 'strong');
            propIdx++;
          }

          if (propIdx > 0) {
            const propPlaceholders = Array.from({ length: propIdx }, (_, i) => {
              const base = i * 5;
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
            }).join(',');

            await client.query(
              `INSERT INTO catalog_properties (property_rid, classification, source, status, created_by)
               VALUES ${propPlaceholders}
               ON CONFLICT (property_rid) DO NOTHING`,
              propValues
            );

            const identPlaceholders = Array.from({ length: propIdx }, (_, i) => {
              const base = i * 6;
              return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
            }).join(',');

            await client.query(
              `INSERT INTO catalog_identifiers (id, property_rid, identifier_type, identifier_value, evidence, confidence)
               VALUES ${identPlaceholders}
               ON CONFLICT (identifier_type, identifier_value) DO NOTHING`,
              identValues
            );
          }

          await client.query('COMMIT');
          return propIdx;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });

      logger.info(`GCS seed complete: ${JSON.stringify(results)}`);
      progress({ status: 'complete', results });
      res.end();
    } catch (err) {
      logger.error(`GCS seed error: ${err instanceof Error ? err.message : String(err)}`);
      progress({ status: 'error', error: err instanceof Error ? err.message : 'Seed import failed' });
      res.end();
    }
  });

  // ── POST /api/registry/catalog/tranco/load ─────────────────────
  // Admin endpoint: load Tranco list into memory for lookups

  router.post('/catalog/tranco/load', ...adminMiddleware, async (_req, res) => {
    try {
      const result = await loadTrancoList();
      return res.json(result);
    } catch (err) {
      logger.error(`Tranco load error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Failed to load Tranco list' });
    }
  });

  // ── POST /api/registry/catalog/tranco/lookup ──────────────────
  // Look up Tranco ranks for a list of domains

  router.post('/catalog/tranco/lookup', async (req, res) => {
    try {
      const domains = req.body?.domains as string[];
      if (!Array.isArray(domains) || domains.length === 0) {
        return res.status(400).json({ error: 'domains array is required' });
      }
      if (domains.length > 10000) {
        return res.status(400).json({ error: 'Maximum 10,000 domains per request' });
      }

      if (!isTrancoLoaded()) {
        return res.status(503).json({ error: 'Tranco list not loaded. POST /catalog/tranco/load first.' });
      }

      const results = lookupTrancoRanks(domains);
      const entries = Array.from(results.values());

      return res.json({
        results: entries,
        summary: {
          total: entries.length,
          in_tranco: entries.filter(e => e.rank !== null).length,
          in_top_1k: entries.filter(e => e.in_top_1k).length,
          in_top_10k: entries.filter(e => e.in_top_10k).length,
          in_top_100k: entries.filter(e => e.in_top_100k).length,
          not_found: entries.filter(e => e.rank === null).length,
        },
      });
    } catch (err) {
      logger.error(`Tranco lookup error: ${err instanceof Error ? err.message : String(err)}`);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
