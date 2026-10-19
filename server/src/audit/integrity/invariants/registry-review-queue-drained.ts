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
 * (`registry-review-digest`). This is the operational one: it fires on
 * the same state from the diagnostics side, so an operator running
 * `/api/admin/integrity/check` during an incident sees the backlog
 * without having to know the registry queue exists.
 *
 * Severity is `warning`, not `critical`: a backlog is work waiting, not
 * data corruption, and the critical path pages a human.
 *
 * Work the queue at /admin/registry-review (adcp#8338).
 */
import { flattenToSingleLine } from '../../../utils/slack-escape.js';
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

/**
 * How long a submission may wait before it counts as a violation. Matches
 * the brand-logo moderation SLA so the registry queues share one promise.
 */
export const REGISTRY_REVIEW_SLA_HOURS = 48;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
/** Domains are validated on write; flatten anyway before composing text. */
const DOMAIN_LABEL_MAX = 253;

interface StaleRow {
  kind: 'pending_record' | 'flagged_edit';
  entity_type: 'brand' | 'property';
  domain: string;
  created_at: Date;
  age_hours: string | number;
  verdict: string | null;
}

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
    const { pool, options } = ctx;
    const limit = Math.min(options?.sampleSize ?? DEFAULT_LIMIT, MAX_LIMIT);
    const violations: Violation[] = [];

    const stale = await pool.query<StaleRow>(
      `SELECT * FROM (
         SELECT 'pending_record'::text AS kind, 'brand'::text AS entity_type,
                domain, created_at, NULL::text AS verdict
         FROM brands WHERE review_status = 'pending'
         UNION ALL
         SELECT 'pending_record'::text AS kind, 'property'::text AS entity_type,
                publisher_domain AS domain, created_at, NULL::text AS verdict
         FROM hosted_properties WHERE review_status = 'pending'
         UNION ALL
         SELECT 'flagged_edit'::text AS kind, entity_type, domain, created_at, verdict
         FROM registry_review_queue
         WHERE resolved_at IS NULL AND submission_kind = 'edit'
       ) queue
       WHERE created_at < NOW() - ($1 || ' hours')::interval
       ORDER BY created_at ASC
       LIMIT $2`,
      [String(REGISTRY_REVIEW_SLA_HOURS), limit],
    );

    for (const row of stale.rows) {
      const ageHours = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 3_600_000);
      const domain = flattenToSingleLine(row.domain, DOMAIN_LABEL_MAX);
      const what = row.kind === 'pending_record'
        ? `Community ${row.entity_type} record ${domain} has been pending review for ${ageHours}h `
          + 'and is not visible in the registry.'
        : `A live edit to ${row.entity_type} ${domain} has been waiting on a moderator for ${ageHours}h `
          + 'because the automated review could not resolve it.';

      violations.push({
        invariant: 'registry-review-queue-drained',
        severity: 'warning',
        subject_type: 'registry_record',
        subject_id: `${row.entity_type}:${domain}`,
        message: `${what} Registry review fails safe (adcp#8337), so a provider outage or a missing `
          + 'ANTHROPIC_API_KEY builds this backlog silently.',
        details: {
          kind: row.kind,
          entity_type: row.entity_type,
          domain,
          verdict: row.verdict,
          age_hours: ageHours,
          sla_hours: REGISTRY_REVIEW_SLA_HOURS,
          waiting_since: new Date(row.created_at).toISOString(),
        },
        remediation_hint:
          'Work the queue at /admin/registry-review. If the backlog is outage-driven, check '
          + 'ANTHROPIC_API_KEY and the Anthropic status page first — every item here is a '
          + 'submission the reviewer declined to decide, not a submission it rejected.',
      });
    }

    return { checked: stale.rows.length, violations };
  },
};
