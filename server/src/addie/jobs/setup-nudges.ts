/**
 * Setup Nudges Job
 *
 * Sends proactive DMs to members about incomplete setup items:
 * - Missing company logo (members only)
 * - Missing company tagline (members only)
 * - Pending join requests (org admins only)
 *
 * Runs periodically to remind users about setup tasks.
 * Uses rate limiting to avoid spam (once per 7 days per user per nudge type).
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';

/** Don't re-nudge same user for same issue within this interval */
const NUDGE_INTERVAL = '7 days';

/** Delay between Slack messages to avoid rate limits */
const MESSAGE_DELAY_MS = 2000;

type NudgeType = 'missing_logo' | 'missing_tagline' | 'pending_join_requests';

interface SetupNudge {
  slack_user_id: string;
  workos_user_id: string;
  user_name: string | null;
  org_id: string;
  org_name: string;
  nudge_type: NudgeType;
  nudge_detail?: string; // e.g., count of pending requests
}

interface NudgeResult {
  nudgesChecked: number;
  nudgesSent: number;
  skipped: number;
  errors: number;
}

/**
 * Get members missing logos who haven't been nudged recently
 */
async function getMembersWithMissingLogos(): Promise<SetupNudge[]> {
  const result = await query<SetupNudge>(
    `SELECT
      sm.slack_user_id,
      sm.workos_user_id,
      COALESCE(sm.slack_display_name, sm.slack_real_name) as user_name,
      o.workos_organization_id as org_id,
      o.name as org_name,
      'missing_logo'::text as nudge_type
    FROM member_profiles mp
    JOIN organizations o ON o.workos_organization_id = mp.workos_organization_id
    JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
    JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
    WHERE o.subscription_status = 'active'
      AND (mp.logo_url IS NULL OR mp.logo_url = '')
      AND sm.slack_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM setup_nudge_log snl
        WHERE snl.slack_user_id = sm.slack_user_id
          AND snl.nudge_type = 'missing_logo'
          AND snl.sent_at > NOW() - INTERVAL '7 days'
      )
    ORDER BY o.created_at ASC
    LIMIT 20`
  );
  return result.rows;
}

/**
 * Get members missing taglines who haven't been nudged recently
 */
async function getMembersWithMissingTaglines(): Promise<SetupNudge[]> {
  const result = await query<SetupNudge>(
    `SELECT
      sm.slack_user_id,
      sm.workos_user_id,
      COALESCE(sm.slack_display_name, sm.slack_real_name) as user_name,
      o.workos_organization_id as org_id,
      o.name as org_name,
      'missing_tagline'::text as nudge_type
    FROM member_profiles mp
    JOIN organizations o ON o.workos_organization_id = mp.workos_organization_id
    JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
    JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
    WHERE o.subscription_status = 'active'
      AND (mp.tagline IS NULL OR mp.tagline = '')
      AND sm.slack_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM setup_nudge_log snl
        WHERE snl.slack_user_id = sm.slack_user_id
          AND snl.nudge_type = 'missing_tagline'
          AND snl.sent_at > NOW() - INTERVAL '7 days'
      )
    ORDER BY o.created_at ASC
    LIMIT 20`
  );
  return result.rows;
}

/**
 * Get org admins with pending join requests who haven't been nudged recently
 */
async function getAdminsWithPendingRequests(): Promise<SetupNudge[]> {
  const result = await query<SetupNudge & { pending_count: string }>(
    `SELECT
      sm.slack_user_id,
      sm.workos_user_id,
      COALESCE(sm.slack_display_name, sm.slack_real_name) as user_name,
      o.workos_organization_id as org_id,
      o.name as org_name,
      'pending_join_requests'::text as nudge_type,
      COUNT(jr.id)::text as pending_count
    FROM organization_join_requests jr
    JOIN organizations o ON o.workos_organization_id = jr.workos_organization_id
    JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
    JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
    WHERE jr.status = 'pending'
      AND om.role IN ('admin', 'owner')
      AND sm.slack_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM setup_nudge_log snl
        WHERE snl.slack_user_id = sm.slack_user_id
          AND snl.nudge_type = 'pending_join_requests'
          AND snl.sent_at > NOW() - INTERVAL '7 days'
      )
    GROUP BY sm.slack_user_id, sm.workos_user_id, sm.slack_display_name, sm.slack_real_name,
             o.workos_organization_id, o.name
    HAVING COUNT(jr.id) > 0
    ORDER BY COUNT(jr.id) DESC
    LIMIT 20`
  );

  return result.rows.map(r => ({
    ...r,
    nudge_detail: r.pending_count,
  }));
}

/**
 * Build a nudge message based on type
 */
