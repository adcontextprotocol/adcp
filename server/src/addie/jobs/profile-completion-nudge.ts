/**
 * Profile Completion Nudge Job
 *
 * Runs daily. Finds paying members whose member_profile is not public or whose
 * brand.json manifest is missing, and DMs the subscription owner on days 3, 7,
 * 14, and 30 after activation. Stops once the profile is announce-ready or the
 * member opts out.
 *
 * Eligibility is "≥ N days ago AND no prior nudge recorded for day N" so a
 * missed run catches up on the next day. Days are iterated highest-first and
 * each org gets at most one DM per run.
 */

import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { sendDirectMessage } from '../../slack/client.js';
import { SlackDatabase } from '../../db/slack-db.js';

const logger = createLogger('profile-completion-nudge');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

/** Days after subscription activation to send a nudge. */
export const NUDGE_DAYS = [3, 7, 14, 30] as const;

/** Cap DMs per run to prevent bursts. */
const MAX_NUDGES_PER_RUN = 25;

export type NudgeDay = typeof NUDGE_DAYS[number];

interface NudgeResult {
  orgsChecked: number;
  nudgesSent: number;
}

interface NudgeCandidate {
  workos_organization_id: string;
  org_name: string;
  membership_tier: string | null;
  agreement_signed_at: Date;
  is_public: boolean | null;
  primary_brand_domain: string | null;
  has_brand_manifest: boolean;
  subscription_created_by: string | null;
}

/**
 * Find orgs eligible for a nudge on a given day. An org is eligible when:
 *  - Subscription is active
 *  - agreement_signed_at is at least `day` days ago (12h slop on the boundary)
 *  - Member profile is not yet announce-ready (not public OR no brand.json manifest)
 *  - No prior profile_nudge_sent activity recorded for this same day
 */
export async function findCandidatesForDay(day: NudgeDay): Promise<NudgeCandidate[]> {
  const result = await query<NudgeCandidate>(
    `SELECT
        o.workos_organization_id,
        o.name AS org_name,
        o.membership_tier,
        o.agreement_signed_at,
        mp.is_public,
        mp.primary_brand_domain,
        (b.brand_manifest IS NOT NULL) AS has_brand_manifest,
        sub_act.logged_by_user_id AS subscription_created_by
      FROM organizations o
      LEFT JOIN member_profiles mp
        ON mp.workos_organization_id = o.workos_organization_id
      LEFT JOIN brands b
        ON mp.primary_brand_domain IS NOT NULL
       AND b.domain = LOWER(mp.primary_brand_domain)
       AND b.brand_manifest IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT logged_by_user_id
        FROM org_activities
        WHERE organization_id = o.workos_organization_id
          AND activity_type = 'subscription'
        ORDER BY activity_date DESC
        LIMIT 1
      ) sub_act ON TRUE
      WHERE o.subscription_status = 'active'
        AND o.agreement_signed_at IS NOT NULL
        AND o.agreement_signed_at <= NOW() - make_interval(hours => $1 * 24 - 12)
        AND (mp.is_public IS NOT TRUE OR b.brand_manifest IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM org_activities oa
          WHERE oa.organization_id = o.workos_organization_id
            AND oa.activity_type = 'profile_nudge_sent'
            AND oa.metadata->>'nudge_day' = $2
        )
      ORDER BY o.agreement_signed_at ASC`,
    [day, String(day)]
  );

  return result.rows;
}

/**
 * Pick a first-name greeting from a Slack mapping. Exported for testing.
 */
export function extractFirstName(realName: string | null, displayName: string | null): string {
  const source = (realName || displayName || '').trim();
  if (!source) return 'there';
  const first = source.split(/\s+/)[0];
  return first || 'there';
}

/**
 * Compose the DM body based on what the member is missing.
 * Exported for unit testing.
 */
