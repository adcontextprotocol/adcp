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
import type { Request, Router } from 'express';
import type { WorkOS } from '@workos-inc/node';
import { requireGlobalAdmin } from '../../middleware/auth.js';
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
import { detectEnvMismatch } from '../../audit/integrity/env-mismatch.js';

const logger = createLogger('admin-integrity-routes');

/**
 * Realistic upper bound on per-run sample size. Each unit costs at least one
 * external API call; 1000 is well above any genuine run while preventing a
 * misclick from burning rate-limit budget for the whole product.
 */
const MAX_SAMPLE_SIZE = 1000;

interface IntegrityRoutesConfig {
  workos: WorkOS | null;
}

interface ParsedOptions {
  options: InvariantOptions | undefined;
  /** Set when query input was malformed; caller should 400. */
  error?: { field: string; message: string };
}

export function setupIntegrityRoutes(apiRouter: Router, config: IntegrityRoutesConfig): void {
  const { workos } = config;

  apiRouter.get('/integrity/invariants', ...requireGlobalAdmin, (_req, res) => {
    res.json({
      invariants: ALL_INVARIANTS.map((inv) => ({
        name: inv.name,
        description: inv.description,
        severity: inv.severity,
      })),
    });
  });

  apiRouter.get('/integrity/check', ...requireGlobalAdmin, async (req, res) => {
    const guard = guardPreconditions(req, workos);
    if (guard) return res.status(guard.status).json(guard.body);

    const parsed = parseOptions(req.query);
    if (parsed.error) {
      return res.status(400).json({ error: 'Invalid query parameter', message: parsed.error.message });
    }

    const ctx: InvariantContext = {
      pool: getPool(),
      stripe: stripe!,
      workos: workos!,
      logger,
      options: parsed.options,
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
      res.status(500).json({ error: 'Integrity check failed', message: 'See server logs for details.' });
    }
  });

  apiRouter.get('/integrity/check/:name', ...requireGlobalAdmin, async (req, res) => {
    const guard = guardPreconditions(req, workos);
    if (guard) return res.status(guard.status).json(guard.body);

    const invariant = getInvariantByName(req.params.name);
    if (!invariant) {
      return res.status(404).json({
        error: 'Invariant not found',
        message: `No invariant registered with name "${req.params.name}". List available invariants at GET /api/admin/integrity/invariants.`,
      });
    }

    const parsed = parseOptions(req.query);
    if (parsed.error) {
      return res.status(400).json({ error: 'Invalid query parameter', message: parsed.error.message });
    }

    const ctx: InvariantContext = {
      pool: getPool(),
      stripe: stripe!,
      workos: workos!,
      logger,
      options: parsed.options,
    };

    try {
      const report = await runOneInvariant(invariant, ctx);
      res.json(report);
    } catch (err) {
      logger.error({ err, invariant: invariant.name }, 'Single invariant check failed');
      res.status(500).json({ error: 'Integrity check failed', message: 'See server logs for details.' });
    }
  });
}

function guardPreconditions(
  _req: Request,
  workos: WorkOS | null,
): { status: number; body: Record<string, unknown> } | null {
  if (!stripe) {
    return {
      status: 503,
      body: {
        error: 'Stripe not configured',
        message: 'Integrity checks require STRIPE_SECRET_KEY.',
      },
    };
  }
  if (!workos) {
    return {
      status: 503,
      body: {
        error: 'WorkOS not configured',
        message: 'Integrity checks require WORKOS_API_KEY and WORKOS_CLIENT_ID.',
      },
    };
  }
  const mismatch = detectEnvMismatch();
  if (mismatch) {
    return {
      status: 412,
      body: {
        error: 'Environment mismatch',
        message: mismatch,
      },
    };
  }
  return null;
}

function parseOptions(query: Record<string, unknown>): ParsedOptions {
  const opts: InvariantOptions = {};

  if (query.sample_size !== undefined) {
    if (typeof query.sample_size !== 'string') {
      return { options: undefined, error: { field: 'sample_size', message: 'sample_size must be a string integer' } };
    }
    const n = Number.parseInt(query.sample_size, 10);
    if (!Number.isFinite(n) || n <= 0 || String(n) !== query.sample_size.trim()) {
      return { options: undefined, error: { field: 'sample_size', message: `sample_size must be a positive integer (got "${query.sample_size}")` } };
    }
    if (n > MAX_SAMPLE_SIZE) {
      return { options: undefined, error: { field: 'sample_size', message: `sample_size cannot exceed ${MAX_SAMPLE_SIZE}` } };
    }
    opts.sampleSize = n;
  }

  if (query.since !== undefined) {
    if (typeof query.since !== 'string') {
      return { options: undefined, error: { field: 'since', message: 'since must be an ISO 8601 date string' } };
    }
    const d = new Date(query.since);
    if (Number.isNaN(d.getTime())) {
      return { options: undefined, error: { field: 'since', message: `since is not a valid ISO 8601 date (got "${query.since}")` } };
    }
    opts.sinceUpdated = d;
  }

  return { options: Object.keys(opts).length > 0 ? opts : undefined };
}
