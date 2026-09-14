export type RunCompleteness = 'complete' | 'timed_out' | 'not_completed';

/** The DB vocabulary is deliberately closed; an unrecognized SDK value proves no completion. */
export function heartbeatRunCompleteness(value: unknown): RunCompleteness {
  return value === 'complete' || value === 'timed_out' ? value : 'not_completed';
}

/** Publication is independent of dry-run visibility. Partial evidence is audit-only. */
export function isAuthoritativeComplianceRun(run: {
  completeness?: RunCompleteness;
  is_authoritative?: boolean;
  triggered_by?: string;
}): boolean {
  // Owner/manual adapters retain their existing compatibility contract.
  const completeness = run.triggered_by === 'heartbeat'
    ? heartbeatRunCompleteness(run.completeness)
    : run.completeness ?? 'complete';
  return run.is_authoritative !== false && completeness === 'complete';
}
