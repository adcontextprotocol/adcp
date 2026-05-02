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

/**
 * Detect Stripe-key-mode vs DATABASE_URL environment mismatch. A staging app
 * pointed at a live Stripe key (or vice versa) would surface thousands of
 * phantom critical violations because the Stripe-side state and the AAO-side
 * state describe entirely different worlds. Cheap heuristic: if the URL host
 * looks like prod and the key is `sk_test_*`, refuse. Phase 2 can graduate
 * this to a probe-and-cache. Returns null when no mismatch is detected.
 */
function detectEnvMismatch(): string | null {
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!stripeKey || !databaseUrl) return null;

  const isLiveKey = stripeKey.startsWith('sk_live_');
  const isTestKey = stripeKey.startsWith('sk_test_');

  // Parse the URL and inspect its host explicitly. Substring checks against
  // the raw URL string would match a hostile path/query like
  // postgres://user@evil.example/?aao-prod=1, which is exactly what CodeQL's
  // js/incomplete-url-substring-sanitization rule warns about.
  let host = '';
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    // DATABASE_URL is malformed; treat as "looks like development" so live
    // keys against an unparsable URL are still refused below.
    host = '';
  }

  // Fly.io serves private services to the prod app over `*.flycast` and
  // `*.internal` (6PN). The original allowlist only had `*.fly.dev`, which
  // doesn't match the prod Postgres host — that mis-classified the live app
  // as "not prod" and refused the runner with a "live key against staging"
  // message in production. Recognize the Fly prod patterns plus a positive
  // `FLY_APP_NAME` signal so the runner is unblocked there without
  // loosening the staging guard.
  //
  // Prod app names are configurable so a future deployment (aao-prod-2,
  // staging mirror, etc.) doesn't silently regress this guard.
  const PROD_FLY_APPS = (process.env.AAO_PROD_FLY_APPS ?? 'adcp-docs')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const flyAppName = (process.env.FLY_APP_NAME ?? '').toLowerCase();
  const isFlyProdApp = !!flyAppName && PROD_FLY_APPS.includes(flyAppName);
  const looksProd =
    host.endsWith('.agenticadvertising.org') ||
    host === 'agenticadvertising.org' ||
    host.startsWith('aao-prod') ||
    host.endsWith('.fly.dev') ||
    host.endsWith('.flycast') ||
    host.endsWith('.internal') ||
    isFlyProdApp;

  if (looksProd && isTestKey) {
    return 'STRIPE_SECRET_KEY is sk_test_* but DATABASE_URL points at production. Refusing to run integrity checks against this mismatched configuration.';
  }
  if (!looksProd && isLiveKey) {
    return 'STRIPE_SECRET_KEY is sk_live_* but DATABASE_URL does not look like production. Refusing to run integrity checks — would attribute live Stripe state against staging Postgres.';
  }
  return null;
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

  apiRouter.get('/integrity/check/:name', requireAuth, requireAdmin, async (req, res) => {
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
