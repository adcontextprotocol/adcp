/**
 * Pure decision function for which verification-panel hint to show
 * when a per-agent compliance card has zero badges.
 *
 * Lives here (and is tested here) because the matrix is non-obvious:
 * `!hasAuth` short-circuits even a stale-passing cached status (rotated
 * creds), opted-out is terminal, and `passing && declared === 0` is the
 * silent failure mode that earned its own branch.
 *
 * The dashboard JS duplicates this exact ordering when it picks the
 * literal copy to render — keep this function and that branch in sync.
 */

export type ComplianceCardStatus =
  | 'passing'
  | 'degraded'
  | 'failing'
  | 'opted_out'
  | 'unknown'
  | null
  | undefined;

export type VerificationHintKey =
  | 'no_auth'
  | 'opted_out'
  | 'passing_no_specialisms'
  | 'passing_pending_heartbeat'
  | 'storyboards_failing'
  | 'storyboards_partial'
  | 'storyboards_untested'
  | 'unknown_default';

export type StoryboardBlockingReason = 'failing' | 'partial' | 'untested';

export interface StoryboardStatusLike {
  status?: string | null;
}

export interface PickHintInput {
  status: ComplianceCardStatus;
  declaredSpecialismCount: number;
  hasAuth: boolean;
  badgeCount: number;
  storyboardBlockingReason?: StoryboardBlockingReason;
}

/**
 * Pick the most actionable blocker from saved storyboard results.
 * Missing or empty results deliberately return undefined so callers retain
 * the conservative, backward-compatible fallback for older records.
 */
export function pickStoryboardBlockingReason(
  statuses: readonly (StoryboardStatusLike | null | undefined)[] | null | undefined,
): StoryboardBlockingReason | undefined {
  if (!statuses || statuses.length === 0) return undefined;

  for (const reason of ['failing', 'partial', 'untested'] as const) {
    if (statuses.some((row) => row?.status === reason)) return reason;
  }

  return undefined;
}

export function pickVerificationHint(input: PickHintInput): VerificationHintKey | null {
  if (input.badgeCount > 0) return null;

  if (!input.hasAuth) return 'no_auth';

  switch (input.status) {
    case 'opted_out':
      return 'opted_out';
    case 'passing':
      return input.declaredSpecialismCount === 0
        ? 'passing_no_specialisms'
        : 'passing_pending_heartbeat';
    case 'failing':
    case 'degraded':
      if (input.storyboardBlockingReason === 'partial') return 'storyboards_partial';
      if (input.storyboardBlockingReason === 'untested') return 'storyboards_untested';
      return 'storyboards_failing';
    default:
      return 'unknown_default';
  }
}
