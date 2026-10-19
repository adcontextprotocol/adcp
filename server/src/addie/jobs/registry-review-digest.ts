/**
 * Registry review backlog digest (adcp#8338).
 *
 * Since #8337 the automated registry review fails safe: an unparseable
 * verdict, an out-of-contract verdict, or a failed model call (an
 * Anthropic outage, or a deployment with no `ANTHROPIC_API_KEY`) leaves
 * the submission waiting instead of publishing it. The per-submission
 * Slack post already exists; what it cannot show is accumulation. A daily
 * count and oldest-age is how an outage-driven backlog becomes visible
 * before a member notices their record never appeared.
 *
 * Quiet by design: nothing is posted while the queue is empty or while
 * everything in it is fresh enough that a moderator plausibly has not
 * looked yet.
 */

import { createLogger } from '../../logger.js';
import { getRegistryReviewBacklog } from '../../db/registry-review-queue-db.js';
import { notifyRegistryReviewBacklog } from '../../notifications/registry.js';

const logger = createLogger('registry-review-digest');

/**
 * How long something has to sit before the digest mentions it. Matches
 * the brand-logo and community-mirror digests so moderators get one
 * cadence across every registry queue.
 */
export const STALE_THRESHOLD_HOURS = 12;

export interface RegistryReviewDigestResult {
  total: number;
  pendingRecords: number;
  flaggedEditRecords: number;
  flaggedEdits: number;
  oldestAgeHours: number | null;
  posted: boolean;
}

export async function runRegistryReviewDigestJob(): Promise<RegistryReviewDigestResult> {
  const backlog = await getRegistryReviewBacklog();
  const result: RegistryReviewDigestResult = {
    total: backlog.total,
    pendingRecords: backlog.pending_records,
    flaggedEditRecords: backlog.flagged_edit_records,
    flaggedEdits: backlog.flagged_edits,
    oldestAgeHours: backlog.oldest_age_hours,
    posted: false,
  };

  if (backlog.total === 0) return result;

  if ((backlog.oldest_age_hours ?? 0) < STALE_THRESHOLD_HOURS) {
    logger.debug(
      { total: backlog.total, oldestAgeHours: backlog.oldest_age_hours },
      'Registry review backlog is fresh, skipping digest',
    );
    return result;
  }

  result.posted = await notifyRegistryReviewBacklog({
    total: backlog.total,
    pending_records: backlog.pending_records,
    flagged_edit_records: backlog.flagged_edit_records,
    flagged_edits: backlog.flagged_edits,
    oldest_age_hours: backlog.oldest_age_hours,
  });

  logger.info(
    {
      total: backlog.total,
      pendingRecords: backlog.pending_records,
      flaggedEditRecords: backlog.flagged_edit_records,
      flaggedEdits: backlog.flagged_edits,
      oldestAgeHours: backlog.oldest_age_hours,
      posted: result.posted,
    },
    'Registry review backlog digest',
  );

  return result;
}
