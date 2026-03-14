/**
 * Proactive Outreach Service
 *
 * Manages proactive outreach to people via Slack DMs and email.
 * Uses the engagement planner for relationship-aware message composition.
 * Handles eligibility checking, rate limiting, and business hours.
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import {
  assignUserStakeholder,
} from '../../db/account-management-db.js';
import * as outboundDb from '../../db/outbound-db.js';
import * as relationshipDb from '../../db/relationship-db.js';
import { loadRelationshipContext } from './relationship-context.js';
import {
  shouldContact,
  composeMessage,
  computeNextContactDate,
  getAvailableActions,
} from './engagement-planner.js';
import {
  sendProspectEmail,
  getOrCreateUnsubscribeToken,
  getEmailBudget,
  EMAIL_PER_RUN_LIMIT,
} from './email-outreach.js';
import { getOutboundPlanner } from './outbound-planner.js';
import { getThreadService } from '../thread-service.js';
import type { PlannerContext } from '../types.js';
import type { SlackUserMapping } from '../../slack/types.js';
import { captureEvent } from '../../utils/posthog.js';
import * as personEvents from '../../db/person-events-db.js';

const insightsDb = new InsightsDatabase();

// Outreach is always live - rate limiting and business hours provide safety
const OUTREACH_MODE = 'live' as const;

// Emergency kill switch - set OUTREACH_ENABLED=false to disable all outreach
const OUTREACH_ENABLED = process.env.OUTREACH_ENABLED !== 'false';

// Configuration
const RATE_LIMIT_DAYS = 7; // Don't contact same user more than once per week
const BUSINESS_HOURS_START = 9; // 9 AM
const BUSINESS_HOURS_END = 17; // 5 PM

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
 * Look up the Slack timezone offset for a person who has a slack_user_id.
 * Returns null if no mapping found.
 */
async function getSlackTzOffset(slackUserId: string): Promise<number | null> {
  const result = await query<{ slack_tz_offset: number | null }>(
    `SELECT slack_tz_offset FROM slack_user_mappings WHERE slack_user_id = $1`,
    [slackUserId]
  );
  return result.rows[0]?.slack_tz_offset ?? null;
}

/**
 * Send a Slack message using the permanent thread on the relationship.
 * If no permanent thread exists, opens a DM and saves the new thread coordinates.
 * Returns the message timestamp or null on failure.
 */
