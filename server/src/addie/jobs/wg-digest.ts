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
  // WG digest content is now consolidated into The Prompt weekly newsletter
  logger.info('WG digest prep disabled — content consolidated into The Prompt');
  return { groupsChecked: 0, emailsSent: 0 };
}

export async function runWgDigestJob(): Promise<WgDigestResult> {
  // WG digest content is now consolidated into The Prompt weekly newsletter
  logger.info('WG digest disabled — content consolidated into The Prompt');
  return { groupsChecked: 0, groupsSent: 0, groupsSkipped: 0, totalEmails: 0 };
}