function buildNudgeMessage(nudge: SetupNudge): string {
  const name = nudge.user_name || 'there';

  switch (nudge.nudge_type) {
    case 'missing_logo':
      return [
        `Hi ${name}! Just a friendly reminder that your organization doesn't have a logo set up yet.`,
        '',
        `Adding a logo helps *${nudge.org_name}* stand out in the member directory and on our homepage.`,
        '',
        `You can add one at: https://agenticadvertising.org/dashboard-settings`,
        '',
        `_Let me know if you need help uploading your logo!_`,
      ].join('\n');

    case 'missing_tagline':
      return [
        `Hi ${name}! I noticed *${nudge.org_name}* doesn't have a company description yet.`,
        '',
        `Adding a tagline helps other members learn what your company does and makes it easier to find collaboration opportunities.`,
        '',
        `You can add one at: https://agenticadvertising.org/dashboard-settings`,
        '',
        `_Feel free to ask if you need help crafting your description!_`,
      ].join('\n');

    case 'pending_join_requests': {
      const count = parseInt(nudge.nudge_detail || '1', 10);
      const people = count === 1 ? 'person is' : 'people are';
      return [
        `Hi ${name}! ${count} ${people} waiting to join *${nudge.org_name}*.`,
        '',
        `As an admin, you can review and approve their requests at: https://agenticadvertising.org/dashboard#team`,
        '',
        `_Let me know if you have any questions about managing your team!_`,
      ].join('\n');
    }

    default:
      return '';
  }
}

/**
 * Send a nudge DM via Slack
 */
async function sendNudgeDm(slackUserId: string, message: string): Promise<boolean> {
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.warn('ADDIE_BOT_TOKEN not configured - cannot send setup nudges');
    return false;
  }

  try {
    // Open DM channel
    const openResponse = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users: slackUserId }),
    });

    const openData = (await openResponse.json()) as { ok: boolean; channel?: { id: string }; error?: string };
    if (!openData.ok || !openData.channel?.id) {
      logger.warn({ error: openData.error, slackUserId }, 'Failed to open DM channel for nudge');
      return false;
    }

    // Send message
    const sendResponse = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: openData.channel.id,
        text: message,
        mrkdwn: true,
      }),
    });

    const sendData = (await sendResponse.json()) as { ok: boolean; error?: string };
    if (!sendData.ok) {
      logger.warn({ error: sendData.error, slackUserId }, 'Failed to send nudge message');
      return false;
    }

    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error sending nudge DM');
    return false;
  }
}

/**
 * Log that a nudge was sent
 */
async function logNudgeSent(slackUserId: string, nudgeType: NudgeType): Promise<void> {
  await query(
    `INSERT INTO setup_nudge_log (slack_user_id, nudge_type, sent_at)
     VALUES ($1, $2, NOW())`,
    [slackUserId, nudgeType]
  );
}

/**
 * Run the setup nudges job
 */
export async function runSetupNudgesJob(options: {
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<NudgeResult> {
  const { dryRun = false, limit = 10 } = options;

  logger.debug({ dryRun, limit }, 'Running setup nudges job');

  // Gather all nudges
  const [missingLogos, missingTaglines, pendingRequests] = await Promise.all([
    getMembersWithMissingLogos(),
    getMembersWithMissingTaglines(),
    getAdminsWithPendingRequests(),
  ]);

  // Combine and limit - prioritize pending requests, then logos, then taglines
  const allNudges = [
    ...pendingRequests,
    ...missingLogos,
    ...missingTaglines,
  ].slice(0, limit);

  let nudgesSent = 0;
  let skipped = 0;
  let errors = 0;

  for (const nudge of allNudges) {
    const message = buildNudgeMessage(nudge);
    if (!message) {
      skipped++;
      continue;
    }

    if (dryRun) {
      logger.info({
        slackUserId: nudge.slack_user_id,
        nudgeType: nudge.nudge_type,
        orgName: nudge.org_name,
        message: message.substring(0, 100) + '...',
      }, 'DRY RUN: Would send setup nudge');
      nudgesSent++;
      continue;
    }

    const success = await sendNudgeDm(nudge.slack_user_id, message);
    if (success) {
      await logNudgeSent(nudge.slack_user_id, nudge.nudge_type);
      logger.debug({
        slackUserId: nudge.slack_user_id,
        nudgeType: nudge.nudge_type,
        orgName: nudge.org_name,
      }, 'Sent setup nudge');
      nudgesSent++;
    } else {
      errors++;
    }

    // Rate limit delay between Slack messages
    await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY_MS));
  }

  if (nudgesSent > 0 || errors > 0) {
    logger.info({
      nudgesChecked: allNudges.length,
      nudgesSent,
      skipped,
      errors,
    }, 'Setup nudges job completed');
  }

  return {
    nudgesChecked: allNudges.length,
    nudgesSent,
    skipped,
    errors,
  };
}

/**
 * Preview what nudges would be sent (dry run)
 */
export async function previewSetupNudges(): Promise<SetupNudge[]> {
  const [missingLogos, missingTaglines, pendingRequests] = await Promise.all([
    getMembersWithMissingLogos(),
    getMembersWithMissingTaglines(),
    getAdminsWithPendingRequests(),
  ]);

  return [...pendingRequests, ...missingLogos, ...missingTaglines];
}
