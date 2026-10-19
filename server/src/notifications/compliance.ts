/**
 * Notifications for agent compliance status changes.
 *
 * Posts to the registry Slack channel and DMs agent owners
 * when compliance status transitions (regressions, recoveries, extended outages).
 */

import { logger as baseLogger } from '../logger.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import { notifyUser } from './notification-service.js';
import { NotificationDatabase } from '../db/notification-db.js';
import { CatalogEventsDatabase } from '../db/catalog-events-db.js';
import { query } from '../db/client.js';
import { ComplianceDatabase, type ComplianceStatus, type TrackSummaryEntry, type StoryboardStatusEntry } from '../db/compliance-db.js';
import type { SlackBlockMessage } from '../slack/types.js';
import { flattenToSingleLine, sanitizeSlackLine } from '../utils/slack-escape.js';

const logger = baseLogger.child({ module: 'compliance-notifications' });

const CHANNEL_ID = process.env.REGISTRY_EDITS_CHANNEL_ID;
const notificationDb = new NotificationDatabase();
const eventsDb = new CatalogEventsDatabase();
const complianceDb = new ComplianceDatabase();

interface ComplianceChangeInput {
  agentUrl: string;
  previousStatus: ComplianceStatus;
  currentStatus: ComplianceStatus;
  headline?: string;
  tracksJson: TrackSummaryEntry[];
  storyboardStatuses?: StoryboardStatusEntry[];
}

/**
 * Find user IDs for the organization that owns an agent URL.
 * Looks up member_profiles where the agents JSONB contains the URL,
 * then finds org members to notify.
 */
async function resolveAgentOwnerUserIds(agentUrl: string): Promise<string[]> {
  try {
    const result = await query(
      `SELECT om.workos_user_id
       FROM member_profiles mp
       JOIN organization_memberships om
         ON om.workos_organization_id = mp.workos_organization_id
       WHERE mp.agents @> $1::jsonb
       LIMIT 5`,
      [JSON.stringify([{ url: agentUrl }])],
    );
    return result.rows.map((r: any) => r.workos_user_id);
  } catch (error) {
    logger.debug({ error, agentUrl }, 'Could not resolve agent owner');
    return [];
  }
}

