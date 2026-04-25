/**
 * Invariant runner. Executes a list of invariants in sequence, isolates
 * failures (one invariant throwing doesn't cancel the others), and returns
 * an aggregated report.
 */
import type {
  Invariant,
  InvariantContext,
  InvariantRunReport,
  InvariantRunStats,
  Severity,
  Violation,
} from './types.js';

export async function runAllInvariants(
  invariants: readonly Invariant[],
  ctx: InvariantContext,
): Promise<InvariantRunReport> {
  const startedAt = new Date();
  const violations: Violation[] = [];
  const stats: Record<string, InvariantRunStats> = {};

  // Allocate a fresh per-run Stripe customer cache so invariants that hit
  // `customers.retrieve` for the same id only pay the API call once per run.
  // (#1 and #3 in Phase 1 both walk the same set.) Caller can override by
  // pre-populating ctx.stripeCustomerCache; we leave that alone.
  const ctxWithCache: InvariantContext = ctx.stripeCustomerCache
    ? ctx
    : { ...ctx, stripeCustomerCache: new Map() };

  // Sequential by design (Phase 1): predictable Stripe/WorkOS API budget,
  // simpler reasoning, no race against per-invariant rate limits. Phase 2
  // can introduce bounded parallelism once we've measured real costs.
  for (const inv of invariants) {
    stats[inv.name] = await runOneInvariantInto(inv, ctxWithCache, violations);
  }

  const completedAt = new Date();
  const violationsBySeverity: Record<Severity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  for (const v of violations) {
    violationsBySeverity[v.severity]++;
  }

  return {
    started_at: startedAt,
    completed_at: completedAt,
    total_violations: violations.length,
    violations_by_severity: violationsBySeverity,
    violations,
    stats,
  };
}

export async function runOneInvariant(
  invariant: Invariant,
  ctx: InvariantContext,
): Promise<InvariantRunReport> {
  return runAllInvariants([invariant], ctx);
}

async function runOneInvariantInto(
  invariant: Invariant,
  ctx: InvariantContext,
  appendViolationsTo: Violation[],
): Promise<InvariantRunStats> {
  const t0 = Date.now();
  try {
    const result = await invariant.check(ctx);
    appendViolationsTo.push(...result.violations);
    return {
      ms: Date.now() - t0,
      checked: result.checked,
      violations: result.violations.length,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ err, invariant: invariant.name }, 'Invariant check threw');
    // Record a meta-violation so the failure is visible in the report
    // and operators don't see a silently-incomplete check.
    const metaViolation: Violation = {
      invariant: invariant.name,
      severity: 'warning',
      subject_type: 'configuration',
      subject_id: invariant.name,
      message: `Invariant check failed to run: ${error}`,
    };
    appendViolationsTo.push(metaViolation);
    return {
      ms: Date.now() - t0,
      checked: 0,
      violations: 1,
      error,
    };
  }
}
