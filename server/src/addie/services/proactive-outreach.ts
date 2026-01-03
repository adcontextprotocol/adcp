/**
 * Proactive Outreach Service
 *
 * Manages proactive outreach to Slack users via DMs.
 * Handles eligibility checking, rate limiting, business hours, and A/B testing.
 *
 * Outreach modes (controlled by OUTREACH_MODE env var):
 * - disabled: No outreach (default)
 * - test: Only message accounts in outreach_test_accounts table
 * - dry_run: Log what would be sent without actually sending
 * - live: Full production mode
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import {
  InsightsDatabase,
  type OutreachVariant,
  type InsightGoal,
} from '../../db/insights-db.js';
import {
  assignUserStakeholder,
  createActionItem,
} from '../../db/account-management-db.js';
import type { SlackUserMapping } from '../../slack/types.js';

const insightsDb = new InsightsDatabase();

// Outreach mode
type OutreachMode = 'disabled' | 'test' | 'dry_run' | 'live';
const OUTREACH_MODE = (process.env.OUTREACH_MODE || 'disabled') as OutreachMode;

// Configuration
const RATE_LIMIT_DAYS = 7; // Don't contact same user more than once per week
const BUSINESS_HOURS_START = 9; // 9 AM
const BUSINESS_HOURS_END = 17; // 5 PM

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
 * Check if current time is within business hours (9am-5pm ET weekdays)
 */
export function isBusinessHours(): boolean {
  const now = new Date();

  // Get ET timezone offset (handle DST)
  const etOffset = getEasternTimezoneOffset(now);
  const etHour = (now.getUTCHours() - etOffset + 24) % 24;
  const day = now.getUTCDay();

  // Weekend check
  if (day === 0 || day === 6) {
    return false;
  }

  // Business hours check
  return etHour >= BUSINESS_HOURS_START && etHour < BUSINESS_HOURS_END;
}

/**
 * Get Eastern timezone offset (handles DST)
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
 * Get test account candidates (for OUTREACH_MODE=test)
 */
async function getTestAccountCandidates(): Promise<OutreachCandidate[]> {
  const testAccounts = await insightsDb.listTestAccounts();
  const slackUserIds = testAccounts.map(a => a.slack_user_id);

  if (slackUserIds.length === 0) {
    return [];
  }

  const result = await query<SlackUserMapping>(
    `SELECT * FROM slack_user_mappings WHERE slack_user_id = ANY($1)`,
    [slackUserIds]
  );

  return result.rows
    .filter(isUserEligible)
    .map(user => ({
      ...user,
      priority: calculatePriority(user),
    }));
}

/**
 * Select an A/B test variant using weighted random selection
 */
async function selectVariant(): Promise<OutreachVariant | null> {
  const variants = await insightsDb.listVariants(true); // activeOnly
  if (variants.length === 0) {
    return null;
  }

  const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 100), 0);
  let random = Math.random() * totalWeight;

  for (const variant of variants) {
    random -= variant.weight || 100;
    if (random <= 0) {
      return variant;
    }
  }

  return variants[0]; // Fallback
}

/**
 * Determine outreach type based on user state
 */
function determineOutreachType(candidate: OutreachCandidate): OutreachType {
  // Unmapped users should be asked to link their account
  if (!candidate.workos_user_id) {
    return 'account_link';
  }

  // First time being contacted = introduction
  if (!candidate.last_outreach_at) {
    return 'introduction';
  }

  // Default to insight goal questions
  return 'insight_goal';
}

/**
 * Build outreach message from variant template
 */