async function isAgentPublic(agentUrl: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT 1 FROM member_profiles mp
       CROSS JOIN LATERAL jsonb_array_elements(mp.agents) agent
       WHERE agent->>'url' = $1 AND agent->>'visibility' = 'public'
       LIMIT 1`,
      [agentUrl],
    );
    return result.rowCount === 1;
  } catch {
    return false;
  }
}

// ── Trust boundary for agent-derived strings (adcp#8320) ─────────
//
// Everything this module says about an agent is downstream of that agent:
// the URL came from its owner, the compliance `headline` is derived from the
// agent's own error or response, and the badge role / specialisms / reason
// come from the capabilities it declared. All of it lands in a Slack DM the
// owner reads as platform-authored, and in a shared channel whose readers
// treat it as a moderator surface.
//
// The rule, enforced by `compliance-notification-sanitization.test.ts`
// (and written up for the rest of the repo in adcp#8331):
//
//   * A title (DM headline, channel `text` fallback, first block line) is a
//     fixed template plus *short, sanitized* identifiers — never free text.
//   * Free text an agent authored goes in the notification body, capped and
//     mrkdwn-escaped, where it reads as a quoted report rather than as our
//     own words.
//
// `notifyUser` escapes both halves again on the way into Slack; the explicit
// sanitizing here is what makes the channel path (which does not go through
// `notifyUser`) safe, and what keeps the stored in-app title bounded.

/** Identifiers inside a title: hostnames, badge roles, track lists. */
const TITLE_FIELD_MAX = 80;
/** Agent-authored free text in a body: headlines, revocation reasons. */
const DETAIL_MAX = 400;

/**
 * Extract a short agent name from the URL for display.
 *
 * Falls back to the raw URL when it does not parse — so the result is only
 * as trustworthy as whatever was registered, and every caller sanitizes it
 * before interpolation.
 */
function agentDisplayName(agentUrl: string): string {
  try {
    const url = new URL(agentUrl);
    return url.hostname;
  } catch {
    return agentUrl;
  }
}

// `label` / `detail` are for `notifyUser`, which escapes for mrkdwn on the
// Slack hop while the web list escapes for HTML — so they only flatten and
// bound. `channelLabel` / `channelDetail` are for the shared-channel
// messages this module builds itself, which bypass `notifyUser` and must
// therefore be escaped here.

/** Short identifier (agent hostname, badge role) for a notification title. */
function label(raw: string, fallback: string): string {
  return flattenToSingleLine(raw, TITLE_FIELD_MAX) || fallback;
}

/** Agent-authored free text for a notification body. */
function detail(raw: string): string {
  return flattenToSingleLine(raw, DETAIL_MAX);
}

function agentLabel(agentUrl: string): string {
  return label(agentDisplayName(agentUrl), 'unknown agent');
}

function channelLabel(raw: string, fallback: string): string {
  return sanitizeSlackLine(raw, TITLE_FIELD_MAX) || fallback;
}

function channelDetail(raw: string): string {
  return sanitizeSlackLine(raw, DETAIL_MAX);
}

/**
 * Failing tracks, for the notification body.
 *
 * Track ids come from our own compliance bundle rather than from the agent,
 * so this is a completeness rather than a trust concern: the list grows
 * with the bundle, so it lives in the body where it has room instead of in
 * the title, where it would be clipped as the bundle grows.
 */
function formatFailingTracks(tracks: TrackSummaryEntry[]): string {
  return tracks
    .filter(t => t.status === 'fail' || t.status === 'partial')
    .map(t => `${flattenToSingleLine(t.track, 40)} (${flattenToSingleLine(t.status, 16)})`)
    .join(', ');
}

/**
 * Send notifications when an agent's compliance status changes.
 * Called from the heartbeat job when a status transition is detected.
 */
export async function notifyComplianceChange(input: ComplianceChangeInput): Promise<void> {
  const { agentUrl, previousStatus, currentStatus, headline, tracksJson, storyboardStatuses } = input;
  const name = agentLabel(agentUrl);
  const channelName = channelLabel(agentDisplayName(agentUrl), 'unknown agent');

  const isRegression = previousStatus === 'passing' && (currentStatus === 'failing' || currentStatus === 'degraded');
  const isRecovery = (previousStatus === 'failing' || previousStatus === 'degraded') && currentStatus === 'passing';

  // Post to Slack channel (public — status only, no detailed failures)
  if (CHANNEL_ID && isSlackConfigured()) {
    try {
      if (isRegression) {
        const message: SlackBlockMessage = {
          text: `Agent compliance regression: ${channelName}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Agent compliance regression:* \`${channelName}\`\nStatus: ${previousStatus} → ${currentStatus}`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      } else if (isRecovery) {
        const message: SlackBlockMessage = {
          text: `Agent compliance recovered: ${channelName}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Agent compliance recovered:* \`${channelName}\` is passing all tracks again.`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      }
    } catch (error) {
      logger.error({ error, agentUrl }, 'Failed to send compliance channel notification');
    }
  }

  // DM the agent's owner (detailed — includes track failures)
  const userIds = await resolveAgentOwnerUserIds(agentUrl);
  if (userIds.length > 0) {
    const agentPageUrl = `/registry?tab=agents`;

    for (const userId of userIds) {
      try {
        if (isRegression) {
          const alreadySent = await notificationDb.exists(userId, 'compliance_regression', agentUrl);
          if (alreadySent) continue;

          const failingInfo = formatFailingTracks(tracksJson);
          const failingCount = tracksJson.filter(t => t.status === 'fail' || t.status === 'partial').length;
          // Everything variable-length moves to the body: the headline
          // because the agent wrote it (adcp#8320), the track list because
          // it grows with the compliance bundle and would be clipped out of
          // a title that also has to carry the hostname.
          const bodyParts = [
            failingInfo ? `Failing tracks: ${failingInfo}.` : '',
            headline ? `Reported: ${detail(headline)}` : '',
          ].filter(Boolean);
          await notifyUser({
            recipientUserId: userId,
            type: 'compliance_regression',
            referenceId: agentUrl,
            referenceType: 'agent',
            title: failingCount > 0
              ? `Your agent ${name} has compliance failures (${failingCount} failing ${failingCount === 1 ? 'track' : 'tracks'}).`
              : `Your agent ${name} has compliance failures.`,
            body: bodyParts.length > 0 ? bodyParts.join(' ') : undefined,
            url: agentPageUrl,
          });
        } else if (isRecovery) {
          await notifyUser({
            recipientUserId: userId,
            type: 'compliance_recovery',
            referenceId: agentUrl,
            referenceType: 'agent',
            title: `Your agent ${name} is passing all compliance tracks again.`,
            url: agentPageUrl,
          });
        }
      } catch (error) {
        logger.error({ error, userId, agentUrl }, 'Failed to send compliance DM');
      }
    }
  } else {
    logger.debug({ agentUrl }, 'No owner users found for compliance DM');
  }

  // Emit change feed event so external subscribers (e.g., Scope3) can react.
  // operator_domain is omitted — the feed requires auth but not membership,
  // and the agent-to-operator mapping is a business relationship members
  // can resolve via the operator lookup endpoint.
  try {
    const passingCount = storyboardStatuses?.filter(s => s.status === 'passing').length ?? 0;
    const totalCount = storyboardStatuses?.length ?? 0;

    await eventsDb.writeEvent({
      event_type: 'agent.compliance_changed',
      entity_type: 'agent',
      entity_id: agentUrl,
      payload: {
        agent_url: agentUrl,
        previous_status: previousStatus,
        current_status: currentStatus,
        headline: headline || null,
        tracks: Object.fromEntries(tracksJson.map(t => [t.track, t.status])),
        storyboards_passing: passingCount,
        storyboards_total: totalCount,
        storyboards: (storyboardStatuses ?? []).map(s => ({
          storyboard_id: s.storyboard_id,
          status: s.status,
          steps_passed: s.steps_passed,
          steps_total: s.steps_total,
        })),
      },
      actor: 'pipeline:compliance-heartbeat',
    });
  } catch (error) {
    logger.error({ error, agentUrl }, 'Failed to emit compliance change feed event');
  }
}

