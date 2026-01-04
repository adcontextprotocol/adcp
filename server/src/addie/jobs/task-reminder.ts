/**
 * Task Reminder Job
 *
 * Sends proactive DMs to admins about their upcoming and overdue tasks.
 * Runs daily (or on-demand) to remind users about:
 * - Overdue tasks (past due date)
 * - Tasks due today
 * - Tasks due tomorrow (optional heads-up)
 */

import { logger } from '../../logger.js';
import { query } from '../../db/client.js';

/** Engagement score threshold for "hot" prospects (🔥 indicator) */
const HOT_ENGAGEMENT_THRESHOLD = 30;

interface TaskReminder {
  user_id: string;
  user_name: string;
  user_email: string;
  slack_user_id: string | null;
  org_id: string;
  org_name: string;
  task_description: string;
  due_date: Date;
  days_until_due: number;
  engagement_score: number;
}

interface ReminderBatch {
  user_id: string;
  user_name: string;
  slack_user_id: string | null;
  overdue: TaskReminder[];
  today: TaskReminder[];
  tomorrow: TaskReminder[];
}

/**
 * Get all tasks that need reminders, grouped by user
 */
async function getTasksNeedingReminders(): Promise<ReminderBatch[]> {
  // Get tasks from org_activities (explicit reminders)
  const activityTasks = await query<TaskReminder>(
    `SELECT
      oa.next_step_owner_user_id as user_id,
      oa.next_step_owner_name as user_name,
      u.email as user_email,
      sm.slack_user_id,
      o.workos_organization_id as org_id,
      o.name as org_name,
      oa.description as task_description,
      oa.next_step_due_date as due_date,
      (oa.next_step_due_date - CURRENT_DATE)::integer as days_until_due,
      COALESCE(o.engagement_score, 0) as engagement_score
    FROM org_activities oa
    JOIN organizations o ON o.workos_organization_id = oa.organization_id
    LEFT JOIN users u ON u.workos_user_id = oa.next_step_owner_user_id
    LEFT JOIN slack_user_mappings sm ON sm.workos_user_id = oa.next_step_owner_user_id
    WHERE oa.is_next_step = TRUE
      AND oa.next_step_completed_at IS NULL
      AND oa.next_step_due_date IS NOT NULL
      AND oa.next_step_due_date <= CURRENT_DATE + 1  -- Due today, tomorrow, or overdue
      AND oa.next_step_owner_user_id IS NOT NULL
    ORDER BY oa.next_step_due_date ASC`
  );

  // Get tasks from organizations table (for owned prospects)
  const orgTasks = await query<TaskReminder>(
    `SELECT
      os.user_id,
      os.user_name,
      os.user_email,
      sm.slack_user_id,
      o.workos_organization_id as org_id,
      o.name as org_name,
      o.prospect_next_action as task_description,
      o.prospect_next_action_date as due_date,
      (o.prospect_next_action_date - CURRENT_DATE)::integer as days_until_due,
      COALESCE(o.engagement_score, 0) as engagement_score
    FROM organizations o
    JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id AND os.role = 'owner'
    LEFT JOIN slack_user_mappings sm ON sm.workos_user_id = os.user_id
    WHERE o.prospect_next_action IS NOT NULL
      AND o.prospect_next_action_date IS NOT NULL
      AND o.prospect_next_action_date <= CURRENT_DATE + 1  -- Due today, tomorrow, or overdue
      AND o.is_personal IS NOT TRUE
      -- Don't include if there's already an activity-based task for this org
      AND NOT EXISTS (
        SELECT 1 FROM org_activities oa
        WHERE oa.organization_id = o.workos_organization_id
          AND oa.is_next_step = TRUE
          AND oa.next_step_completed_at IS NULL
          AND oa.next_step_due_date = o.prospect_next_action_date
      )
    ORDER BY o.prospect_next_action_date ASC`
  );

  // Combine and group by user
  const allTasks = [...activityTasks.rows, ...orgTasks.rows];
  const byUser = new Map<string, ReminderBatch>();

  for (const task of allTasks) {
    if (!task.user_id) continue;

    if (!byUser.has(task.user_id)) {
      byUser.set(task.user_id, {
        user_id: task.user_id,
        user_name: task.user_name,
        slack_user_id: task.slack_user_id,
        overdue: [],
        today: [],
        tomorrow: [],
      });
    }

    const batch = byUser.get(task.user_id)!;
    if (task.days_until_due < 0) {
      batch.overdue.push(task);
    } else if (task.days_until_due === 0) {
      batch.today.push(task);
    } else {
      batch.tomorrow.push(task);
    }
  }

  return Array.from(byUser.values());
}

/**
 * Build a reminder message for a user
 */
