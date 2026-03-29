/**
 * Working Group Biweekly Digest Job
 *
 * Runs hourly:
 * - Monday before digest week, 9-10am ET: Sends prep emails to WG leaders
 *   highlighting content gaps (missing meeting notes, stale summaries)
 * - Biweekly Wednesdays, 9-10am ET: Builds per-group content, sends to members
 *
 * Uses the existing `working_groups` email preference category for opt-out.
 */

import { createLogger } from '../../logger.js';
import { buildWgDigestContent, getDigestEligibleGroups, checkDigestGaps, getLeaderEmails } from '../services/wg-digest-builder.js';
import {
  createWgDigest,
  getWgDigest,
  markWgDigestSent,
  markWgDigestSkipped,
  getWgDigestRecipients,
} from '../../db/wg-digest-db.js';
import { sendBatchMarketingEmails, type BatchMarketingEmail } from '../../notifications/email.js';
import { renderWgDigestEmail } from '../templates/wg-digest.js';
import { renderWgDigestPrepEmail } from '../templates/wg-digest-prep.js';

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
 * Check if the current week is a biweekly digest week.
 * Uses a Monday reference so Mon and Wed of the same week always agree.
 */
function isBiweeklyDigestWeek(): boolean {
  const now = new Date();
  const REFERENCE_MONDAY_MS = Date.UTC(2024, 0, 1); // 2024-01-01 was a Monday (same week as old Wed reference)
  const weeksSinceRef = Math.floor((now.getTime() - REFERENCE_MONDAY_MS) / (7 * 24 * 60 * 60 * 1000));
  return weeksSinceRef % 2 === 0;
}

function getETDayOfWeek(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
}

function isBiweeklyWednesday(): boolean {
  return getETDayOfWeek() === 'Wed' && isBiweeklyDigestWeek();
}

function isPrepMonday(): boolean {
  return getETDayOfWeek() === 'Mon' && isBiweeklyDigestWeek();
}

/**
 * Send prep emails to WG leaders on Monday, highlighting content gaps.
 */
/**
 * Check if prep was already sent for a group on a given date.
 * Uses a lightweight marker in the wg_digests table with a 'prep:' prefix on edition_date.
 */
async function wasPrepSent(workingGroupId: string, prepDate: string): Promise<boolean> {
  const existing = await getWgDigest(workingGroupId, `prep:${prepDate}`);
  return existing !== null;
}

async function markPrepSent(workingGroupId: string, prepDate: string, groupName: string): Promise<void> {
  await createWgDigest(workingGroupId, `prep:${prepDate}`, {
    groupName,
    summary: null,
    meetingRecaps: [],
    nextMeeting: null,
    activeThreads: [],
    newMembers: [],
  });
}

export async function runWgDigestPrepJob(): Promise<{ groupsChecked: number; emailsSent: number }> {
  const result = { groupsChecked: 0, emailsSent: 0 };

  if (!isPrepMonday()) return result;

  const etHour = getETHour();
  if (etHour < 9 || etHour >= 10) return result;

  const prepDate = getTodayDateET();
  const groups = await getDigestEligibleGroups();
  result.groupsChecked = groups.length;

  for (const group of groups) {
    try {
      if (await wasPrepSent(group.id, prepDate)) continue;

      const gap = await checkDigestGaps(group.id, group.name, group.slug);
      if (!gap) {
        await markPrepSent(group.id, prepDate, group.name);
        continue;
      }

      const leaders = await getLeaderEmails(group.id);
      if (leaders.length === 0) {
        await markPrepSent(group.id, prepDate, group.name);
        continue;
      }

      const emailBatch: BatchMarketingEmail[] = leaders.map(leader => {
        const { html, text, subject } = renderWgDigestPrepEmail(gap, leader.firstName || undefined);
        return {
          to: leader.email,
          subject,
          htmlContent: html,
          textContent: text,
          category: 'working_groups',
          workosUserId: leader.workosUserId,
        };
      });

      const batchResult = await sendBatchMarketingEmails(emailBatch);
      await markPrepSent(group.id, prepDate, group.name);
      result.emailsSent += batchResult.sent;

      logger.info(
        { groupName: group.name, gaps: { meetings: gap.meetingsWithoutNotes.length, missingSummary: gap.missingSummary }, sent: batchResult.sent },
        'WG digest prep sent to leaders',
      );
    } catch (error) {
      logger.error({ err: error, groupId: group.id, groupName: group.name }, 'Failed to send WG digest prep');
    }
  }

  return result;
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