export function composeNudgeMessage(args: {
  firstName: string;
  day: NudgeDay;
  hasPublicProfile: boolean;
  hasBrandManifest: boolean;
  primaryBrandDomain: string | null;
  orgName: string;
}): string {
  const { firstName, day, hasPublicProfile, hasBrandManifest, primaryBrandDomain, orgName } = args;
  const greeting = `Hi ${firstName} --`;
  const profileUrl = `${APP_URL}/me/profile`;
  const finalNudge = day === 30;

  const sorry = finalNudge
    ? ` This is the last nudge from me on this -- if the timing's wrong, reply and I'll stop.`
    : '';

  if (!hasPublicProfile && !hasBrandManifest) {
    return (
      `${greeting} welcome to AAO! To get ${orgName} listed in the directory and announced to the community, there are two quick steps left:\n\n` +
      `• Publish your profile (tagline, primary domain, mark it public)\n` +
      `• Publish at least one agent to your brand.json\n\n` +
      `Both are in the same editor: <${profileUrl}|${profileUrl}>.${sorry}`
    );
  }

  if (!hasPublicProfile) {
    return (
      `${greeting} your brand.json is set up -- nice. Last step to get ${orgName} announced: publish your AAO profile (tagline + mark it public) at <${profileUrl}|${profileUrl}>.${sorry}`
    );
  }

  // hasPublicProfile && !hasBrandManifest
  const domainHint = primaryBrandDomain
    ? ` for ${primaryBrandDomain}`
    : ' (set your primary brand domain first)';
  return (
    `${greeting} your AAO profile looks great. One last step before we announce ${orgName}: publish at least one agent to your brand.json${domainHint}. Editor: <${profileUrl}|${profileUrl}>.${sorry}`
  );
}

/**
 * Record that a nudge was sent, for idempotency.
 */
async function recordNudgeSent(orgId: string, day: NudgeDay, slackUserId: string): Promise<void> {
  await query(
    `INSERT INTO org_activities (
        organization_id, activity_type, description, metadata, activity_date
     ) VALUES ($1, 'profile_nudge_sent', $2, $3::jsonb, NOW())`,
    [
      orgId,
      `Profile completion nudge (day ${day})`,
      JSON.stringify({ nudge_day: day, slack_user_id: slackUserId }),
    ]
  );
}

export async function runProfileCompletionNudgeJob(): Promise<NudgeResult> {
  const result: NudgeResult = { orgsChecked: 0, nudgesSent: 0 };
  const slackDb = new SlackDatabase();
  const nudgedThisRun = new Set<string>();

  // Iterate highest-day first so an org that's overdue gets the latest-stage
  // message (not day 3) and receives at most one DM per run.
  const daysDesc = [...NUDGE_DAYS].sort((a, b) => b - a) as NudgeDay[];

  for (const day of daysDesc) {
    let candidates: NudgeCandidate[];
    try {
      candidates = await findCandidatesForDay(day);
    } catch (err) {
      logger.error({ err, day }, 'Failed to load nudge candidates');
      continue;
    }

    result.orgsChecked += candidates.length;

    for (const candidate of candidates) {
      if (nudgedThisRun.has(candidate.workos_organization_id)) continue;

      if (result.nudgesSent >= MAX_NUDGES_PER_RUN) {
        logger.info({ nudgesSent: result.nudgesSent }, 'Hit nudge cap, deferring remaining');
        return result;
      }

      if (!candidate.subscription_created_by) {
        logger.debug(
          { orgId: candidate.workos_organization_id, day },
          'No subscription creator recorded — cannot DM'
        );
        continue;
      }

      const mapping = await slackDb.getByWorkosUserId(candidate.subscription_created_by);
      if (!mapping?.slack_user_id) {
        logger.debug(
          { orgId: candidate.workos_organization_id, day, workosUserId: candidate.subscription_created_by },
          'Subscription creator has no Slack mapping — skipping'
        );
        continue;
      }

      if (mapping.nudge_opt_out) {
        logger.debug(
          { orgId: candidate.workos_organization_id, day, slackUserId: mapping.slack_user_id },
          'Subscription creator opted out of nudges — skipping'
        );
        continue;
      }

      const firstName = extractFirstName(mapping.slack_real_name, mapping.slack_display_name);

      const message = composeNudgeMessage({
        firstName,
        day,
        hasPublicProfile: candidate.is_public === true,
        hasBrandManifest: candidate.has_brand_manifest === true,
        primaryBrandDomain: candidate.primary_brand_domain,
        orgName: candidate.org_name,
      });

      try {
        await sendDirectMessage(mapping.slack_user_id, { text: message });
      } catch (err) {
        logger.warn(
          { err, orgId: candidate.workos_organization_id, day },
          'Failed to send profile completion nudge'
        );
        continue;
      }

      nudgedThisRun.add(candidate.workos_organization_id);
      result.nudgesSent++;
      logger.info(
        { orgId: candidate.workos_organization_id, day, slackUserId: mapping.slack_user_id },
        'Sent profile completion nudge'
      );

      // DM already sent; if the idempotency insert fails we log and move on.
      // A duplicate DM on the next run is preferable to aborting the queue.
      try {
        await recordNudgeSent(candidate.workos_organization_id, day, mapping.slack_user_id);
      } catch (err) {
        logger.error(
          { err, orgId: candidate.workos_organization_id, day },
          'Sent nudge but failed to record idempotency activity'
        );
      }
    }
  }

  return result;
}