function buildReminderMessage(batch: ReminderBatch): string {
  const parts: string[] = [];

  if (batch.overdue.length > 0) {
    parts.push(`⚠️ *Overdue Tasks* (${batch.overdue.length})`);
    for (const task of batch.overdue) {
      const daysOverdue = Math.abs(task.days_until_due);
      const hot = task.engagement_score >= HOT_ENGAGEMENT_THRESHOLD ? ' 🔥' : '';
      parts.push(`• *${task.org_name}*${hot}: ${task.task_description} (${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue)`);
    }
    parts.push('');
  }

  if (batch.today.length > 0) {
    parts.push(`📌 *Due Today* (${batch.today.length})`);
    for (const task of batch.today) {
      const hot = task.engagement_score >= HOT_ENGAGEMENT_THRESHOLD ? ' 🔥' : '';
      parts.push(`• *${task.org_name}*${hot}: ${task.task_description}`);
    }
    parts.push('');
  }

  if (batch.tomorrow.length > 0) {
    parts.push(`📅 *Due Tomorrow* (${batch.tomorrow.length})`);
    for (const task of batch.tomorrow) {
      const hot = task.engagement_score >= HOT_ENGAGEMENT_THRESHOLD ? ' 🔥' : '';
      parts.push(`• *${task.org_name}*${hot}: ${task.task_description}`);
    }
    parts.push('');
  }

  parts.push('_Reply with "my tasks" or "what\'s on my plate" to see all your tasks._');

  return parts.join('\n');
}

/**
 * Send a reminder DM via Slack
 */
async function sendReminderDm(slackUserId: string, message: string): Promise<boolean> {
  const token = process.env.ADDIE_BOT_TOKEN;
  if (!token) {
    logger.warn('ADDIE_BOT_TOKEN not configured - cannot send task reminders');
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
      logger.warn({ error: openData.error, slackUserId }, 'Failed to open DM channel for reminder');
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
      logger.warn({ error: sendData.error, slackUserId }, 'Failed to send reminder message');
      return false;
    }

    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error sending reminder DM');
    return false;
  }
}

/**
 * Check if reminders were already sent today to avoid spam
 */
async function wasReminderSentToday(userId: string): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM task_reminder_log
     WHERE user_id = $1
       AND sent_at >= CURRENT_DATE`,
    [userId]
  );
  return parseInt(result.rows[0]?.count || '0', 10) > 0;
}

/**
 * Log that a reminder was sent
 */
async function logReminderSent(userId: string, taskCount: number): Promise<void> {
  await query(
    `INSERT INTO task_reminder_log (user_id, task_count, sent_at)
     VALUES ($1, $2, NOW())`,
    [userId, taskCount]
  );
}

/**
 * Run the task reminder job
 * Sends DMs to users with overdue or due-today tasks
 */
export async function runTaskReminderJob(options: {
  includeTomorrow?: boolean;
  dryRun?: boolean;
  forceResend?: boolean;
} = {}): Promise<{
  usersChecked: number;
  remindersSent: number;
  skipped: number;
  errors: number;
}> {
  const { includeTomorrow = false, dryRun = false, forceResend = false } = options;

  logger.info({ includeTomorrow, dryRun, forceResend }, 'Running task reminder job');

  const batches = await getTasksNeedingReminders();
  let remindersSent = 0;
  let skipped = 0;
  let errors = 0;

  for (const batch of batches) {
    // Skip if no Slack user ID
    if (!batch.slack_user_id) {
      logger.debug({ userId: batch.user_id }, 'Skipping reminder - no Slack user ID');
      skipped++;
      continue;
    }

    // Skip tomorrow tasks unless explicitly requested
    if (!includeTomorrow && batch.overdue.length === 0 && batch.today.length === 0) {
      skipped++;
      continue;
    }

    // Check if already sent today (unless forced)
    if (!forceResend && !dryRun) {
      const alreadySent = await wasReminderSentToday(batch.user_id);
      if (alreadySent) {
        logger.debug({ userId: batch.user_id }, 'Skipping reminder - already sent today');
        skipped++;
        continue;
      }
    }

    const taskCount = batch.overdue.length + batch.today.length + (includeTomorrow ? batch.tomorrow.length : 0);
    if (taskCount === 0) {
      skipped++;
      continue;
    }

    const message = buildReminderMessage({
      ...batch,
      tomorrow: includeTomorrow ? batch.tomorrow : [],
    });

    if (dryRun) {
      logger.info({
        userId: batch.user_id,
        userName: batch.user_name,
        slackUserId: batch.slack_user_id,
        overdue: batch.overdue.length,
        today: batch.today.length,
        tomorrow: includeTomorrow ? batch.tomorrow.length : 0,
        message: message.substring(0, 200) + '...',
      }, 'DRY RUN: Would send reminder');
      remindersSent++;
      continue;
    }

    const success = await sendReminderDm(batch.slack_user_id, message);
    if (success) {
      await logReminderSent(batch.user_id, taskCount);
      logger.info({
        userId: batch.user_id,
        taskCount,
      }, 'Sent task reminder');
      remindersSent++;
    } else {
      errors++;
    }

    // Small delay between messages
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logger.info({
    usersChecked: batches.length,
    remindersSent,
    skipped,
    errors,
  }, 'Task reminder job completed');

  return {
    usersChecked: batches.length,
    remindersSent,
    skipped,
    errors,
  };
}

/**
 * Preview what reminders would be sent (dry run)
 */
export async function previewTaskReminders(): Promise<ReminderBatch[]> {
  return getTasksNeedingReminders();
}
