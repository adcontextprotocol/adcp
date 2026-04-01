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
import { CatalogDisputesDatabase, type DisputeType } from '../db/catalog-disputes-db.js';
import { fileDispute } from '../services/catalog-governance.js';
import { normalizeIdentifier } from '../services/identifier-normalization.js';
import { loadTrancoList, lookupTrancoRanks, isTrancoLoaded } from '../services/tranco-ingestion.js';
import { createLogger } from '../logger.js';

const logger = createLogger('catalog-api');
const catalogDb = new CatalogDatabase();
const disputesDb = new CatalogDisputesDatabase();

// ── Zod Schemas ─────────────────────────────────────────────────

const IdentifierSchema = z.object({
  type: z.string(),
  value: z.string(),
});

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

// ── Config ──────────────────────────────────────────────────────

export interface CatalogApiConfig {
  requireAuth?: RequestHandler;
  requireAdmin?: RequestHandler;
}

// ── Router factory ──────────────────────────────────────────────

export function createCatalogApiRouter(config: CatalogApiConfig): Router {
  const router = Router();
  const { requireAuth: authMiddleware, requireAdmin: adminAuthMiddleware } = config;

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

  const adminMiddleware = adminAuthMiddleware
    ? (authMiddleware ? [authMiddleware, adminAuthMiddleware] : [adminAuthMiddleware])
    : authMiddleware ? [authMiddleware] : [];

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
          await client.query('ROLLBACK');
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
          await client.query('ROLLBACK');
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
          await client.query('ROLLBACK');
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
