/**
 * Brand registry enrichment routes
 *
 * Admin endpoints for programmatic brand enrichment via Brandfetch API.
 * Follows the same pattern as admin/enrichment.ts (Lusha company enrichment).
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { isBrandfetchConfigured } from '../../services/brandfetch.js';
import {
  enrichBrand,
  enrichBrands,
  getEnrichmentCandidates,
  getBrandEnrichmentStats,
} from '../../services/brand-enrichment.js';

const logger = createLogger('admin-brand-enrichment');

const VALID_SOURCES = ['community', 'requests', 'all'] as const;
type EnrichmentSource = typeof VALID_SOURCES[number];

function parseSource(raw: unknown): EnrichmentSource {
  return VALID_SOURCES.includes(raw as EnrichmentSource) ? raw as EnrichmentSource : 'all';
}

export function setupBrandEnrichmentRoutes(apiRouter: Router): void {
  // GET /api/admin/brand-enrichment/status
  apiRouter.get(
    '/brand-enrichment/status',
    requireAuth,
    requireAdmin,
    async (_req, res) => {
      res.json({
        configured: isBrandfetchConfigured(),
        provider: isBrandfetchConfigured() ? 'brandfetch' : null,
      });
    }
  );

  // GET /api/admin/brand-enrichment/stats
  apiRouter.get(
    '/brand-enrichment/stats',
    requireAuth,
    requireAdmin,
    async (_req, res) => {
      try {
        const stats = await getBrandEnrichmentStats();
        res.json(stats);
      } catch (error) {
        logger.error({ err: error }, 'Error fetching brand enrichment stats');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch brand enrichment statistics',
        });
      }
    }
  );

  // GET /api/admin/brand-enrichment/candidates
  apiRouter.get(
    '/brand-enrichment/candidates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const source = parseSource(req.query.source);
        const rawLimit = parseInt(req.query.limit as string, 10);
        const limit = Number.isFinite(rawLimit) ? rawLimit : 25;

        const candidates = await getEnrichmentCandidates({ source, limit });
        res.json({ candidates, count: candidates.length });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching enrichment candidates');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch enrichment candidates',
        });
      }
    }
  );

  // POST /api/admin/brand-enrichment/run
  apiRouter.post(
    '/brand-enrichment/run',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        if (!isBrandfetchConfigured()) {
          return res.status(503).json({
            error: 'Brandfetch not configured',
            message: 'BRANDFETCH_API_KEY environment variable not set',
          });
        }

        const source = parseSource(req.body.source);
        const rawLimit = typeof req.body.limit === 'number' ? req.body.limit : 25;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 50);
        const delayMs = typeof req.body.delay_ms === 'number'
          ? Math.max(0, Math.floor(req.body.delay_ms))
          : 1000;

        logger.info({ source, limit, delayMs }, 'Starting brand enrichment run');

        const result = await enrichBrands({ source, limit, delayMs });

        logger.info(
          { total: result.total, enriched: result.enriched, failed: result.failed },
          'Brand enrichment run complete'
        );

        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error running brand enrichment');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to run brand enrichment',
        });
      }
    }
  );

  // POST /api/admin/brand-enrichment/domain/:domain
  apiRouter.post(
    '/brand-enrichment/domain/:domain',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        if (!isBrandfetchConfigured()) {
          return res.status(503).json({
            error: 'Brandfetch not configured',
            message: 'BRANDFETCH_API_KEY environment variable not set',
          });
        }

        const { domain } = req.params;
        const result = await enrichBrand(domain);

        const statusCode = result.status === 'failed' ? 500 :
                          result.status === 'not_found' ? 404 : 200;

        res.status(statusCode).json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error enriching brand domain');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to enrich brand domain',
        });
      }
    }
  );
}
