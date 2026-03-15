/**
 * Proactive Outreach Service
 *
 * Manages proactive outreach to people via Slack DMs and email.
 * Uses the engagement planner for relationship-aware message composition.
 * Handles eligibility checking, rate limiting, and business hours.
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import {
  assignUserStakeholder,
} from '../../db/account-management-db.js';
import * as relationshipDb from '../../db/relationship-db.js';
import { loadRelationshipContext } from './relationship-context.js';
import {
  shouldContact,
  composeMessage,
  computeNextContactDate,
  computeEngagementOpportunities,
} from './engagement-planner.js';
import {
  sendProspectEmail,
  getOrCreateUnsubscribeToken,
  getEmailBudget,
  EMAIL_PER_RUN_LIMIT,
} from './email-outreach.js';
import { captureEvent } from '../../utils/posthog.js';
import * as personEvents from '../../db/person-events-db.js';

// Outreach is always live - rate limiting and business hours provide safety
const OUTREACH_MODE = 'live' as const;

// Emergency kill switch - set OUTREACH_ENABLED=false to disable all outreach
const OUTREACH_ENABLED = process.env.OUTREACH_ENABLED !== 'false';

// Configuration
const BUSINESS_HOURS_START = 9; // 9 AM
const BUSINESS_HOURS_END = 17; // 5 PM
const SLACK_DM_PER_RUN_LIMIT = 10; // Max Slack DMs per scheduler run to avoid burst spam

/**
 * Result of sending outreach
 */
interface OutreachResult {
  success: boolean;
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
  let slackDmsSentThisRun = 0;

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

      // 3. Channel budget gate
      if (channel === 'email') {
        if (!emailBudget.canSend || emailsSentThisRun >= EMAIL_PER_RUN_LIMIT) {
          logger.debug({ person_id: candidate.id }, 'Skipped — email budget exhausted');
          skipped++;
          continue;
        }
      } else if (channel === 'slack') {
        if (slackDmsSentThisRun >= SLACK_DM_PER_RUN_LIMIT) {
          logger.debug({ person_id: candidate.id }, 'Skipped — Slack DM budget exhausted');
          skipped++;
          continue;
        }
      }

      // 4. Load full relationship context
      const context = await loadRelationshipContext(candidate.id, { includeCommunity: true });

      // 5. Compute engagement opportunities (pass contact reason for pulse boost)
      const engagementOpportunities = computeEngagementOpportunities({
        relationship: candidate,
        capabilities: context.profile.capabilities,
        company: context.profile.company,
        recentMessages: context.recentMessages,
        certification: context.certification,
      }, decision.reason);

