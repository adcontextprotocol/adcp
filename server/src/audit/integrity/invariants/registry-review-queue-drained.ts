/**
 * Invariant: nothing sits in the registry moderation queue past its SLA.
 *
 * Since adcp#8337 the automated registry review fails safe — an
 * unparseable verdict, an out-of-contract verdict, or a failed model call
 * (an Anthropic outage, or a deployment with no `ANTHROPIC_API_KEY`) all
 * leave the submission waiting rather than publishing it. That is the
 * right posture, and it means a provider outage shows up as a growing
 * queue of community records that are invisible to the registry and
 * locked against further member edits.
 *
 * The moderator-facing signal is the daily digest
 * (`registry-review-digest`). This is the operational one, for the
 * operator who is already reading `/api/admin/integrity/check` during an
 * incident and would otherwise have to know the registry queue exists.
 *
 * **One aggregate violation, not one per item.** Every other invariant
 * here asserts that two systems agree, and reports per offending entity
 * because each one is a separate repair. A backlog is a single condition
 * with a single remedy — work the queue — and the outage this exists to
 * catch is exactly when per-item violations would bury the billing and
 * directory findings an operator opens this report for. The per-record
 * detail lives at `/admin/registry-review`.
 *
 * Severity is `warning`, not `critical`: work waiting is not data
 * corruption, and the critical path pages a human.
 */
import type { Pool } from 'pg';
import { getRegistryReviewBacklog } from '../../../db/registry-review-queue-db.js';
import type { Invariant, InvariantContext, InvariantResult } from '../types.js';

/**
 * How long the oldest submission may wait before this fires. Matches the
 * brand-logo moderation SLA so the registry queues share one promise.
 */
export const REGISTRY_REVIEW_SLA_HOURS = 48;

export const registryReviewQueueDrainedInvariant: Invariant = {
  name: 'registry-review-queue-drained',
  description:
    'No community registry submission waits on a moderator for longer than '
    + `${REGISTRY_REVIEW_SLA_HOURS}h. Registry review fails safe (adcp#8337), so an Anthropic `
    + 'outage or a missing ANTHROPIC_API_KEY leaves new brands and properties pending and '
    + 'flagged edits live-but-unreviewed. Both are invisible without this check until a '
    + 'member asks why their record never appeared.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    // Reads the same aggregate the admin page and the digest read, so the
    // three surfaces cannot disagree about what is waiting.
    const backlog = await getRegistryReviewBacklog(ctx.pool as Pool);

    if (backlog.total === 0 || (backlog.oldest_age_hours ?? 0) <= REGISTRY_REVIEW_SLA_HOURS) {
      return { checked: backlog.total, violations: [] };
    }

    const oldestHours = Math.floor(backlog.oldest_age_hours ?? 0);
    return {
      checked: backlog.total,
      violations: [{
        invariant: 'registry-review-queue-drained',
        severity: 'warning',
        subject_type: 'queue',
        subject_id: 'registry-review-queue',
        message:
          `${backlog.total} community registry submission(s) are waiting on a moderator and the `
          + `oldest has waited ${oldestHours}h, past the ${REGISTRY_REVIEW_SLA_HOURS}h SLA. `
          + `${backlog.pending_records} pending record(s) are not visible in the registry at all; `
          + `${backlog.flagged_edits} live edit(s) are unreviewed. Registry review fails safe `
          + '(adcp#8337), so a provider outage or a missing ANTHROPIC_API_KEY builds this backlog '
          + 'silently.',
        details: {
          total: backlog.total,
          pending_brands: backlog.pending_brands,
          pending_properties: backlog.pending_properties,
          flagged_edits: backlog.flagged_edits,
          oldest_age_hours: backlog.oldest_age_hours,
          oldest_waiting_since: backlog.oldest_created_at,
          sla_hours: REGISTRY_REVIEW_SLA_HOURS,
        },
        remediation_hint:
          'Work the queue at /admin/registry-review. If the backlog is outage-driven, check '
          + 'ANTHROPIC_API_KEY and the Anthropic status page first — every item here is a '
          + 'submission the reviewer declined to decide, not a submission it rejected.',
      }],
    };
  },
};
