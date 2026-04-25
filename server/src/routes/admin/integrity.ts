/**
 * Admin routes for the integrity-invariants framework.
 *
 *   GET /api/admin/integrity/invariants      - list all registered invariants
 *   GET /api/admin/integrity/check           - run every invariant; return report
 *   GET /api/admin/integrity/check/:name     - run one invariant; return report
 *
 * Phase 1 surface: on-demand only. Phase 2 will add scheduled runs and a
 * persisted `integrity_runs` table for graphing drift over time.
 */
import type { Router } from 'express';
import type { WorkOS } from '@workos-inc/node';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { getPool } from '../../db/client.js';
import { stripe } from '../../billing/stripe-client.js';
import { createLogger } from '../../logger.js';
import {
  runAllInvariants,
  runOneInvariant,
  ALL_INVARIANTS,
  getInvariantByName,
  type InvariantContext,
  type InvariantOptions,
} from '../../audit/integrity/index.js';

const logger = createLogger('admin-integrity-routes');

interface IntegrityRoutesConfig {
  workos: WorkOS | null;
}

export function setupIntegrityRoutes(apiRouter: Router, config: IntegrityRoutesConfig): void {
  const { workos } = config;

  apiRouter.get('/integrity/invariants', requireAuth, requireAdmin, (_req, res) => {
    res.json({
      invariants: ALL_INVARIANTS.map((inv) => ({
        name: inv.name,
        description: inv.description,
        severity: inv.severity,
      })),
    });
  });

  apiRouter.get('/integrity/check', requireAuth, requireAdmin, async (req, res) => {
    if (!stripe) {
      return res.status(503).json({
        error: 'Stripe not configured',
        message: 'Integrity checks require STRIPE_SECRET_KEY.',
      });
    }
    if (!workos) {
      return res.status(503).json({
        error: 'WorkOS not configured',
        message: 'Integrity checks require WorkOS env vars.',
      });
    }

    const ctx: InvariantContext = {
      pool: getPool(),
      stripe,
      workos,
      logger,
      options: parseOptions(req.query),
    };

    try {
      const report = await runAllInvariants(ALL_INVARIANTS, ctx);
      logger.info(
        {
          totalViolations: report.total_violations,
          bySeverity: report.violations_by_severity,
          ms: report.completed_at.getTime() - report.started_at.getTime(),
          adminEmail: req.user?.email,
        },
        'Integrity check completed',
      );
      res.json(report);
    } catch (err) {
      logger.error({ err }, 'Integrity check failed');
      res.status(500).json({ error: 'Integrity check failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  apiRouter.get('/integrity/check/:name', requireAuth, requireAdmin, async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }
    if (!workos) {
      return res.status(503).json({ error: 'WorkOS not configured' });
    }

    const invariant = getInvariantByName(req.params.name);
    if (!invariant) {
      return res.status(404).json({
        error: 'Invariant not found',
        message: `No invariant registered with name "${req.params.name}". List available invariants at GET /api/admin/integrity/invariants.`,
      });
    }

    const ctx: InvariantContext = {
      pool: getPool(),
      stripe,
      workos,
      logger,
      options: parseOptions(req.query),
    };

    try {
      const report = await runOneInvariant(invariant, ctx);
      res.json(report);
    } catch (err) {
      logger.error({ err, invariant: invariant.name }, 'Single invariant check failed');
      res.status(500).json({ error: 'Integrity check failed', message: err instanceof Error ? err.message : String(err) });
    }
  });
}

function parseOptions(query: Record<string, unknown>): InvariantOptions | undefined {
  const opts: InvariantOptions = {};
  if (typeof query.sample_size === 'string') {
    const n = Number.parseInt(query.sample_size, 10);
    if (Number.isFinite(n) && n > 0 && n <= 10_000) {
      opts.sampleSize = n;
    }
  }
  if (typeof query.since === 'string') {
    const d = new Date(query.since);
    if (!Number.isNaN(d.getTime())) {
      opts.sinceUpdated = d;
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}
