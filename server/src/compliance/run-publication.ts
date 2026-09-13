export type RunCompleteness = 'complete' | 'timed_out' | 'not_completed';

/** Publication is independent of dry-run visibility. Partial evidence is audit-only. */
export function isAuthoritativeComplianceRun(run: {
  completeness?: RunCompleteness;
  is_authoritative?: boolean;
}): boolean {
  return run.is_authoritative !== false && (run.completeness ?? 'complete') === 'complete';
}
