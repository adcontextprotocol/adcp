/**
 * Goal Follow-Up Job
 *
 * Handles two key responsibilities:
 * 1. Send follow-up messages for goals that haven't received responses
 * 2. Reconcile goal outcomes (check if goals were achieved)
 *
 * This runs periodically to:
 * - Find goals where we sent outreach but got no response
 * - Send a gentler follow-up message if within attempt limits
 * - Check if invitation/admin goals were achieved through other means
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';
import * as outboundDb from '../../db/outbound-db.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import type { OutreachGoal } from '../types.js';
import { FOUNDING_DEADLINE } from '../founding-deadline.js';

const insightsDb = new InsightsDatabase();

// ============================================================================
// TYPES
// ============================================================================

interface PendingFollowUp {
  history_id: number;
  slack_user_id: string;
  goal_id: number;
  goal_name: string;
  goal_category: string;
  attempt_count: number;
  max_attempts: number;
  days_since_last: number;
  days_between_attempts: number;
  follow_up_template: string | null;
  outreach_id: number | null;
  user_display_name: string | null;
  workos_user_id: string | null;
}

interface ReconcilableGoal {
  history_id: number;
  slack_user_id: string;
  workos_user_id: string | null;
  goal_id: number;
  goal_name: string;
  goal_category: string;
  success_insight_type: string | null;
  sent_at: Date;
}

// ============================================================================
// FOLLOW-UP LOGIC
// ============================================================================

/**
 * Find goals that need follow-up messages
 * Criteria:
 * - Status is 'sent' (no response yet)
 * - Enough days have passed since last attempt
 * - Haven't exceeded max attempts
 * - Goal has a follow_up_template
 */
async function getGoalsNeedingFollowUp(): Promise<PendingFollowUp[]> {
  const result = await query<PendingFollowUp>(
    `SELECT
      ugh.id as history_id,
      ugh.slack_user_id,
      ugh.goal_id,
      og.name as goal_name,
      og.category as goal_category,
      ugh.attempt_count,
      COALESCE(og.max_attempts, 2) as max_attempts,
      EXTRACT(DAY FROM NOW() - ugh.last_attempt_at)::integer as days_since_last,
      COALESCE(og.days_between_attempts, 7) as days_between_attempts,
      og.follow_up_template,
      ugh.outreach_id,
      COALESCE(sm.slack_display_name, sm.slack_real_name) as user_display_name,
      sm.workos_user_id
    FROM user_goal_history ugh
    JOIN outreach_goals og ON og.id = ugh.goal_id
    JOIN slack_user_mappings sm ON sm.slack_user_id = ugh.slack_user_id
    WHERE ugh.status = 'sent'
      AND og.is_enabled = TRUE
      AND og.follow_up_template IS NOT NULL
      AND ugh.attempt_count < COALESCE(og.max_attempts, 2)
      AND ugh.last_attempt_at <= NOW() - (COALESCE(og.days_between_attempts, 7) || ' days')::interval
      AND sm.outreach_opt_out = FALSE
      AND sm.slack_is_bot = FALSE
      AND sm.slack_is_deleted = FALSE
    ORDER BY ugh.last_attempt_at ASC
    LIMIT 20`
  );

  return result.rows;
}

/**
 * Send a follow-up message for a goal
 */
