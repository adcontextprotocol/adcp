/**
 * Proactive Outreach Service
 *
 * Manages proactive outreach to Slack users via DMs.
 * Uses the OutboundPlanner for intelligent goal selection.
 * Handles eligibility checking, rate limiting, and business hours.
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import {
  assignUserStakeholder,
  createActionItem,
} from '../../db/account-management-db.js';
import * as outboundDb from '../../db/outbound-db.js';
import { getOutboundPlanner } from './outbound-planner.js';
import { getThreadService } from '../thread-service.js';
import type { PlannerContext, PlannedAction } from '../types.js';
import type { SlackUserMapping } from '../../slack/types.js';

const insightsDb = new InsightsDatabase();

// Outreach is always live - rate limiting and business hours provide safety
const OUTREACH_MODE = 'live' as const;

// Emergency kill switch - set OUTREACH_ENABLED=false to disable all outreach
const OUTREACH_ENABLED = process.env.OUTREACH_ENABLED !== 'false';

// Configuration
const RATE_LIMIT_DAYS = 7; // Don't contact same user more than once per week
const BUSINESS_HOURS_START = 9; // 9 AM
const BUSINESS_HOURS_END = 17; // 5 PM
const THREAD_CONTINUATION_WINDOW_MINUTES = 7 * 24 * 60; // Continue existing threads within 7 days

/**
 * Outreach candidate with eligibility info
 */
interface OutreachCandidate {
  slack_user_id: string;
  slack_email: string | null;
  slack_display_name: string | null;
  slack_real_name: string | null;
  workos_user_id: string | null;
  last_outreach_at: Date | null;
  slack_tz_offset: number | null;
  priority: number;
}

/**
 * Outreach type determines what message to send
 */
type OutreachType = 'account_link' | 'introduction' | 'insight_goal' | 'custom';

/**
 * Result of sending outreach
 */
interface OutreachResult {
  success: boolean;
  outreach_id?: number;
  dm_channel_id?: string;
  error?: string;
}

/**
 * Check if current time is within business hours (9am-5pm weekdays)
 * Uses user's timezone if provided, otherwise defaults to ET
 *
 * @param tzOffsetSeconds - Slack timezone offset in seconds from UTC (e.g., -18000 for ET)
 */
export function isBusinessHours(tzOffsetSeconds?: number | null): boolean {
  const now = new Date();

  // Slack provides tz_offset in seconds, convert to hours
  // If no timezone provided, default to Eastern Time
  let offsetHours: number;
  if (tzOffsetSeconds != null) {
    offsetHours = tzOffsetSeconds / 3600;
  } else {
    // Fall back to ET (handle DST)
    offsetHours = -getEasternTimezoneOffset(now);
  }

  // Calculate user's local hour
  // offsetHours is negative for west of UTC (e.g., -5 for ET)
  const userLocalHour = (now.getUTCHours() + offsetHours + 24) % 24;

  // Get day of week in user's timezone
  const utcTimestamp = now.getTime();
  const userLocalTimestamp = utcTimestamp + offsetHours * 3600 * 1000;
  const userLocalDate = new Date(userLocalTimestamp);
  const day = userLocalDate.getUTCDay();

  // Weekend check
  if (day === 0 || day === 6) {
    return false;
  }

  // Business hours check (9am-5pm in user's timezone)
  return userLocalHour >= BUSINESS_HOURS_START && userLocalHour < BUSINESS_HOURS_END;
}

/**
 * Get Eastern timezone offset (handles DST)
 * Returns positive number (hours behind UTC)
 */
function getEasternTimezoneOffset(date: Date): number {
  // ET is UTC-5 (EST) or UTC-4 (EDT)
  // DST in US: Second Sunday of March to First Sunday of November
  const year = date.getUTCFullYear();
  const marchSecondSunday = getNthSunday(year, 2, 2); // March, 2nd Sunday
  const novFirstSunday = getNthSunday(year, 10, 1); // November, 1st Sunday

  const isDST = date >= marchSecondSunday && date < novFirstSunday;
  return isDST ? 4 : 5;
}

/**
 * Get nth Sunday of a month
 */
function getNthSunday(year: number, month: number, n: number): Date {
  const firstDay = new Date(Date.UTC(year, month, 1));
  const daysUntilSunday = (7 - firstDay.getUTCDay()) % 7;
  const nthSunday = new Date(Date.UTC(year, month, 1 + daysUntilSunday + (n - 1) * 7, 2, 0, 0));
  return nthSunday;
}

