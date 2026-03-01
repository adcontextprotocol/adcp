import crypto from 'crypto';
import { createLogger } from '../../logger.js';
import { buildDigestContent, hasMinimumContent } from '../services/digest-builder.js';
import {
  createDigest,
  getDigestByDate,
  setReviewMessage,
  markSent,
  markSkipped,
  getDigestEmailRecipients,
  type DigestSendStats,
} from '../../db/digest-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { sendBatchMarketingEmails, type BatchMarketingEmail } from '../../notifications/email.js';
import { renderDigestEmail, renderDigestSlack, renderDigestReview, type DigestSegment } from '../templates/weekly-digest.js';

const logger = createLogger('weekly-digest');
const workingGroupDb = new WorkingGroupDatabase();

const EDITORIAL_SLUG = 'editorial';
const ANNOUNCEMENTS_CHANNEL = process.env.ANNOUNCEMENTS_CHANNEL_ID;

interface WeeklyDigestResult {
  generated: boolean;
  sent: number;
  skipped: boolean;
  error?: string;
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
 * Get today's edition date as YYYY-MM-DD in ET
 */
function getTodayEditionDate(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Main weekly digest job runner.
 * Runs hourly. On Tuesdays:
 * - 7-8am ET: Generates a draft and posts to Editorial channel for review
 * - 10-11am ET: Sends the digest if approved, or marks it skipped
 */
export async function runWeeklyDigestJob(): Promise<WeeklyDigestResult> {
  const result: WeeklyDigestResult = { generated: false, sent: 0, skipped: false };

  const now = new Date();
  const dayOfWeek = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });

  if (dayOfWeek !== 'Tue') {
    return result;
  }

  const etHour = getETHour();
  const editionDate = getTodayEditionDate();

  // Phase 1: Generate draft (7-8am ET)
  if (etHour >= 7 && etHour < 8) {
    return generateDraft(editionDate);
  }

  // Phase 2: Send if approved (10-11am ET)
  if (etHour >= 10 && etHour < 11) {
    return sendApprovedDigest(editionDate);
  }

  return result;
}

/**
 * Generate digest draft and post to Editorial channel for review
 */
async function generateDraft(editionDate: string): Promise<WeeklyDigestResult> {
  const result: WeeklyDigestResult = { generated: false, sent: 0, skipped: false };

  // Check if draft already exists for this week
  const existing = await getDigestByDate(editionDate);
  if (existing) {
    logger.debug({ editionDate }, 'Digest already exists for this date');
    return result;
  }

  // Build content
  const content = await buildDigestContent();

  // Check minimum content threshold
  if (!hasMinimumContent(content)) {
    logger.info({ editionDate }, 'Not enough content for digest this week');
    result.skipped = true;
    return result;
  }

  // Save draft (ON CONFLICT handles race condition if two instances run simultaneously)
  const digest = await createDigest(editionDate, content);
  if (!digest) {
    logger.debug({ editionDate }, 'Digest already created by another instance');
    return result;
  }
  result.generated = true;

  // Post to Editorial working group channel for review
  const editorial = await workingGroupDb.getWorkingGroupBySlug(EDITORIAL_SLUG);
  if (!editorial?.slack_channel_id) {
    logger.error('Editorial working group has no Slack channel configured');
    return result;
  }

  const reviewMessage = renderDigestReview(content, editionDate);
  const postResult = await sendChannelMessage(editorial.slack_channel_id, reviewMessage);

  if (postResult.ok && postResult.ts) {
    await setReviewMessage(digest.id, editorial.slack_channel_id, postResult.ts);
    logger.info({ editionDate, channel: editorial.slack_channel_id }, 'Digest draft posted for review');
  } else {
    logger.error({ error: postResult.error }, 'Failed to post digest review to Editorial channel');
  }

  return result;
}

/**
 * Send the approved digest to all segments, or mark as skipped
 */
async function sendApprovedDigest(editionDate: string): Promise<WeeklyDigestResult> {
  const result: WeeklyDigestResult = { generated: false, sent: 0, skipped: false };

  const digest = await getDigestByDate(editionDate);
  if (!digest) {
    return result;
  }

  // Already sent or skipped
  if (digest.status === 'sent' || digest.status === 'skipped') {
    return result;
  }

  // Not approved yet - skip
  if (digest.status === 'draft') {
    await markSkipped(digest.id);
    result.skipped = true;

    // Notify Editorial channel
    if (digest.review_channel_id && digest.review_message_ts) {
      await sendChannelMessage(digest.review_channel_id, {
        text: `This week's digest was not approved in time and has been skipped.`,
        thread_ts: digest.review_message_ts,
      });
    }

    logger.info({ editionDate }, 'Digest skipped - no approval received');
    return result;
  }

  // Status is 'approved' - send it
  const stats: DigestSendStats = { email_count: 0, slack_count: 0, by_segment: {} };

  // Post to Slack #announcements
  if (ANNOUNCEMENTS_CHANNEL) {
    const slackMessage = renderDigestSlack(digest.content, editionDate);
    const slackResult = await sendChannelMessage(ANNOUNCEMENTS_CHANNEL, slackMessage);
    if (slackResult.ok) {
      stats.slack_count = 1;
    }
  }

  // Prepare and batch-send emails to eligible recipients
  const recipients = await getDigestEmailRecipients();
  const topNewsTitle = digest.content.news?.[0]?.title;
  const subject = topNewsTitle
    ? `${topNewsTitle} + more | AgenticAdvertising.org Weekly`
    : `AgenticAdvertising.org Weekly - ${formatShortDate(editionDate)}`;

  const emailBatch: BatchMarketingEmail[] = [];

  for (const recipient of recipients) {
    const segment: DigestSegment = recipient.has_slack ? 'both' : 'website_only';
    const feedbackId = crypto.randomUUID();
    const { html, text } = renderDigestEmail(digest.content, feedbackId, editionDate, segment, recipient.first_name || undefined);

    emailBatch.push({
      to: recipient.email,
      subject,
      htmlContent: html,
      textContent: text,
      category: 'weekly_digest',
      workosUserId: recipient.workos_user_id,
    });

    stats.by_segment[segment] = (stats.by_segment[segment] || 0) + 1;
  }

  const batchResult = await sendBatchMarketingEmails(emailBatch);
  stats.email_count = batchResult.sent;

  // Adjust segment counts if there were failures
  if (batchResult.failed > 0) {
    stats.by_segment = { total: batchResult.sent };
  }

  // Only mark as sent if at least something was delivered
  if (stats.email_count > 0 || stats.slack_count > 0) {
    await markSent(digest.id, stats);
    result.sent = stats.email_count + stats.slack_count;
  } else {
    logger.error({ editionDate, batchResult }, 'Digest delivery failed - nothing delivered, leaving as approved for retry');
  }

  logger.info(
    { editionDate, emailCount: stats.email_count, slackCount: stats.slack_count },
    'Weekly digest sent',
  );

  // Notify Editorial channel
  if (digest.review_channel_id && digest.review_message_ts) {
    await sendChannelMessage(digest.review_channel_id, {
      text: `Digest sent! ${stats.email_count} emails, ${stats.slack_count} Slack posts.`,
      thread_ts: digest.review_message_ts,
    });
  }

  return result;
}

function formatShortDate(editionDate: string): string {
  const date = new Date(editionDate + 'T12:00:00Z');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
