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
import { registryAgentUrlKeySpellings } from '../db/registry-agent-url-key.js';
import { ComplianceDatabase, type ComplianceStatus, type TrackSummaryEntry, type StoryboardStatusEntry } from '../db/compliance-db.js';
import type { SlackBlockMessage } from '../slack/types.js';

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
 * Find user IDs for the organizations that own an agent URL.
 * Looks up member_profiles whose `agents` JSONB holds ANY spelling of the
 * agent's registry identity, then finds org members to notify (#8321).
 *
 * The notifiers are handed the registry identity key, which folds a trailing
 * slash (#7830): `/mcp` and `/mcp/` are one agent. The owner's profile can
 * still hold the other spelling. Most writers key `agents[].url` before
 * storing it (`routes/member-agents.ts`, the member create/update paths in
 * `routes/member-profiles.ts`), but rows predate the fold and the admin
 * `PUT /api/admin/member-profiles/:id` handler still writes `agents` through
 * unkeyed (#8322) — so unfolded rows both exist and are still being created.
 * Matching the raw URL alone left those owners with no DM at all: compliance,
 * verification and the heartbeat-timeout notice each failed closed and
 * silently. Ownership resolution keys its input
 * (`services/agent-ownership.ts`); this keys both sides, since SQL may not
 * fold the stored one.
 *
 * `declared_url` is deliberately not consulted: it is the AUTHORIZATION
 * spelling (#7829) and must never decide identity.
 */
async function resolveAgentOwnerUserIds(agentUrl: string): Promise<string[]> {
  try {
    const spellings = registryAgentUrlKeySpellings(agentUrl);
    // The helper never returns an empty set; keep the invariant local so an
    // empty one could not assemble `WHERE  LIMIT 5` and be swallowed below.
    if (spellings.length === 0) return [];
    // One `@>` per spelling, OR'd, so the GIN index on member_profiles.agents
    // still serves the lookup. The clause is built from placeholder indexes
    // only — no caller-supplied text reaches the SQL text. Parenthesized so a
    // future `AND` cannot silently rebind against the `OR` and widen it.
    const containment = spellings
      .map((_, i) => `mp.agents @> $${i + 1}::jsonb`)
      .join(' OR ');
    // DISTINCT because two orgs can co-claim one agent and a user can belong
    // to both; ORDER BY because the cap below is otherwise planner-dependent,
    // and silently dropping the true owner for a co-claimant is the same
    // fail-quiet class this fix exists to close.
    const result = await query(
      `SELECT DISTINCT om.workos_user_id
       FROM member_profiles mp
       JOIN organization_memberships om
         ON om.workos_organization_id = mp.workos_organization_id
       WHERE (${containment})
       ORDER BY om.workos_user_id
       LIMIT 5`,
      spellings.map((spelling) => JSON.stringify([{ url: spelling }])),
    );
    return result.rows.map((r: any) => r.workos_user_id);
  } catch (error) {
    // Warn, not debug: the callers treat an empty result as "nobody owns this
    // agent", so a swallowed query failure is indistinguishable from a
    // correct silence — the same fail-quiet mode #8321 is about.
    logger.warn({ error, agentUrl }, 'Could not resolve agent owner');
    return [];
  }
}

/**
 * Whether any owner lists this agent publicly. Folds the stored spelling the
 * same way `resolveAgentOwnerUserIds` does: the shared-channel post names the
 * agent's hostname, and an agent its owner published as `/mcp/` is public
 * whichever spelling the heartbeat reports it under. Leaving this one raw
 * would suppress the post for exactly the agents the fix reaches.
 */
async function isAgentPublic(agentUrl: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT 1 FROM member_profiles mp
       CROSS JOIN LATERAL jsonb_array_elements(mp.agents) agent
       WHERE agent->>'url' = ANY($1::text[]) AND agent->>'visibility' = 'public'
       LIMIT 1`,
      [registryAgentUrlKeySpellings(agentUrl)],
    );
    return result.rowCount === 1;
  } catch {
    return false;
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
  const { agentUrl, previousStatus, currentStatus, headline, tracksJson, storyboardStatuses } = input;
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
  if (userIds.length > 0) {
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
  const name = agentDisplayName(agentUrl);
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
        title: `Compliance checks for your agent ${name} are not completing. ${summary}`,
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

function badgeQualifier(adcpVersion: string | undefined): string {
  return adcpVersion ? ` (AdCP ${adcpVersion})` : '';
}

/**
 * Send notifications when an agent's AAO Verified status changes.
 * Called from the heartbeat job after badge processing.
 */
export async function notifyVerificationChange(input: VerificationChangeInput): Promise<void> {
  const { agentUrl, issued, revoked } = input;
  const name = agentDisplayName(agentUrl);
  const notifySharedChannel = input.notifyChannel ?? await isAgentPublic(agentUrl);

  // Post to Slack channel
  if (notifySharedChannel && CHANNEL_ID && isSlackConfigured()) {
    try {
      for (const badge of issued) {
        const versionTag = badgeQualifier(badge.adcp_version);
        const message: SlackBlockMessage = {
          text: `AAO Verified: ${name} earned ${badge.role}${versionTag} badge`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AAO Verified:* \`${name}\` is now a verified ${badge.role} agent${versionTag}. Specialisms: ${badge.specialisms.join(', ')}`,
              },
            },
          ],
        };
        await sendChannelMessage(CHANNEL_ID, message);
      }
      for (const badge of revoked) {
        const versionTag = badgeQualifier(badge.adcp_version);
        const message: SlackBlockMessage = {
          text: `AAO Verified revoked: ${name} lost ${badge.role}${versionTag} badge`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AAO Verified revoked:* \`${name}\` lost its ${badge.role}${versionTag} badge. ${badge.reason}`,
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
          title: `Your agent ${name} is now an AAO Verified ${badge.role} agent${versionTag}.`,
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
          title: `Your agent ${name} lost its AAO Verified ${badge.role}${versionTag} badge. ${badge.reason}`,
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