async function sendFollowUp(pending: PendingFollowUp): Promise<boolean> {
  if (!pending.follow_up_template) {
    return false;
  }

  // Skip time-sensitive goals past their deadline
  if (pending.goal_name === 'Founding Member Deadline' && new Date() >= FOUNDING_DEADLINE) {
    return false;
  }

  // Build the follow-up message
  let message = pending.follow_up_template;
  message = message.replace(/\{\{user_name\}\}/g, pending.user_display_name || 'there');

  // Build link URL if needed
  const baseUrl = process.env.APP_BASE_URL || 'https://agenticadvertising.org';
  const basePath = pending.goal_category === 'invitation' ? '/join' : '/auth/login';
  const linkUrl = `${baseUrl}${basePath}?slack_user_id=${encodeURIComponent(pending.slack_user_id)}`;
  message = message.replace(/\{\{link_url\}\}/g, linkUrl);

  // Get company name if we have workos_user_id
  if (pending.workos_user_id) {
    const orgResult = await query<{ name: string }>(
      `SELECT o.name FROM organization_memberships om
       JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
       WHERE om.workos_user_id = $1 LIMIT 1`,
      [pending.workos_user_id]
    );
    const companyName = orgResult.rows[0]?.name || 'your company';
    message = message.replace(/\{\{company_name\}\}/g, companyName);
  } else {
    message = message.replace(/\{\{company_name\}\}/g, 'your company');
  }

  // Dynamic countdown for time-sensitive goals (founding member deadline)
  const daysRemaining = Math.max(0, Math.ceil((FOUNDING_DEADLINE.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  message = message.replace(/\{\{days_remaining\}\}/g, String(daysRemaining));

  // Open DM channel and send
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.error('ADDIE_BOT_TOKEN not configured for follow-up');
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
      body: JSON.stringify({ users: pending.slack_user_id }),
    });
    const openData = await openResponse.json() as { ok: boolean; channel?: { id: string }; error?: string };
    if (!openData.ok || !openData.channel?.id) {
      logger.warn({ error: openData.error, slackUserId: pending.slack_user_id }, 'Failed to open DM for follow-up');
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
      }),
    });
    const sendData = await sendResponse.json() as { ok: boolean; error?: string };
    if (!sendData.ok) {
      logger.warn({ error: sendData.error, slackUserId: pending.slack_user_id }, 'Failed to send follow-up message');
      return false;
    }

    // Update goal history
    await query(
      `UPDATE user_goal_history
       SET attempt_count = attempt_count + 1,
           last_attempt_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [pending.history_id]
    );

    // Record in member_outreach for tracking
    await insightsDb.recordOutreach({
      slack_user_id: pending.slack_user_id,
      outreach_type: pending.goal_category === 'admin' ? 'account_link' : 'insight_goal',
      dm_channel_id: openData.channel.id,
      initial_message: message,
    });

    logger.info({
      slackUserId: pending.slack_user_id,
      goalId: pending.goal_id,
      goalName: pending.goal_name,
      attemptCount: pending.attempt_count + 1,
    }, 'Sent follow-up message');

    return true;
  } catch (error) {
    logger.error({ error, slackUserId: pending.slack_user_id }, 'Error sending follow-up');
    return false;
  }
}

// ============================================================================
// OUTCOME RECONCILIATION
// ============================================================================

/**
 * Find goals that might have been achieved through other means
 * (user joined WG, linked account, etc. without responding to outreach)
 */
async function getGoalsToReconcile(): Promise<ReconcilableGoal[]> {
  const result = await query<ReconcilableGoal>(
    `SELECT
      ugh.id as history_id,
      ugh.slack_user_id,
      sm.workos_user_id,
      ugh.goal_id,
      og.name as goal_name,
      og.category as goal_category,
      og.success_insight_type,
      ugh.last_attempt_at as sent_at
    FROM user_goal_history ugh
    JOIN outreach_goals og ON og.id = ugh.goal_id
    JOIN slack_user_mappings sm ON sm.slack_user_id = ugh.slack_user_id
    WHERE ugh.status IN ('sent', 'responded')
      AND ugh.status != 'success'
      AND ugh.last_attempt_at >= NOW() - INTERVAL '30 days'
    ORDER BY ugh.last_attempt_at DESC
    LIMIT 100`
  );

  return result.rows;
}

/**
 * Check if a goal was achieved and mark as success if so
 */
async function reconcileGoal(goal: ReconcilableGoal): Promise<boolean> {
  let achieved = false;
  let reason = '';

  // Check based on goal category
  switch (goal.goal_category) {
    case 'admin': {
      // Admin goals (like "Link Account") - check if user is now mapped
      if (!goal.workos_user_id) {
        // Check if they've linked since
        const checkResult = await query<{ workos_user_id: string | null }>(
          `SELECT workos_user_id FROM slack_user_mappings WHERE slack_user_id = $1`,
          [goal.slack_user_id]
        );
        if (checkResult.rows[0]?.workos_user_id) {
          achieved = true;
          reason = 'User linked account';
        }
      } else {
        // Already linked when we queried
        achieved = true;
        reason = 'User already linked';
      }
      break;
    }

    case 'invitation': {
      // Invitation goals - check if user joined the thing we invited them to
      // This is simplistic - in practice you'd check specific WG/council membership
      if (goal.workos_user_id) {
        const wgResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM working_group_memberships
           WHERE workos_user_id = $1 AND status = 'active'
           AND joined_at >= $2`,
          [goal.workos_user_id, goal.sent_at]
        );
        if (parseInt(wgResult.rows[0].count, 10) > 0) {
          achieved = true;
          reason = 'User joined a working group after invitation';
        }
      }
      break;
    }

    case 'information': {
      // Information goals - check if we have the insight we were seeking
      if (goal.success_insight_type) {
        const insights = await insightsDb.getInsightsForUser(goal.slack_user_id);
        const hasInsight = insights.some(i =>
          i.insight_type_name === goal.success_insight_type &&
          new Date(i.created_at) >= goal.sent_at
        );
        if (hasInsight) {
          achieved = true;
          reason = `Captured ${goal.success_insight_type} insight`;
        }
      }
      break;
    }
  }

  if (achieved) {
    // Mark goal as success
    await query(
      `UPDATE user_goal_history
       SET status = 'success', updated_at = NOW()
       WHERE id = $1`,
      [goal.history_id]
    );

    // Also update the outreach record if there is one
    const outreachResult = await query<{ id: number }>(
      `SELECT mo.id FROM member_outreach mo
       WHERE mo.slack_user_id = $1
       AND mo.sent_at >= $2
       AND mo.user_responded = FALSE
       ORDER BY mo.sent_at DESC LIMIT 1`,
      [goal.slack_user_id, goal.sent_at]
    );
    if (outreachResult.rows[0]) {
      await insightsDb.markOutreachConverted(
        outreachResult.rows[0].id,
        `Goal achieved: ${reason}`
      );
    }

    logger.debug({
      slackUserId: goal.slack_user_id,
      goalId: goal.goal_id,
      goalName: goal.goal_name,
      reason,
    }, 'Reconciled goal as success');
  }

  return achieved;
}

