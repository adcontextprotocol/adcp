export type RunCompleteness = 'complete' | 'timed_out' | 'not_completed';

/** Publication is independent of dry-run visibility. Partial evidence is audit-only. */
export function isAuthoritativeComplianceRun(run: {
  completeness?: RunCompleteness;
  is_authoritative?: boolean;
}): boolean {
  return run.is_authoritative !== false && (run.completeness ?? 'complete') === 'complete';
}

/**
 * A run's coverage is incomplete when any track has a coverage-gap skip. This
 * is reported beside the status, not folded into it: a run can pass while some
 * storyboards were never exercised, and those storyboards earn no badge.
 */
export function isCoverageIncomplete(tracks: Array<{ has_coverage_gap_skip?: boolean }> | null | undefined): boolean {
  return Array.isArray(tracks) && tracks.some(track => track?.has_coverage_gap_skip === true);
}