// ── Timed-out heartbeat notifications (adcp#8268) ────────────────

export interface ComplianceTimeoutInput {
  agentUrl: string;
  /** Pre-rendered by `describeHeartbeatTimeout` — runner-generated text only. */
  summary: string;
}

/**
 * Tell the agent's owners that a scheduled heartbeat ran out of budget and
 * therefore did not refresh the published result.
 *
 * Edge-triggered by the caller (only the first timeout of a streak), so this
 * deliberately does not use `notificationDb.exists` — that check is permanent
 * and would silence every later timeout after an agent recovers and regresses
 * again. Nothing is posted to the shared channel: an audit-only timeout is not
 * a public verdict change, and announcing slow agents in a shared room would
 * leak a trust signal the published grade does not carry.
 */
export async function notifyComplianceTimeout(input: ComplianceTimeoutInput): Promise<void> {
  const { agentUrl, summary } = input;
  const name = agentLabel(agentUrl);
  const userIds = await resolveAgentOwnerUserIds(agentUrl);
  if (userIds.length === 0) {
    logger.debug({ agentUrl }, 'No owner users found for compliance timeout DM');
    return;
  }

  for (const userId of userIds) {
    try {
      await notifyUser({
        recipientUserId: userId,
        type: 'compliance_heartbeat_timed_out',
        referenceId: agentUrl,
        referenceType: 'agent',
        title: `Compliance checks for your agent ${name} are not completing.`,
        // Runner-generated, but it still belongs in the body: the title is
        // a fixed template and the summary grows with the run (adcp#8320).
        body: detail(summary),
        url: '/registry?tab=agents',
      });
    } catch (error) {
      logger.error({ error, userId, agentUrl }, 'Failed to send compliance timeout DM');
    }
  }
}

// ── Verification Badge Notifications ─────────────────────────────

interface VerificationChangeInput {
  agentUrl: string;
  // adcp_version is optional for backward compat: callers from before
  // #3524 stage 2 (or any caller that genuinely doesn't know the
  // version) can omit it. When present, the notification text and the
  // change-feed payload include the version so two simultaneous
  // earnings at different versions don't render as duplicate identical
  // messages.
  issued: Array<{ role: string; specialisms: string[]; adcp_version?: string }>;
  revoked: Array<{ role: string; reason: string; adcp_version?: string }>;
  actor?: string;
  /** False when the caller persisted feed events transactionally. */
  emitFeedEvents?: boolean;
  /** False for non-public agents so shared channels cannot enumerate them. */
  notifyChannel?: boolean;
}

/**
 * Bounded like every other interpolated field even though the version comes
 * from our own hosted-target catalog rather than from the agent — it sits
 * beside sanitized values in the same templates, and a reader should not
 * have to know which of the two it is looking at. The channel loops build
 * their own escaped copy; this one feeds notification titles.
 */
function badgeQualifier(adcpVersion: string | undefined): string {
  return adcpVersion ? ` (AdCP ${label(adcpVersion, 'unknown version')})` : '';
}

/**
 * Send notifications when an agent's AAO Verified status changes.
 * Called from the heartbeat job after badge processing.
 */