// ============================================================================
// MAIN JOB
// ============================================================================

export interface FollowUpJobResult {
  followUpsSent: number;
  followUpsSkipped: number;
  goalsReconciled: number;
  goalsStillPending: number;
}

/**
 * Run the goal follow-up job
 *
 * @param options.dryRun - If true, don't actually send messages or update DB
 * @param options.skipFollowUps - If true, only run reconciliation
 * @param options.skipReconciliation - If true, only send follow-ups
 */
export async function runGoalFollowUpJob(options: {
  dryRun?: boolean;
  skipFollowUps?: boolean;
  skipReconciliation?: boolean;
} = {}): Promise<FollowUpJobResult> {
  logger.debug({ options }, 'Running goal follow-up job');

  let followUpsSent = 0;
  let followUpsSkipped = 0;
  let goalsReconciled = 0;
  let goalsStillPending = 0;

  // Part 1: Send follow-up messages
  if (!options.skipFollowUps) {
    const pendingFollowUps = await getGoalsNeedingFollowUp();
    if (pendingFollowUps.length > 0) {
      logger.info({ count: pendingFollowUps.length }, 'Found goals needing follow-up');
    }

    for (const pending of pendingFollowUps) {
      if (options.dryRun) {
        logger.info({
          slackUserId: pending.slack_user_id,
          goalName: pending.goal_name,
          attemptCount: pending.attempt_count,
          daysSinceLast: pending.days_since_last,
        }, 'DRY RUN: Would send follow-up');
        followUpsSkipped++;
      } else {
        const sent = await sendFollowUp(pending);
        if (sent) {
          followUpsSent++;
        } else {
          followUpsSkipped++;
        }

        // Small delay between messages
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  // Part 2: Reconcile goal outcomes
  if (!options.skipReconciliation) {
    const goalsToReconcile = await getGoalsToReconcile();
    if (goalsToReconcile.length > 0) {
      logger.debug({ count: goalsToReconcile.length }, 'Found goals to reconcile');
    }

    for (const goal of goalsToReconcile) {
      if (options.dryRun) {
        // In dry run, still check but don't update
        logger.debug({
          slackUserId: goal.slack_user_id,
          goalName: goal.goal_name,
        }, 'DRY RUN: Would check goal reconciliation');
        goalsStillPending++;
      } else {
        const achieved = await reconcileGoal(goal);
        if (achieved) {
          goalsReconciled++;
        } else {
          goalsStillPending++;
        }
      }
    }
  }

  if (followUpsSent > 0 || goalsReconciled > 0) {
    logger.info({
      followUpsSent,
      followUpsSkipped,
      goalsReconciled,
      goalsStillPending,
    }, 'Goal follow-up job completed');
  }

  return {
    followUpsSent,
    followUpsSkipped,
    goalsReconciled,
    goalsStillPending,
  };
}

/**
 * Preview what follow-ups would be sent (dry run)
 */
export async function previewFollowUps(): Promise<PendingFollowUp[]> {
  return getGoalsNeedingFollowUp();
}

/**
 * Preview what goals could be reconciled
 */
export async function previewReconciliation(): Promise<ReconcilableGoal[]> {
  return getGoalsToReconcile();
}
