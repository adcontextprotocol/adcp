/**
 * Scheduled run of the integrity-invariants framework. The on-demand admin
 * route at /api/admin/integrity/check has been there since Phase 1; this
 * job is Phase 2 — it runs ALL_INVARIANTS on a cadence and posts a single
 * Slack alert per run when any critical violation is found. Without this,
 * problems like "org references a non-existent Stripe customer" surface
 * only when a user happens to load the billing page.
 *
 * One alert per run, listing all critical violations grouped by invariant.
 * The error-notifier's per-source 5-minute throttle keeps a misbehaving
 * environment from spamming the channel.
 */

import { runAllInvariants, ALL_INVARIANTS, type InvariantContext } from '../../audit/integrity/index.js';
import { detectEnvMismatch } from '../../audit/integrity/env-mismatch.js';
import { getPool } from '../../db/client.js';
import { stripe } from '../../billing/stripe-client.js';
import { getWorkos } from '../../auth/workos-client.js';
import { createLogger } from '../../logger.js';
import { notifySystemError } from '../error-notifier.js';

const logger = createLogger('integrity-invariants-job');

export interface IntegrityInvariantsJobResult {
  ran: boolean;
  skippedReason?: string;
  totalViolations: number;
  criticalViolations: number;
  warningViolations: number;
  durationMs: number;
}

export async function runIntegrityInvariantsJob(): Promise<IntegrityInvariantsJobResult> {
  const mismatch = detectEnvMismatch();
  if (mismatch) {
    logger.warn({ reason: mismatch }, 'Skipping integrity run due to environment mismatch');
    return {
      ran: false,
      skippedReason: mismatch,
      totalViolations: 0,
      criticalViolations: 0,
      warningViolations: 0,
      durationMs: 0,
    };
  }
  if (!stripe) {
    return {
      ran: false,
      skippedReason: 'STRIPE_SECRET_KEY not set',
      totalViolations: 0,
      criticalViolations: 0,
      warningViolations: 0,
      durationMs: 0,
    };
  }

  const ctx: InvariantContext = {
    pool: getPool(),
    stripe,
    workos: getWorkos(),
    logger,
  };

  const t0 = Date.now();
  const report = await runAllInvariants(ALL_INVARIANTS, ctx);
  const durationMs = Date.now() - t0;

  const critical = report.violations.filter((v) => v.severity === 'critical');
  const warning = report.violations.filter((v) => v.severity === 'warning');

  if (critical.length > 0) {
    // Group by invariant for a compact summary. The error-notifier truncates
    // at 500 chars so we cap the body explicitly.
    const byInvariant = new Map<string, number>();
    for (const v of critical) {
      byInvariant.set(v.invariant, (byInvariant.get(v.invariant) ?? 0) + 1);
    }
    const summary = Array.from(byInvariant.entries())
      .map(([name, count]) => `${name}: ${count}`)
      .join(', ');
    const sample = critical
      .slice(0, 3)
      .map((v) => `${v.invariant} → ${v.subject_type} ${v.subject_id}: ${v.message}`)
      .join('\n');
    notifySystemError({
      source: 'integrity-invariants',
      errorMessage: `${critical.length} critical violation(s) — ${summary}\n\n${sample}${critical.length > 3 ? `\n…and ${critical.length - 3} more` : ''}`,
    });
  }

  logger.info(
    {
      totalViolations: report.total_violations,
      bySeverity: report.violations_by_severity,
      durationMs,
    },
    'Integrity invariants run completed'
  );

  return {
    ran: true,
    totalViolations: report.total_violations,
    criticalViolations: critical.length,
    warningViolations: warning.length,
    durationMs,
  };
}