/**
 * Check if a user is eligible for outreach
 */
function isUserEligible(user: SlackUserMapping): boolean {
  // Bots and deleted users are not eligible
  if (user.slack_is_bot || user.slack_is_deleted) {
    return false;
  }

  // Opted-out users are not eligible
  if (user.outreach_opt_out) {
    return false;
  }

  // Rate limiting: check if contacted within the last week
  if (user.last_outreach_at) {
    const daysSince = (Date.now() - new Date(user.last_outreach_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < RATE_LIMIT_DAYS) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate outreach priority for a user
 * Higher priority = more likely to be contacted first
 */
function calculatePriority(user: SlackUserMapping): number {
  let priority = 0;

  // Unmapped users get highest priority
  if (!user.workos_user_id) {
    priority += 100;
  }

  // Never contacted = high priority
  if (!user.last_outreach_at) {
    priority += 50;
  } else {
    // Longer since last contact = higher priority
    const daysSince = (Date.now() - new Date(user.last_outreach_at).getTime()) / (1000 * 60 * 60 * 24);
    priority += Math.min(daysSince, 30); // Cap at 30 days
  }

  return priority;
}

/**
 * Build PlannerContext from a candidate for the OutboundPlanner
 */
async function buildPlannerContext(candidate: OutreachCandidate): Promise<PlannerContext> {
  // Get insights, history, and capabilities in parallel
  const [insights, history, capabilities, contactEligibility] = await Promise.all([
    insightsDb.getInsightsForUser(candidate.slack_user_id),
    outboundDb.getUserGoalHistory(candidate.slack_user_id),
    outboundDb.getMemberCapabilities(candidate.slack_user_id, candidate.workos_user_id ?? undefined),
    canContactUser(candidate.slack_user_id),
  ]);

  // Get company info and membership status if user is mapped
  let company: PlannerContext['company'] | undefined;
  let isMember = false;
  let isAddieProspect = false;
  if (candidate.workos_user_id) {
    const orgResult = await query<{
      name: string;
      company_types: string[] | null;
      subscription_status: string | null;
      persona: string | null;
      prospect_owner: string | null;
    }>(
      `SELECT o.name, o.company_types, o.subscription_status, o.persona, o.prospect_owner
       FROM organization_memberships om
       JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
       WHERE om.workos_user_id = $1
       LIMIT 1`,
      [candidate.workos_user_id]
    );
    if (orgResult.rows[0]) {
      const org = orgResult.rows[0];
      const isPersonalWorkspace = org.name.toLowerCase().endsWith("'s workspace") ||
                                  org.name.toLowerCase().endsWith("'s workspace");
      company = {
        name: isPersonalWorkspace ? 'your account' : org.name,
        type: org.company_types?.[0] ?? 'unknown',
        is_personal_workspace: isPersonalWorkspace,
        persona: org.persona ?? undefined,
      };
      isMember = org.subscription_status === 'active';
      isAddieProspect = org.prospect_owner === 'addie';
    }
  }

  // For unmapped users, check if their email domain matches an Addie-owned prospect
  if (!company && candidate.slack_email) {
    const domain = candidate.slack_email.split('@')[1];
    if (domain) {
      const prospectResult = await query<{
        name: string;
        company_types: string[] | null;
        prospect_owner: string | null;
        persona: string | null;
      }>(
        `SELECT o.name, o.company_types, o.prospect_owner, o.persona
         FROM organizations o
         WHERE (o.email_domain = $1 OR o.workos_organization_id IN (
           SELECT workos_organization_id FROM organization_domains WHERE domain = $1
         ))
         AND o.subscription_status IS NULL
         LIMIT 1`,
        [domain]
      );
      if (prospectResult.rows[0]) {
        const org = prospectResult.rows[0];
        company = {
          name: org.name,
          type: org.company_types?.[0] ?? 'unknown',
          is_personal_workspace: false,
          persona: org.persona ?? undefined,
        };
        isAddieProspect = org.prospect_owner === 'addie';
      }
    }
  }

  // Calculate engagement score based on capabilities
  const engagementScore = capabilities.slack_message_count_30d > 0
    ? Math.min(100, capabilities.slack_message_count_30d * 5)
    : 0;

  return {
    user: {
      slack_user_id: candidate.slack_user_id,
      workos_user_id: candidate.workos_user_id ?? undefined,
      display_name: candidate.slack_display_name ?? candidate.slack_real_name ?? undefined,
      is_mapped: !!candidate.workos_user_id,
      is_member: isMember,
      engagement_score: engagementScore,
      insights: insights.map(i => ({
        type: i.insight_type_name ?? 'unknown',
        value: i.value,
        confidence: i.confidence,
      })),
    },
    company: company ? { ...company, is_addie_prospect: isAddieProspect } : undefined,
    capabilities,
    history,
    contact_eligibility: {
      can_contact: contactEligibility.canContact,
      reason: contactEligibility.reason ?? 'Eligible',
    },
  };
}

/**
 * Get eligible candidates for outreach
 */
async function getEligibleCandidates(limit = 10): Promise<OutreachCandidate[]> {
  const result = await query<SlackUserMapping & { priority?: number }>(
    `SELECT *
     FROM slack_user_mappings
     WHERE slack_is_bot = FALSE
       AND slack_is_deleted = FALSE
       AND outreach_opt_out = FALSE
       AND (last_outreach_at IS NULL OR last_outreach_at < NOW() - INTERVAL '${RATE_LIMIT_DAYS} days')
     ORDER BY
       CASE WHEN workos_user_id IS NULL THEN 0 ELSE 1 END,
       last_outreach_at NULLS FIRST
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(user => ({
    ...user,
    priority: calculatePriority(user),
  }));
}

/**
 * Open a DM channel with a user using Addie's bot token
 */
async function openDmChannel(slackUserId: string): Promise<string | null> {
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.error('ADDIE_BOT_TOKEN not configured');
    return null;
  }

  try {
    const response = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ users: slackUserId }),
    });

    const data = (await response.json()) as { ok: boolean; channel?: { id: string }; error?: string };
    if (!data.ok) {
      logger.error({ error: data.error, slackUserId }, 'Failed to open DM channel');
      return null;
    }

    return data.channel?.id || null;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error opening DM channel');
    return null;
  }
}

/**
 * Send a message to a DM channel using Addie's bot token
 * If threadTs is provided, replies in that thread instead of starting a new message
 */
async function sendDmMessage(channelId: string, text: string, threadTs?: string): Promise<string | null> {
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.error('ADDIE_BOT_TOKEN not configured');
    return null;
  }

  try {
    const body: { channel: string; text: string; thread_ts?: string } = {
      channel: channelId,
      text,
    };
    if (threadTs) {
      body.thread_ts = threadTs;
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      logger.error({ error: data.error, channelId, threadTs }, 'Failed to send DM message');
      return null;
    }

    return data.ts || null;
  } catch (error) {
    logger.error({ error, channelId }, 'Error sending DM message');
    return null;
  }
}

/**
 * Update user's last_outreach_at timestamp
 */
async function updateLastOutreach(slackUserId: string): Promise<void> {
  await query(
    `UPDATE slack_user_mappings SET last_outreach_at = NOW(), updated_at = NOW() WHERE slack_user_id = $1`,
    [slackUserId]
  );
}

/**
 * Result of resolving thread and sending message
 */
type ThreadSendResult = {
  success: true;
  channelId: string;
  threadTs?: string;
  messageTs: string;
} | {
  success: false;
  error: string;
}

/**
 * Resolve existing thread (if any) and send a message
 * Continues existing threads within THREAD_CONTINUATION_WINDOW_MINUTES
 */
async function resolveThreadAndSendMessage(
  slackUserId: string,
  message: string
): Promise<ThreadSendResult> {
  const threadService = getThreadService();
  const recentThread = await threadService.getUserRecentThread(slackUserId, 'slack', THREAD_CONTINUATION_WINDOW_MINUTES);

  let channelId: string;
  let threadTs: string | undefined;

  if (recentThread?.external_id) {
    // Try to continue existing thread
    const [existingChannelId, existingThreadTs] = recentThread.external_id.split(':');
    if (existingChannelId && existingThreadTs) {
      channelId = existingChannelId;
      threadTs = existingThreadTs;
      const messageTs = await sendDmMessage(channelId, message, threadTs);
      if (messageTs) {
        logger.debug({ slackUserId, threadTs }, 'Continuing existing thread for outreach');
        return { success: true, channelId, threadTs, messageTs };
      }
      // If message failed in existing thread, fall through to open new channel
      logger.warn({ slackUserId, external_id: recentThread.external_id }, 'Failed to send to existing thread, opening new channel');
    } else {
      logger.warn({ slackUserId, external_id: recentThread.external_id }, 'Invalid external_id format in recent thread');
    }
  }

  // No recent thread or failed to send, start new conversation
  const newChannelId = await openDmChannel(slackUserId);
  if (!newChannelId) {
    return { success: false, error: 'Failed to open DM channel' };
  }
  channelId = newChannelId;

  const messageTs = await sendDmMessage(channelId, message);
  if (!messageTs) {
    return { success: false, error: 'Failed to send DM message' };
  }

  return { success: true, channelId, messageTs };
}

/**
 * Initiate outreach using the OutboundPlanner for intelligent goal selection
 */
async function initiateOutreachWithPlanner(candidate: OutreachCandidate): Promise<OutreachResult> {
  const planner = getOutboundPlanner();

  // Build context for the planner
  const ctx = await buildPlannerContext(candidate);

  // Let the planner decide what goal to pursue
  const plannedAction = await planner.planNextAction(ctx);

  if (!plannedAction) {
    logger.debug({
      slack_user_id: candidate.slack_user_id,
    }, 'No suitable goal found for candidate');
    return { success: false, error: 'No suitable goal found' };
  }

  // Build the message from the goal template
  const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(candidate.slack_user_id)}`;
  const message = planner.buildMessage(plannedAction.goal, ctx, linkUrl);

  // Send message, continuing existing thread if one exists
  const sendResult = await resolveThreadAndSendMessage(candidate.slack_user_id, message);
  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  const { channelId, messageTs } = sendResult;

  // Map goal category to outreach type
  const outreachType: OutreachType = plannedAction.goal.category === 'admin' ? 'account_link'
    : plannedAction.goal.category === 'information' ? 'insight_goal'
    : 'custom';

  // Record outreach in member_outreach (legacy tracking)
  const outreach = await insightsDb.recordOutreach({
    slack_user_id: candidate.slack_user_id,
    outreach_type: outreachType,
    dm_channel_id: channelId,
    initial_message: message,
  });

  // Record goal attempt in user_goal_history (new planner tracking)
  await outboundDb.recordGoalAttempt({
    slack_user_id: candidate.slack_user_id,
    goal_id: plannedAction.goal.id,
    planner_reason: plannedAction.reason,
    planner_score: plannedAction.priority_score,
    decision_method: plannedAction.decision_method,
    outreach_id: outreach.id,
  });

  // Update user's last_outreach_at
  await updateLastOutreach(candidate.slack_user_id);

  logger.debug({
    outreachId: outreach.id,
    slackUserId: candidate.slack_user_id,
    goalId: plannedAction.goal.id,
    goalName: plannedAction.goal.name,
    reason: plannedAction.reason,
    decision_method: plannedAction.decision_method,
  }, 'Sent planner-based outreach');

  return {
    success: true,
    outreach_id: outreach.id,
    dm_channel_id: channelId,
  };
}

/**
 * Run the outreach scheduler
 * Called periodically (e.g., every 30 minutes) by background job
 */
export async function runOutreachScheduler(options: {
  limit?: number;
  forceRun?: boolean;
} = {}): Promise<{
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
}> {
  const limit = options.limit ?? 5;

  // Check kill switch
  if (!OUTREACH_ENABLED) {
    logger.info('Outreach scheduler: Disabled via OUTREACH_ENABLED=false');
    return { processed: 0, sent: 0, skipped: 0, errors: 0 };
  }

  logger.debug({ limit }, 'Running outreach scheduler');

  // Get candidates (we'll check business hours per-user based on their timezone)
  const candidates = await getEligibleCandidates(limit * 3); // Fetch more since some may be outside business hours

  if (candidates.length === 0) {
    logger.debug('Outreach scheduler: No eligible candidates');
    return { processed: 0, sent: 0, skipped: 0, errors: 0 };
  }

  logger.debug({ count: candidates.length }, 'Found outreach candidates');

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    // Stop once we've sent enough messages
    if (sent >= limit) {
      break;
    }

    // Check business hours in user's timezone (unless forced)
    if (!options.forceRun && !isBusinessHours(candidate.slack_tz_offset)) {
      logger.debug({
        candidate: candidate.slack_user_id,
        tzOffset: candidate.slack_tz_offset,
      }, 'Skipped - outside business hours in user timezone');
      skipped++;
      continue;
    }

    try {
      const result = await initiateOutreachWithPlanner(candidate);

      if (result.success) {
        sent++;
      } else if (result.error === 'No suitable goal found') {
        skipped++;
        logger.debug({ candidate: candidate.slack_user_id }, 'Skipped - no suitable goal');
      } else {
        errors++;
        logger.warn({ candidate: candidate.slack_user_id, error: result.error }, 'Outreach failed');
      }

      // Small delay between outreach to be respectful
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      errors++;
      logger.error({ error, candidate: candidate.slack_user_id }, 'Error during outreach');
    }
  }

  if (errors > 0) {
    logger.info({ sent, skipped, errors }, 'Outreach scheduler completed with errors');
  } else if (sent > 0) {
    logger.debug({ sent, skipped, errors }, 'Outreach scheduler completed');
  }
  return { processed: candidates.length, sent, skipped, errors };
}

/**
 * Manually trigger outreach to a specific user (admin function)
 * When an admin sends outreach, they become the account owner if no owner exists.
 */
export async function manualOutreach(
  slackUserId: string,
  triggeredBy?: { id: string; name: string; email: string }
): Promise<OutreachResult> {
  // Look up user
  const result = await query<SlackUserMapping>(
    `SELECT * FROM slack_user_mappings WHERE slack_user_id = $1`,
    [slackUserId]
  );

  if (result.rows.length === 0) {
    return { success: false, error: 'User not found' };
  }

  const user = result.rows[0];
  const candidate: OutreachCandidate = {
    ...user,
    priority: calculatePriority(user),
  };

  const outreachResult = await initiateOutreachWithPlanner(candidate);

  // If outreach was successful and we know who triggered it, auto-assign them as owner
  if (outreachResult.success && triggeredBy) {
    try {
      await assignUserStakeholder({
        slackUserId,
        workosUserId: user.workos_user_id || undefined,
        stakeholderId: triggeredBy.id,
        stakeholderName: triggeredBy.name,
        stakeholderEmail: triggeredBy.email,
        role: 'owner',
        reason: 'outreach',
      });

      logger.info({
        slackUserId,
        stakeholderId: triggeredBy.id,
      }, 'Auto-assigned user to admin after outreach');
    } catch (error) {
      // Don't fail the outreach if assignment fails
      logger.warn({ error, slackUserId }, 'Failed to auto-assign user after outreach');
    }
  }

  return outreachResult;
}

/**
 * Manual outreach with a specific goal (admin override)
 *
 * Allows admins to send outreach using a specific goal instead of the planner's recommendation.
 * Optionally records admin context as an insight before sending.
 *
 * @param slackUserId - Target user's Slack ID
 * @param goalId - Specific goal ID to use
 * @param adminContext - Optional context from admin to record as insight
 * @param triggeredBy - Admin who triggered the outreach
 */
export async function manualOutreachWithGoal(
  slackUserId: string,
  goalId: number,
  adminContext?: string,
  triggeredBy?: { id: string; name: string; email: string }
): Promise<OutreachResult> {
  const planner = getOutboundPlanner();

  // Look up user
  const result = await query<SlackUserMapping>(
    `SELECT * FROM slack_user_mappings WHERE slack_user_id = $1`,
    [slackUserId]
  );

  if (result.rows.length === 0) {
    return { success: false, error: 'User not found' };
  }

  const user = result.rows[0];

  // Get the specific goal
  const goal = await outboundDb.getGoal(goalId);
  if (!goal) {
    return { success: false, error: 'Goal not found' };
  }

  // Record admin context as insight if provided
  if (adminContext && adminContext.trim()) {
    try {
      // Find or create admin_context insight type
      const adminContextType = await insightsDb.getInsightTypeByName('admin_context');
      if (adminContextType) {
        await insightsDb.addInsight({
          slack_user_id: slackUserId,
          insight_type_id: adminContextType.id,
          value: adminContext.trim(),
          confidence: 'high',
          source_type: 'manual',
        });
        logger.info({
          slackUserId,
          adminId: triggeredBy?.id,
          contextLength: adminContext.length,
        }, 'Recorded admin context as insight');
      }
    } catch (error) {
      // Don't fail outreach if insight recording fails
      logger.warn({ error, slackUserId }, 'Failed to record admin context insight');
    }
  }

  // Build context for message generation
  const candidate: OutreachCandidate = {
    slack_user_id: user.slack_user_id,
    slack_email: user.slack_email,
    slack_display_name: user.slack_display_name,
    slack_real_name: user.slack_real_name,
    workos_user_id: user.workos_user_id,
    last_outreach_at: user.last_outreach_at,
    slack_tz_offset: user.slack_tz_offset,
    priority: calculatePriority(user),
  };
  const ctx = await buildPlannerContext(candidate);

  // Build the message from the goal template
  const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;
  const message = planner.buildMessage(goal, ctx, linkUrl);

  // Send message, continuing existing thread if one exists
  const sendResult = await resolveThreadAndSendMessage(slackUserId, message);
  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  const { channelId, messageTs } = sendResult;

  // Map goal category to outreach type
  const outreachType: OutreachType = goal.category === 'admin' ? 'account_link'
    : goal.category === 'information' ? 'insight_goal'
    : 'custom';

  // Record outreach in member_outreach (legacy tracking)
  const outreach = await insightsDb.recordOutreach({
    slack_user_id: slackUserId,
    outreach_type: outreachType,
    dm_channel_id: channelId,
    initial_message: message,
  });

  // Record goal attempt with admin override reason
  await outboundDb.recordGoalAttempt({
    slack_user_id: slackUserId,
    goal_id: goal.id,
    planner_reason: `Admin override${adminContext ? ' with context' : ''}`,
    planner_score: 100, // Max priority for admin override
    decision_method: 'admin_override',
    outreach_id: outreach.id,
  });

  // Update user's last_outreach_at
  await updateLastOutreach(slackUserId);

  // Auto-assign admin as owner if outreach was successful
  if (triggeredBy) {
    try {
      await assignUserStakeholder({
        slackUserId,
        workosUserId: user.workos_user_id || undefined,
        stakeholderId: triggeredBy.id,
        stakeholderName: triggeredBy.name,
        stakeholderEmail: triggeredBy.email,
        role: 'owner',
        reason: 'outreach',
      });
    } catch (error) {
      logger.warn({ error, slackUserId }, 'Failed to auto-assign user after outreach');
    }
  }

  logger.info({
    outreachId: outreach.id,
    slackUserId,
    goalId: goal.id,
    goalName: goal.name,
    triggeredBy: triggeredBy?.id,
    hasAdminContext: !!adminContext,
    decision_method: 'admin_override',
  }, 'Sent admin-override outreach');

  return {
    success: true,
    outreach_id: outreach.id,
    dm_channel_id: channelId,
  };
}

/**
 * Get current outreach mode (always 'live')
 */
export function getOutreachMode(): 'live' {
  return OUTREACH_MODE;
}

/**
 * Slack's built-in system bot user ID.
 * Slackbot sends system notifications that should always be ignored.
 */
const SLACKBOT_USER_ID = 'USLACKBOT';

/**
 * Check if a specific user can be contacted
 */
export async function canContactUser(slackUserId: string): Promise<{
  canContact: boolean;
  reason?: string;
}> {
  // Always reject Slackbot - it's a system bot, not a real user
  if (slackUserId === SLACKBOT_USER_ID) {
    return { canContact: false, reason: 'Slackbot is a system bot' };
  }

  const result = await query<SlackUserMapping>(
    `SELECT * FROM slack_user_mappings WHERE slack_user_id = $1`,
    [slackUserId]
  );

  if (result.rows.length === 0) {
    return { canContact: false, reason: 'User not found' };
  }

  const user = result.rows[0];

  if (user.slack_is_bot) {
    return { canContact: false, reason: 'User is a bot' };
  }

  if (user.slack_is_deleted) {
    return { canContact: false, reason: 'User is deleted' };
  }

  if (user.outreach_opt_out) {
    return { canContact: false, reason: 'User has opted out' };
  }

  if (user.last_outreach_at) {
    const daysSince = (Date.now() - new Date(user.last_outreach_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < RATE_LIMIT_DAYS) {
      return {
        canContact: false,
        reason: `Contacted ${Math.floor(daysSince)} days ago (limit: ${RATE_LIMIT_DAYS} days)`,
      };
    }
  }

  return { canContact: true };
}