      // 6. Compose message via Sonnet
      const composed = await composeMessage(
        { ...context, engagementOpportunities },
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

        slackDmsSentThisRun++;

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
          subject: composed.subject ?? 'AgenticAdvertising.org update',
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

      // Respect cadence preference if set (monthly=30d, quarterly=90d)
      const nextContact = await getCadenceAwareNextContact(candidate.id, candidate.stage);
      await relationshipDb.setNextContactAfter(candidate.id, nextContact);

      await relationshipDb.evaluateStageTransitions(candidate.id);

      // 9. Analytics
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
 * Manually trigger outreach to a specific user (admin function).
 * Uses the engagement planner to compose a contextual message.
 * When an admin sends outreach, they become the account owner if no owner exists.
 */
export async function manualOutreach(
  slackUserId: string,
  triggeredBy?: { id: string; name: string; email: string }
): Promise<OutreachResult> {
  // Find person in relationship model
  const relationship = await relationshipDb.getRelationshipBySlackId(slackUserId);
  if (!relationship) {
    return { success: false, error: 'Person not found in relationship model' };
  }

  // Respect opt-out and negative sentiment even for admin-triggered outreach
  if (relationship.opted_out) {
    return { success: false, error: 'Person has opted out of outreach' };
  }
  if (relationship.sentiment_trend === 'negative') {
    return { success: false, error: 'Person has negative sentiment — outreach suppressed' };
  }

  // Load full context and compose via engagement planner
  const context = await loadRelationshipContext(relationship.id, { includeCommunity: true });
  const engagementOpportunities = computeEngagementOpportunities({
    relationship,
    capabilities: context.profile.capabilities,
    company: context.profile.company,
    recentMessages: context.recentMessages,
    certification: context.certification,
  });
  const channel: 'slack' | 'email' = relationship.contact_preference
    ?? (relationship.slack_user_id ? 'slack' : 'email');

  const composed = await composeMessage(
    { ...context, engagementOpportunities },
    channel,
    'admin-triggered outreach'
  );

  if (!composed) {
    return { success: false, error: 'Nothing meaningful to say — Sonnet skipped' };
  }

  // Send via appropriate channel
  let dmChannelId: string | undefined;

  if (channel === 'slack') {
    if (!relationship.slack_user_id) {
      return { success: false, error: 'No Slack ID on relationship' };
    }

    const slackResult = await sendSlackViaPermThread(relationship, composed.text);
    if (!slackResult) {
      return { success: false, error: 'Failed to send Slack message' };
    }
    dmChannelId = slackResult.channelId;

    personEvents.recordEvent(relationship.id, 'message_sent', {
      channel: 'slack',
      data: {
        text: composed.text,
        channel_id: slackResult.channelId,
        thread_ts: slackResult.messageTs,
        stage: relationship.stage,
        goal_hint: composed.goalHint,
        triggered_by: triggeredBy?.id,
      },
    }).catch(err => logger.warn({ err }, 'Failed to record person event'));
  } else {
    if (!relationship.email) {
      return { success: false, error: 'No email on relationship' };
    }

    const unsubToken = await getOrCreateUnsubscribeToken(relationship.email);
    const sendResult = await sendProspectEmail({
      to: relationship.email,
      subject: composed.subject ?? 'AgenticAdvertising.org update',
      bodyHtml: composed.html ?? composed.text,
      bodyText: composed.text,
      prospectOrgId: relationship.prospect_org_id ?? '',
      unsubscribeToken: unsubToken,
    });

    if (!sendResult.success) {
      return { success: false, error: `Failed to send email: ${sendResult.error}` };
    }

    personEvents.recordEvent(relationship.id, 'message_sent', {
      channel: 'email',
      data: {
        subject: composed.subject,
        text_length: composed.text.length,
        stage: relationship.stage,
        goal_hint: composed.goalHint,
        triggered_by: triggeredBy?.id,
      },
    }).catch(err => logger.warn({ err }, 'Failed to record person event'));
  }

  // Update relationship
  await relationshipDb.recordAddieMessage(relationship.id, channel);
  await relationshipDb.setNextContactAfter(
    relationship.id,
    computeNextContactDate(relationship.stage)
  );

  captureEvent(slackUserId, 'outreach_sent', {
    person_id: relationship.id,
    channel,
    stage: relationship.stage,
    goal_hint: composed.goalHint,
    triggered_by: triggeredBy?.id,
  });

  // Auto-assign admin as owner
  if (triggeredBy) {
    try {
      await assignUserStakeholder({
        slackUserId,
        workosUserId: relationship.workos_user_id || undefined,
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
    dm_channel_id: dmChannelId,
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
 * Get the next contact date, respecting any cadence preference the user has set.
 * Checks for the most recent preference_changed event with a cadence value.
 */
async function getCadenceAwareNextContact(personId: string, stage: relationshipDb.RelationshipStage): Promise<Date> {
  const defaultNext = computeNextContactDate(stage);

  try {
    // Fetch enough events to find the most recent (timeline returns ASC order)
    const events = await personEvents.getPersonTimeline(personId, {
      eventTypes: ['preference_changed'],
    });

    const latest = events[events.length - 1];
    if (!latest) return defaultNext;

    const cadence = latest.data?.cadence as string | undefined;
    if (!cadence || cadence === 'default') return defaultNext;

    const cadenceDays = cadence === 'monthly' ? 30 : cadence === 'quarterly' ? 90 : null;
    if (!cadenceDays) return defaultNext;

    const next = new Date();
    next.setDate(next.getDate() + cadenceDays);
    return next;
  } catch {
    return defaultNext;
  }
}

/**
 * Check if a specific user can be contacted.
 * Uses the relationship model and engagement planner's shouldContact().
 */
export async function canContactUser(slackUserId: string): Promise<{
  canContact: boolean;
  reason?: string;
  channel?: 'slack' | 'email';
}> {
  if (slackUserId === SLACKBOT_USER_ID) {
    return { canContact: false, reason: 'Slackbot is a system bot' };
  }

  const relationship = await relationshipDb.getRelationshipBySlackId(slackUserId);
  if (!relationship) {
    return { canContact: false, reason: 'Person not found in relationship model' };
  }

  const decision = shouldContact(relationship);
  return {
    canContact: decision.shouldContact,
    reason: decision.shouldContact ? undefined : decision.reason,
    channel: decision.channel,
  };
}

