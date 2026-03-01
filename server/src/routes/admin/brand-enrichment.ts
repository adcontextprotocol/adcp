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
import { query } from '../../db/client.js';
import {
  enrichBrand,
  enrichBrands,
  expandHouse,
  getEnrichmentCandidates,
  getBrandEnrichmentStats,
  migrateLogosToHosted,
  researchDomain,
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

  // POST /api/admin/brand-enrichment/migrate-logos
  // Finds all enriched brands with Brandfetch CDN URLs and re-downloads to our CDN
  apiRouter.post(
    '/brand-enrichment/migrate-logos',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const rawLimit = typeof req.body.limit === 'number' ? req.body.limit : 50;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 200);
        const delayMs = typeof req.body.delay_ms === 'number'
          ? Math.max(0, Math.floor(req.body.delay_ms))
          : 500;

        logger.info({ limit, delayMs }, 'Starting logo migration to CDN');
        const result = await migrateLogosToHosted({ limit, delayMs });
        logger.info(result, 'Logo migration complete');
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, 'Error migrating logos');
        res.status(500).json({ error: 'Internal server error', message: 'Unable to migrate logos' });
      }
    }
  );

  // POST /api/admin/brand-enrichment/expand-house/:domain
  // Discovers sub-brands for a house via Sonnet, seeds them, and optionally enriches via Brandfetch
  apiRouter.post(
    '/brand-enrichment/expand-house/:domain',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domain } = req.params;
        const delayMs = typeof req.body.delay_ms === 'number'
          ? Math.max(0, Math.floor(req.body.delay_ms))
          : 1000;
        const enrichAfterSeed = req.body.enrich !== false;

        if (enrichAfterSeed && !isBrandfetchConfigured()) {
          return res.status(503).json({
            error: 'Brandfetch not configured',
            message: 'BRANDFETCH_API_KEY not set. Pass { "enrich": false } to seed without enriching.',
          });
        }

        logger.info({ domain, delayMs, enrichAfterSeed }, 'Starting house expansion');

        const result = await expandHouse(domain, { delayMs, enrichAfterSeed });

        logger.info(
          { domain, discovered: result.discovered, seeded: result.seeded, enriched: result.enriched },
          'House expansion complete'
        );

        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error }, 'Error expanding house');
        res.status(500).json({
          error: 'House expansion failed',
          message,
        });
      }
    }
  );

  // GET /api/admin/brand-enrichment/org-mapping-stats
  // How many orgs are mapped to the brand registry vs unmapped
  apiRouter.get(
    '/brand-enrichment/org-mapping-stats',
    requireAuth,
    requireAdmin,
    async (_req, res) => {
      try {
        const result = await query<{
          total_with_domain: string;
          mapped: string;
          unmapped: string;
        }>(
          `SELECT
            COUNT(*) FILTER (WHERE o.email_domain IS NOT NULL) as total_with_domain,
            COUNT(*) FILTER (WHERE db.domain IS NOT NULL) as mapped,
            COUNT(*) FILTER (WHERE o.email_domain IS NOT NULL AND db.domain IS NULL) as unmapped
          FROM organizations o
          LEFT JOIN discovered_brands db ON db.domain = o.email_domain
          WHERE o.is_personal = false`
        );
        const row = result.rows[0];
        res.json({
          total_with_domain: parseInt(row.total_with_domain) || 0,
          mapped: parseInt(row.mapped) || 0,
          unmapped: parseInt(row.unmapped) || 0,
        });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching org mapping stats');
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/admin/brand-enrichment/unmapped-orgs
  // Organizations with a domain not in discovered_brands
  apiRouter.get(
    '/brand-enrichment/unmapped-orgs',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const rawLimit = parseInt(req.query.limit as string, 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 100) : 50;

        const result = await query<{
          workos_organization_id: string;
          name: string;
          email_domain: string;
          subscription_status: string | null;
          prospect_status: string | null;
        }>(
          `SELECT o.workos_organization_id, o.name, o.email_domain,
                  o.subscription_status, o.prospect_status
           FROM organizations o
           LEFT JOIN discovered_brands db ON db.domain = o.email_domain
           WHERE o.is_personal = false
             AND o.email_domain IS NOT NULL
             AND db.domain IS NULL
           ORDER BY o.subscription_status = 'active' DESC,
                    o.last_activity_at DESC NULLS LAST,
                    o.created_at DESC
           LIMIT $1`,
          [limit]
        );

        res.json({ orgs: result.rows, count: result.rows.length });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching unmapped orgs');
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/admin/brand-enrichment/backfill
  // Research unmapped orgs sequentially
  apiRouter.post(
    '/brand-enrichment/backfill',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const rawLimit = typeof req.body.limit === 'number' ? req.body.limit : 10;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 25);

        const unmapped = await query<{
          workos_organization_id: string;
          name: string;
          email_domain: string;
        }>(
          `SELECT o.workos_organization_id, o.name, o.email_domain
           FROM organizations o
           LEFT JOIN discovered_brands db ON db.domain = o.email_domain
           WHERE o.is_personal = false
             AND o.email_domain IS NOT NULL
             AND db.domain IS NULL
           ORDER BY o.subscription_status = 'active' DESC,
                    o.last_activity_at DESC NULLS LAST
           LIMIT $1`,
          [limit]
        );

        logger.info({ count: unmapped.rows.length, limit }, 'Starting backfill research');

        const results: Array<{ domain: string; name: string; status: string }> = [];
        for (const org of unmapped.rows) {
          try {
            const research = await researchDomain(org.email_domain, {
              org_id: org.workos_organization_id,
            });
            const fetched = research.actions.some(a => a.action === 'fetched');
            results.push({
              domain: org.email_domain,
              name: org.name,
              status: fetched ? 'researched' : 'skipped',
            });
          } catch (err) {
            logger.warn({ err, domain: org.email_domain }, 'Backfill research failed');
            results.push({ domain: org.email_domain, name: org.name, status: 'failed' });
          }
          // Delay between calls
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        const researched = results.filter(r => r.status === 'researched').length;
        logger.info({ total: results.length, researched }, 'Backfill complete');
        res.json({ total: results.length, researched, results });
      } catch (error) {
        logger.error({ err: error }, 'Error running backfill');
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/admin/brand-enrichment/research/:domain
  // Progressive enrichment: checks what's known, fills gaps from Brandfetch + Sonnet + Lusha
  apiRouter.post(
    '/brand-enrichment/research/:domain',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domain } = req.params;
        if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
          return res.status(400).json({ error: 'Invalid domain format' });
        }

        const options: {
          skip_brandfetch?: boolean;
          skip_lusha?: boolean;
          org_id?: string;
        } = {};

        if (req.body.skip_brandfetch === true) options.skip_brandfetch = true;
        if (req.body.skip_lusha === true) options.skip_lusha = true;
        if (typeof req.body.org_id === 'string') options.org_id = req.body.org_id;

        logger.info({ domain, options }, 'Starting domain research');
        const result = await researchDomain(domain, options);
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ err: error }, 'Error researching domain');
        res.status(500).json({ error: 'Domain research failed', message });
      }
    }
  );
}
