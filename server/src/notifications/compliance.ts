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
import { query } from '../db/client.js';
import type { ComplianceStatus, TrackSummaryEntry } from '../db/compliance-db.js';
import type { SlackBlockMessage } from '../slack/types.js';

const logger = baseLogger.child({ module: 'compliance-notifications' });

const CHANNEL_ID = process.env.REGISTRY_EDITS_CHANNEL_ID;
const notificationDb = new NotificationDatabase();

interface ComplianceChangeInput {
  agentUrl: string;
  previousStatus: ComplianceStatus;
  currentStatus: ComplianceStatus;
  headline?: string;
  tracksJson: TrackSummaryEntry[];
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

/**
 * Extract a short agent name from the URL for display.
 */
function agentDisplayName(agentUrl: string): string {
  try {
    const url = new URL(agentUrl);
    return url.hostname;
  } catch {
    return agentUrl;
  }
}

/**
 * Format failing tracks for display.
 */
function formatFailingTracks(tracks: TrackSummaryEntry[]): string {
  return tracks
    .filter(t => t.status === 'fail' || t.status === 'partial')
    .map(t => `\`${t.track}\` (${t.status})`)
    .join(', ') || 'none';
}

/**
 * Send notifications when an agent's compliance status changes.
 * Called from the heartbeat job when a status transition is detected.
 */
export async function notifyComplianceChange(input: ComplianceChangeInput): Promise<void> {
  const { agentUrl, previousStatus, currentStatus, headline, tracksJson } = input;
  const name = agentDisplayName(agentUrl);

  const isRegression = previousStatus === 'passing' && (currentStatus === 'failing' || currentStatus === 'degraded');
  const isRecovery = (previousStatus === 'failing' || previousStatus === 'degraded') && currentStatus === 'passing';

  // Post to Slack channel (public — status only, no detailed failures)
  if (CHANNEL_ID && isSlackConfigured()) {
    try {
      if (isRegression) {
        const message: SlackBlockMessage = {
          text: `Agent compliance regression: ${name}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Agent compliance regression:* \`${name}\`\nStatus: ${previousStatus} → ${currentStatus}`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      } else if (isRecovery) {
        const message: SlackBlockMessage = {
          text: `Agent compliance recovered: ${name}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Agent compliance recovered:* \`${name}\` is passing all tracks again.`,
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
  if (userIds.length === 0) {
    logger.debug({ agentUrl }, 'No owner users found for compliance notification');
    return;
  }

  const agentPageUrl = `/registry?tab=agents`;

  for (const userId of userIds) {
    try {
      if (isRegression) {
        const alreadySent = await notificationDb.exists(userId, 'compliance_regression', agentUrl);
        if (alreadySent) continue;

        const failingInfo = formatFailingTracks(tracksJson);
        await notifyUser({
          recipientUserId: userId,
          type: 'compliance_regression',
          referenceId: agentUrl,
          referenceType: 'agent',
          title: `Your agent ${name} has compliance failures. Failing tracks: ${failingInfo}. ${headline || ''}`,
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
      const name = agentDisplayName(row.agent_url);
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
            title: `Your agent ${name} has been ${row.status} for ${days} days. Buyers are seeing failures.`,
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