async function sendSlackViaPermThread(
  candidate: relationshipDb.PersonRelationship,
  text: string
): Promise<{ channelId: string; messageTs: string } | null> {
  // If we have a permanent thread, reply to it
  if (candidate.slack_dm_channel_id && candidate.slack_dm_thread_ts) {
    const messageTs = await sendDmMessage(
      candidate.slack_dm_channel_id,
      text,
      candidate.slack_dm_thread_ts
    );
    if (messageTs) {
      return { channelId: candidate.slack_dm_channel_id, messageTs };
    }
    // Thread send failed — fall through to open a new channel
    logger.warn(
      { person_id: candidate.id, channel: candidate.slack_dm_channel_id },
      'Failed to send to permanent thread, opening new channel'
    );
  }

  // No permanent thread yet (or it failed) — open DM and start one
  const channelId = await openDmChannel(candidate.slack_user_id!);
  if (!channelId) return null;

  const messageTs = await sendDmMessage(channelId, text);
  if (!messageTs) return null;

  // Save as the permanent thread for this relationship
  await relationshipDb.setSlackDmThread(candidate.id, channelId, messageTs);

  return { channelId, messageTs };
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

  // Get candidates from the relationship model
  const candidates = await relationshipDb.getEngagementCandidates({ limit: limit * 3 });

  logger.debug({ count: candidates.length }, 'Found engagement candidates');

  // Pre-fetch email budget so we can gate email sends
  let emailBudget = await getEmailBudget();
  let emailsSentThisRun = 0;

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    if (sent >= limit) break;

    try {
      // 1. Rule-based eligibility check
      const decision = shouldContact(candidate);
      if (!decision.shouldContact) {
        logger.debug(
          { person_id: candidate.id, reason: decision.reason },
          'Skipped — not eligible'
        );
        personEvents.recordEvent(candidate.id, 'outreach_skipped', {
          channel: 'system',
          data: { reason: decision.reason, stage: candidate.stage },
        }).catch(err => logger.warn({ err }, 'Failed to record person event'));
        skipped++;
        continue;
      }

      const channel = decision.channel;

      // 2. Business hours check (Slack only — email doesn't need it)
      if (channel === 'slack' && candidate.slack_user_id && !options.forceRun) {
        const tzOffset = await getSlackTzOffset(candidate.slack_user_id);
        if (!isBusinessHours(tzOffset)) {
          logger.debug(
            { person_id: candidate.id, tzOffset },
            'Skipped — outside business hours'
          );
          skipped++;
          continue;
        }
      }

      // 3. Email budget gate
      if (channel === 'email') {
        if (!emailBudget.canSend || emailsSentThisRun >= EMAIL_PER_RUN_LIMIT) {
          logger.debug({ person_id: candidate.id }, 'Skipped — email budget exhausted');
          skipped++;
          continue;
        }
      }

      // 4. Load full relationship context
      const context = await loadRelationshipContext(candidate.id, { includeCommunity: true });

      // 5. Determine available actions
      const availableActions = getAvailableActions(candidate, context.profile.capabilities);

      // 6. Compose message via Sonnet
      const composed = await composeMessage(
        { ...context, availableActions },
        channel,
        decision.reason
      );

      if (!composed) {
        logger.debug({ person_id: candidate.id }, 'Skipped — Sonnet had nothing to say');
        personEvents.recordEvent(candidate.id, 'message_composed', {
          channel,
          data: { action: 'skip', reason: 'nothing meaningful to say', stage: candidate.stage },
        }).catch(err => logger.warn({ err }, 'Failed to record person event'));
        skipped++;
        continue;
      }

      // Record the outreach decision and composition
      personEvents.recordEvent(candidate.id, 'outreach_decided', {
        channel,
        data: { reason: decision.reason, stage: candidate.stage, goal_hint: composed.goalHint },
      }).catch(err => logger.warn({ err }, 'Failed to record person event'));
      personEvents.recordEvent(candidate.id, 'message_composed', {
        channel,
        data: {
          action: 'send',
          stage: candidate.stage,
          has_subject: !!composed.subject,
          goal_hint: composed.goalHint,
          text_length: composed.text.length,
        },
      }).catch(err => logger.warn({ err }, 'Failed to record person event'));

      // 7. Route by channel
      let channelId: string | undefined;

      if (channel === 'slack') {
        if (!candidate.slack_user_id) {
          logger.warn({ person_id: candidate.id }, 'Slack channel selected but no slack_user_id');
          errors++;
          continue;
        }

        const slackResult = await sendSlackViaPermThread(candidate, composed.text);
        if (!slackResult) {
          errors++;
          logger.warn({ person_id: candidate.id }, 'Failed to send Slack message');
          continue;
        }
        channelId = slackResult.channelId;

        personEvents.recordEvent(candidate.id, 'message_sent', {
          channel: 'slack',
          data: {
            text: composed.text,
            channel_id: slackResult.channelId,
            thread_ts: slackResult.messageTs,
            stage: candidate.stage,
            goal_hint: composed.goalHint,
          },
        }).catch(err => logger.warn({ err }, 'Failed to record person event'));

        // Delay between Slack messages
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        // Email
        if (!candidate.email) {
          logger.warn({ person_id: candidate.id }, 'Email channel selected but no email');
          errors++;
          continue;
        }

        const unsubToken = await getOrCreateUnsubscribeToken(candidate.email);
        const sendResult = await sendProspectEmail({
          to: candidate.email,
          subject: composed.subject ?? 'From Addie at AgenticAdvertising.org',
          bodyHtml: composed.html ?? composed.text,
          bodyText: composed.text,
          prospectOrgId: candidate.prospect_org_id ?? '',
          unsubscribeToken: unsubToken,
        });

        if (!sendResult.success) {
          errors++;
          logger.warn({ person_id: candidate.id, error: sendResult.error }, 'Failed to send email');
          continue;
        }

        emailsSentThisRun++;

        personEvents.recordEvent(candidate.id, 'message_sent', {
          channel: 'email',
          data: {
            subject: composed.subject,
            to: candidate.email,
            text_length: composed.text.length,
            stage: candidate.stage,
            goal_hint: composed.goalHint,
          },
        }).catch(err => logger.warn({ err }, 'Failed to record person event'));

        // Delay between emails
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // 8. Record on the relationship
      await relationshipDb.recordAddieMessage(candidate.id, channel);
      await relationshipDb.setNextContactAfter(
        candidate.id,
        computeNextContactDate(candidate.stage)
      );
      await relationshipDb.evaluateStageTransitions(candidate.id);

      // 9. Dual-write to legacy goal tracking
      if (composed.goalHint) {
        // Find a matching goal ID for the hint, or use a generic one
        const goals = await outboundDb.listGoals();
        const matchingGoal = goals.find(g =>
          g.name.toLowerCase().includes(composed.goalHint!.toLowerCase().slice(0, 20))
        );
        if (matchingGoal) {
          await outboundDb.recordGoalAttempt({
            slack_user_id: candidate.slack_user_id ?? undefined,
            goal_id: matchingGoal.id,
            planner_reason: `engagement-planner: ${composed.goalHint}`,
            planner_score: 50,
            decision_method: 'engagement_planner',
            channel,
            prospect_org_id: candidate.prospect_org_id ?? undefined,
          });
        }
      }

      // 10. Analytics
      captureEvent(candidate.slack_user_id ?? candidate.id, 'outreach_sent', {
        person_id: candidate.id,
        channel,
        stage: candidate.stage,
        goal_hint: composed.goalHint,
      });

      sent++;
      logger.debug({
        person_id: candidate.id,
        channel,
        stage: candidate.stage,
      }, 'Sent engagement message');
    } catch (error) {
      errors++;
      logger.error({ error, person_id: candidate.id }, 'Error during outreach');
    }
  }

  if (errors > 0) {
    logger.info({ sent, skipped, errors, total: candidates.length }, 'Outreach scheduler completed with errors');
  } else if (sent > 0) {
    logger.debug({ sent, skipped, errors, total: candidates.length }, 'Outreach scheduler completed');
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
  const candidate = {
    slack_user_id: user.slack_user_id,
    slack_email: user.slack_email,
    slack_display_name: user.slack_display_name,
    slack_real_name: user.slack_real_name,
    workos_user_id: user.workos_user_id,
    last_outreach_at: user.last_outreach_at,
    slack_tz_offset: user.slack_tz_offset,
    priority: 0,
  };

  // Build context for the planner
  const ctx = await buildLegacyPlannerContext(candidate);

  // Let the planner decide what goal to pursue
  const plannedAction = await planner.planNextAction(ctx);

  if (!plannedAction) {
    return { success: false, error: 'No suitable goal found' };
  }

  // Admin-triggered: update last_outreach_at unconditionally
  await query(
    `UPDATE slack_user_mappings SET last_outreach_at = NOW(), updated_at = NOW() WHERE slack_user_id = $1`,
    [slackUserId]
  );

  // Build and send message
  const basePath = plannedAction.goal.category === 'invitation' ? '/join' : '/auth/login';
  const linkUrl = `https://agenticadvertising.org${basePath}?slack_user_id=${encodeURIComponent(slackUserId)}`;
  const message = planner.buildMessage(plannedAction.goal, ctx, linkUrl);

  const threadService = getThreadService();
  const recentThread = await threadService.getUserRecentThread(slackUserId, 'slack', 7 * 24 * 60);

  let channelId: string;
  let messageTs: string | null = null;

  if (recentThread?.external_id) {
    const [existingChannelId, existingThreadTs] = recentThread.external_id.split(':');
    if (existingChannelId && existingThreadTs) {
      messageTs = await sendDmMessage(existingChannelId, message, existingThreadTs);
      if (messageTs) {
        channelId = existingChannelId;
      }
    }
  }

  if (!messageTs) {
    const newChannelId = await openDmChannel(slackUserId);
    if (!newChannelId) {
      return { success: false, error: 'Failed to open DM channel' };
    }
    channelId = newChannelId;
    messageTs = await sendDmMessage(channelId, message);
    if (!messageTs) {
      return { success: false, error: 'Failed to send DM message' };
    }
  }

  // Map goal category to outreach type
  const outreachType = plannedAction.goal.category === 'admin' ? 'account_link'
    : plannedAction.goal.category === 'information' ? 'insight_goal'
    : 'custom';

  // Record outreach in member_outreach (legacy tracking)
  const outreach = await insightsDb.recordOutreach({
    slack_user_id: slackUserId,
    outreach_type: outreachType,
    dm_channel_id: channelId!,
    initial_message: message,
  });

  // Record goal attempt
  await outboundDb.recordGoalAttempt({
    slack_user_id: slackUserId,
    goal_id: plannedAction.goal.id,
    planner_reason: plannedAction.reason,
    planner_score: plannedAction.priority_score,
    decision_method: plannedAction.decision_method,
    outreach_id: outreach.id,
  });

  captureEvent(slackUserId, 'outreach_sent', {
    goal_id: plannedAction.goal.id,
    goal_name: plannedAction.goal.name,
    decision_method: plannedAction.decision_method,
  });

  // Auto-assign admin as owner
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

  return {
    success: true,
    outreach_id: outreach.id,
    dm_channel_id: channelId!,
  };
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
      logger.warn({ error, slackUserId }, 'Failed to record admin context insight');
    }
  }

  // Build context for message generation
  const candidate = {
    slack_user_id: user.slack_user_id,
    slack_email: user.slack_email,
    slack_display_name: user.slack_display_name,
    slack_real_name: user.slack_real_name,
    workos_user_id: user.workos_user_id,
    last_outreach_at: user.last_outreach_at,
    slack_tz_offset: user.slack_tz_offset,
    priority: 0,
  };
  const ctx = await buildLegacyPlannerContext(candidate);

  // Build the message from the goal template
  const basePath = goal.category === 'invitation' ? '/join' : '/auth/login';
  const linkUrl = `https://agenticadvertising.org${basePath}?slack_user_id=${encodeURIComponent(slackUserId)}`;
  const message = planner.buildMessage(goal, ctx, linkUrl);

  // Send message, continuing existing thread if one exists
  const threadService = getThreadService();
  const recentThread = await threadService.getUserRecentThread(slackUserId, 'slack', 7 * 24 * 60);

  let channelId: string;
  let messageTs: string | null = null;

  if (recentThread?.external_id) {
    const [existingChannelId, existingThreadTs] = recentThread.external_id.split(':');
    if (existingChannelId && existingThreadTs) {
      messageTs = await sendDmMessage(existingChannelId, message, existingThreadTs);
      if (messageTs) {
        channelId = existingChannelId;
      }
    }
  }

  if (!messageTs) {
    const newChannelId = await openDmChannel(slackUserId);
    if (!newChannelId) {
      return { success: false, error: 'Failed to open DM channel' };
    }
    channelId = newChannelId;
    messageTs = await sendDmMessage(channelId, message);
    if (!messageTs) {
      return { success: false, error: 'Failed to send DM message' };
    }
  }

  // Map goal category to outreach type
  const outreachType = goal.category === 'admin' ? 'account_link'
    : goal.category === 'information' ? 'insight_goal'
    : 'custom';

  // Record outreach in member_outreach (legacy tracking)
  const outreach = await insightsDb.recordOutreach({
    slack_user_id: slackUserId,
    outreach_type: outreachType,
    dm_channel_id: channelId!,
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

  // Update last_outreach_at (manual admin override, unconditional)
  await query(
    `UPDATE slack_user_mappings SET last_outreach_at = NOW(), updated_at = NOW() WHERE slack_user_id = $1`,
    [slackUserId]
  );

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
    dm_channel_id: channelId!,
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

// ─── Legacy planner context builder (used by admin functions) ────────────────

/**
 * Build PlannerContext from a slack_user_mappings row.
 * Used by manualOutreach and manualOutreachWithGoal which still use the old planner.
 */
async function buildLegacyPlannerContext(candidate: {
  slack_user_id: string;
  slack_email: string | null;
  slack_display_name: string | null;
  slack_real_name: string | null;
  workos_user_id: string | null;
  last_outreach_at: Date | null;
  slack_tz_offset: number | null;
}): Promise<PlannerContext> {
  const [insights, history, capabilities, contactEligibility] = await Promise.all([
    insightsDb.getInsightsForUser(candidate.slack_user_id),
    outboundDb.getUserGoalHistory(candidate.slack_user_id),
    outboundDb.getMemberCapabilities(candidate.slack_user_id, candidate.workos_user_id ?? undefined),
    canContactUser(candidate.slack_user_id),
  ]);

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
                                  org.name.toLowerCase().endsWith("\u2019s workspace");
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
    available_channels: ['slack'],
  };
}