function buildMessage(
  variant: OutreachVariant,
  candidate: OutreachCandidate,
  goal?: InsightGoal
): string {
  let message = variant.message_template;

  // Replace placeholders
  const userName = candidate.slack_display_name || candidate.slack_real_name || 'there';
  message = message.replace(/\{\{user_name\}\}/g, userName);

  // Build account link URL with slack_user_id for auto-linking
  const linkUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(candidate.slack_user_id)}`;
  message = message.replace(/\{\{link_url\}\}/g, linkUrl);

  if (goal) {
    message = message.replace(/\{\{goal_question\}\}/g, goal.question);
  }

  return message;
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
 */
async function sendDmMessage(channelId: string, text: string): Promise<string | null> {
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.error('ADDIE_BOT_TOKEN not configured');
    return null;
  }

  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channelId,
        text,
      }),
    });

    const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      logger.error({ error: data.error, channelId }, 'Failed to send DM message');
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
 * Initiate outreach to a single candidate
 */
async function initiateOutreach(candidate: OutreachCandidate): Promise<OutreachResult> {
  const outreachType = determineOutreachType(candidate);

  // Select variant for A/B testing
  const variant = await selectVariant();
  if (!variant) {
    return { success: false, error: 'No active outreach variants configured' };
  }

  // Get active goal if applicable
  let goal: InsightGoal | undefined;
  if (outreachType === 'insight_goal') {
    const goals = await insightsDb.getActiveGoalsForUser(!candidate.workos_user_id);
    goal = goals[0]; // Take highest priority goal
  }

  // Build message
  const message = buildMessage(variant, candidate, goal);

  // DRY_RUN mode: log but don't send
  if (OUTREACH_MODE === 'dry_run') {
    logger.info({
      mode: 'dry_run',
      candidate: candidate.slack_user_id,
      outreachType,
      variant: variant.name,
      message: message.substring(0, 100) + '...',
    }, 'DRY RUN: Would send outreach');
    return { success: true };
  }

  // Open DM channel
  const channelId = await openDmChannel(candidate.slack_user_id);
  if (!channelId) {
    return { success: false, error: 'Failed to open DM channel' };
  }

  // Send message
  const messageTs = await sendDmMessage(channelId, message);
  if (!messageTs) {
    return { success: false, error: 'Failed to send DM message' };
  }

  // Record outreach in database
  const outreach = await insightsDb.recordOutreach({
    slack_user_id: candidate.slack_user_id,
    outreach_type: outreachType,
    insight_goal_id: goal?.id,
    dm_channel_id: channelId,
    initial_message: message,
    variant_id: variant.id,
    tone: variant.tone,
    approach: variant.approach,
  });

  // Update user's last_outreach_at
  await updateLastOutreach(candidate.slack_user_id);

  logger.info({
    outreachId: outreach.id,
    slackUserId: candidate.slack_user_id,
    outreachType,
    variant: variant.name,
  }, 'Sent proactive outreach');

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

  // Check if outreach is enabled
  if (OUTREACH_MODE === 'disabled') {
    logger.debug('Outreach scheduler: Mode is disabled');
    return { processed: 0, sent: 0, skipped: 0, errors: 0 };
  }

  // Check business hours (unless forced)
  if (!options.forceRun && !isBusinessHours()) {
    logger.debug('Outreach scheduler: Outside business hours');
    return { processed: 0, sent: 0, skipped: 0, errors: 0 };
  }

  logger.info({ mode: OUTREACH_MODE, limit }, 'Running outreach scheduler');

  // Get candidates based on mode
  const candidates = OUTREACH_MODE === 'test'
    ? await getTestAccountCandidates()
    : await getEligibleCandidates(limit);

  if (candidates.length === 0) {
    logger.info('Outreach scheduler: No eligible candidates');
    return { processed: 0, sent: 0, skipped: 0, errors: 0 };
  }

  logger.info({ count: candidates.length }, 'Found outreach candidates');

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates.slice(0, limit)) {
    try {
      const result = await initiateOutreach(candidate);
      if (result.success) {
        sent++;
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

  logger.info({ sent, skipped, errors }, 'Outreach scheduler completed');
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

  const outreachResult = await initiateOutreach(candidate);

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
 * Get current outreach mode
 */
export function getOutreachMode(): OutreachMode {
  return OUTREACH_MODE;
}

/**
 * Check if a specific user can be contacted
 */
export async function canContactUser(slackUserId: string): Promise<{
  canContact: boolean;
  reason?: string;
}> {
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