export async function notifyVerificationChange(input: VerificationChangeInput): Promise<void> {
  const { agentUrl, issued, revoked } = input;
  const name = agentLabel(agentUrl);
  const channelName = channelLabel(agentDisplayName(agentUrl), 'unknown agent');
  const notifySharedChannel = input.notifyChannel ?? await isAgentPublic(agentUrl);

  // Post to Slack channel
  if (notifySharedChannel && CHANNEL_ID && isSlackConfigured()) {
    try {
      // Role, specialisms and revocation reason all trace back to what the
      // agent declared, so each one is bounded and escaped before it reaches
      // a channel the room treats as moderator-authored (adcp#8320).
      for (const badge of issued) {
        const versionTag = badge.adcp_version ? ` (AdCP ${channelLabel(badge.adcp_version, 'unknown version')})` : '';
        const role = channelLabel(badge.role, 'unknown role');
        const specialisms = channelDetail(badge.specialisms.join(', ')) || 'none';
        const message: SlackBlockMessage = {
          text: `AAO Verified: ${channelName} earned ${role}${versionTag} badge`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AAO Verified:* \`${channelName}\` is now a verified ${role} agent${versionTag}. Specialisms: ${specialisms}`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      }
      for (const badge of revoked) {
        const versionTag = badge.adcp_version ? ` (AdCP ${channelLabel(badge.adcp_version, 'unknown version')})` : '';
        const role = channelLabel(badge.role, 'unknown role');
        const reason = channelDetail(badge.reason);
        const message: SlackBlockMessage = {
          text: `AAO Verified revoked: ${channelName} lost ${role}${versionTag} badge`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AAO Verified revoked:* \`${channelName}\` lost its ${role}${versionTag} badge.${reason ? `\nReason: ${reason}` : ''}`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      }
    } catch (error) {
      logger.error({ error, agentUrl }, 'Failed to send verification channel notification');
    }
  }

  // DM the agent's owner
  const userIds = await resolveAgentOwnerUserIds(agentUrl);
  const agentPageUrl = `/registry?tab=agents`;

  for (const userId of userIds) {
    try {
      for (const badge of issued) {
        const versionTag = badgeQualifier(badge.adcp_version);
        await notifyUser({
          recipientUserId: userId,
          type: 'verification_earned',
          referenceId: agentUrl,
          referenceType: 'agent',
          title: `Your agent ${name} is now an AAO Verified ${label(badge.role, 'unknown role')} agent${versionTag}.`,
          url: agentPageUrl,
        });
      }
      for (const badge of revoked) {
        const versionTag = badgeQualifier(badge.adcp_version);
        await notifyUser({
          recipientUserId: userId,
          type: 'verification_lost',
          referenceId: agentUrl,
          referenceType: 'agent',
          title: `Your agent ${name} lost its AAO Verified ${label(badge.role, 'unknown role')}${versionTag} badge.`,
          // `reason` is free text about the agent's declared capabilities.
          body: badge.reason ? `Reason: ${detail(badge.reason)}` : undefined,
          url: agentPageUrl,
        });
      }
    } catch (error) {
      logger.error({ error, userId, agentUrl }, 'Failed to send verification DM');
    }
  }

  // Emit change feed events
  if (input.emitFeedEvents !== false) try {
    await complianceDb.publishVerificationChangeEventsIfCurrent(
      agentUrl,
      issued,
      revoked,
      input.actor ?? 'pipeline:compliance-heartbeat',
    );
  } catch (error) {
    logger.error({ error, agentUrl }, 'Failed to emit verification change feed event');
  }
}

/**
 * Send extended outage alerts for agents that have been failing for 7+ days.
 * Called separately from the heartbeat job (e.g., weekly check).
 */
export async function notifyExtendedOutages(): Promise<{ notified: number }> {
  let notified = 0;

  try {
    // Find production agents failing for 7+ days
    const result = await query(
      `SELECT s.agent_url, s.headline, s.status, s.status_changed_at
       FROM agent_compliance_status s
       LEFT JOIN agent_registry_metadata m ON m.agent_url = s.agent_url
       WHERE s.status IN ('failing', 'degraded')
         AND s.status_changed_at < NOW() - INTERVAL '7 days'
         AND COALESCE(m.lifecycle_stage, 'production') = 'production'
         AND COALESCE(m.compliance_opt_out, FALSE) = FALSE`,
    );

    for (const row of result.rows) {
      const userIds = await resolveAgentOwnerUserIds(row.agent_url);
      const name = agentLabel(row.agent_url);
      const days = Math.floor((Date.now() - new Date(row.status_changed_at).getTime()) / (1000 * 60 * 60 * 24));

      for (const userId of userIds) {
        try {
          const alreadySent = await notificationDb.exists(userId, 'compliance_extended_outage', row.agent_url);
          if (alreadySent) continue;

          await notifyUser({
            recipientUserId: userId,
            type: 'compliance_extended_outage',
            referenceId: row.agent_url,
            referenceType: 'agent',
            title: `Your agent ${name} has been ${label(String(row.status), 'failing')} for ${days} days. Buyers are seeing failures.`,
            url: '/registry?tab=agents',
          });
          notified++;
        } catch (error) {
          logger.error({ error, userId, agentUrl: row.agent_url }, 'Failed to send extended outage notification');
        }
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to check for extended outages');
  }

  return { notified };
}
