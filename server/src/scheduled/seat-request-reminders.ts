/**
 * Periodic check for stale seat upgrade requests.
 * - At 48 hours: remind org admins
 * - At 7 days: notify the requesting member
 */

import { createLogger } from '../logger.js';
import {
  findStaleSeatRequests,
  markAdminReminderSent,
  markMemberTimeoutNotified,
} from '../db/organization-db.js';
import { sendToOrgAdmins, escapeSlackMrkdwn } from '../slack/org-group-dm.js';
import { sendDirectMessage } from '../slack/client.js';
import { query } from '../db/client.js';
import { getOrgAdminEmails } from '../utils/org-admins.js';
import { WorkOS } from '@workos-inc/node';

const logger = createLogger('seat-request-reminders');

const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startSeatRequestReminders(workos: WorkOS): void {
  if (intervalId) return;

  // Run immediately on startup, then hourly
  runCheck(workos).catch(err => logger.error({ err }, 'Seat request reminder check failed'));

  intervalId = setInterval(() => {
    runCheck(workos).catch(err => logger.error({ err }, 'Seat request reminder check failed'));
  }, CHECK_INTERVAL_MS);

  logger.info('Seat request reminder scheduler started');
}

export function stopSeatRequestReminders(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

async function queryWithRetry() {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await findStaleSeatRequests();
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      logger.warn({ err, attempt: attempt + 1 }, 'DB query failed, retrying');
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}

async function runCheck(workos: WorkOS): Promise<void> {
  const { needsAdminReminder, needsMemberTimeout } = await queryWithRetry();

  // Send admin reminders for 48-hour-old requests
  for (const request of needsAdminReminder) {
    try {
      const adminEmails = await getOrgAdminEmails(workos, request.workos_organization_id);
      if (adminEmails.length > 0) {
        const resourceLabel = request.resource_name || request.resource_type.replace(/_/g, ' ');
        const teamUrl = `${APP_URL}/team?org=${request.workos_organization_id}`;

        await sendToOrgAdmins(request.workos_organization_id, adminEmails, {
          text: `Reminder: pending seat upgrade request`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Reminder: A team member requested contributor access to join *${escapeSlackMrkdwn(resourceLabel)}* 2 days ago. <${teamUrl}|Review request>`,
              },
            },
          ],
        });
      }
      await markAdminReminderSent(request.id);
    } catch (err) {
      logger.warn({ err, requestId: request.id }, 'Failed to send admin reminder for seat request');
    }
  }

  // Notify members after 7 days of no admin response
  for (const request of needsMemberTimeout) {
    try {
      const slackResult = await query<{ slack_user_id: string }>(
        `SELECT slack_user_id FROM slack_user_mappings
         WHERE workos_user_id = $1 AND mapping_status = 'mapped' AND slack_is_deleted = false
         LIMIT 1`,
        [request.workos_user_id]
      );

      if (slackResult.rows.length > 0) {
        await sendDirectMessage(slackResult.rows[0].slack_user_id, {
          text: "Your seat upgrade request hasn't received a response yet. You can reach out to your org admin directly.",
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: "Your seat upgrade request hasn't received a response yet. You can reach out to your org admin directly for faster resolution.",
              },
            },
          ],
        });
      }

      await markMemberTimeoutNotified(request.id);
    } catch (err) {
      logger.warn({ err, requestId: request.id }, 'Failed to send member timeout notification');
    }
  }

  if (needsAdminReminder.length > 0 || needsMemberTimeout.length > 0) {
    logger.info(
      { adminReminders: needsAdminReminder.length, memberTimeouts: needsMemberTimeout.length },
      'Seat request reminders processed'
    );
  }
}
