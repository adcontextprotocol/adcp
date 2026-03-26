/**
 * Working Group Biweekly Digest Job
 *
 * Runs hourly. On alternating Wednesdays (offset from Tuesday general digest):
 * - 9-10am ET: Builds per-group content, sends to eligible members
 *
 * Uses the existing `working_groups` email preference category for opt-out.
 */

import { createLogger } from '../../logger.js';
import { buildWgDigestContent, getDigestEligibleGroups } from '../services/wg-digest-builder.js';
import {
  createWgDigest,
  getWgDigest,
  markWgDigestSent,
  markWgDigestSkipped,
  getWgDigestRecipients,
} from '../../db/wg-digest-db.js';
import { sendBatchMarketingEmails, type BatchMarketingEmail } from '../../notifications/email.js';
import { renderWgDigestEmail } from '../templates/wg-digest.js';

const logger = createLogger('wg-digest');

export interface WgDigestResult {
  groupsChecked: number;
  groupsSent: number;
  groupsSkipped: number;
  totalEmails: number;
}

/**
 * Get the current hour in US Eastern time
 */
function getETHour(): number {
  const now = new Date();
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  return parseInt(etString, 10);
}

/**
 * Get today's date as YYYY-MM-DD in ET
 */
function getTodayDateET(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Check if today is a biweekly Wednesday.
 * Counts weeks since a fixed reference Wednesday (2024-01-03) and sends on even-count weeks.
 */
function isBiweeklyWednesday(): boolean {
  const now = new Date();
  const dayOfWeek = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (dayOfWeek !== 'Wed') return false;

  const REFERENCE_WEDNESDAY_MS = Date.UTC(2024, 0, 3); // 2024-01-03 was a Wednesday
  const weeksSinceRef = Math.floor((now.getTime() - REFERENCE_WEDNESDAY_MS) / (7 * 24 * 60 * 60 * 1000));
  return weeksSinceRef % 2 === 0;
}

export async function runWgDigestJob(): Promise<WgDigestResult> {
  const result: WgDigestResult = { groupsChecked: 0, groupsSent: 0, groupsSkipped: 0, totalEmails: 0 };

  if (!isBiweeklyWednesday()) return result;

  const etHour = getETHour();
  if (etHour < 9 || etHour >= 10) return result;

  const editionDate = getTodayDateET();
  const groups = await getDigestEligibleGroups();
  result.groupsChecked = groups.length;

  for (const group of groups) {
    try {
      // Skip if already processed
      const existing = await getWgDigest(group.id, editionDate);
      if (existing) {
        if (existing.status === 'sent') result.groupsSent++;
        if (existing.status === 'skipped') result.groupsSkipped++;
        continue;
      }

      // Build content
      const content = await buildWgDigestContent(group.id);
      if (!content) {
        // Nothing to send — create skipped record
        const record = await createWgDigest(group.id, editionDate, {
          groupName: group.name,
          summary: null,
          meetingRecaps: [],
          nextMeeting: null,
          activeThreads: [],
          newMembers: [],
        });
        if (record) await markWgDigestSkipped(record.id);
        result.groupsSkipped++;
        continue;
      }

      // Create digest record
      const record = await createWgDigest(group.id, editionDate, content);
      if (!record) {
        // Race condition — another instance handled it
        continue;
      }

      // Get recipients and send
      const recipients = await getWgDigestRecipients(group.id);
      if (recipients.length === 0) {
        await markWgDigestSkipped(record.id);
        result.groupsSkipped++;
        continue;
      }

      const emailBatch: BatchMarketingEmail[] = [];
      for (const recipient of recipients) {
        const { html, text, subject } = renderWgDigestEmail(content, group.slug, recipient.first_name || undefined);
        emailBatch.push({
          to: recipient.email,
          subject,
          htmlContent: html,
          textContent: text,
          category: 'working_groups',
          workosUserId: recipient.workos_user_id,
        });
      }

      const batchResult = await sendBatchMarketingEmails(emailBatch);
      await markWgDigestSent(record.id, batchResult.sent);

      result.groupsSent++;
      result.totalEmails += batchResult.sent;

      logger.info(
        { groupName: group.name, sent: batchResult.sent, skipped: batchResult.skipped },
        'WG digest sent',
      );
    } catch (error) {
      logger.error({ err: error, groupId: group.id, groupName: group.name }, 'Failed to process WG digest');
    }
  }

  return result;
}
