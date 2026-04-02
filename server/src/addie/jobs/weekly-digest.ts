import { createLogger } from '../../logger.js';
import { buildDigestContent, hasMinimumContent, generateDigestSubject } from '../services/digest-builder.js';
import {
  createDigest,
  getDigestByDate,
  setReviewMessage,
  markSent,
  getDigestEmailRecipients,
  getUserWorkingGroupMap,
  isLegacyContent,
  type DigestContent,
  type DigestRecord,
  type DigestSendStats,
} from '../../db/digest-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { sendChannelMessage } from '../../slack/client.js';
import { sendTrackedBatchMarketingEmails, type TrackedBatchMarketingEmail } from '../../notifications/email.js';
import { renderDigestEmail, renderDigestSlack, renderDigestReview, type DigestSegment } from '../templates/weekly-digest.js';
import { publishDigestAsPerspective } from '../services/digest-publisher.js';

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
export function getETHour(): number {
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
 * - 10am+ ET: Sends the digest if approved, or nudges at 10am if still waiting
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

  // Phase 2: Send if approved, or nudge at 10am (rest of Tuesday)
  if (etHour >= 10) {
    return sendApprovedDigest(editionDate, etHour);
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
    logger.info({ editionDate }, 'Not enough content for The Prompt this week');
    result.skipped = true;
    return result;
  }

  // Save draft
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
    logger.info({ editionDate, channel: editorial.slack_channel_id }, 'The Prompt draft posted for review');
  } else {
    logger.error({ error: postResult.error }, 'Failed to post The Prompt review to Editorial channel');
  }

  return result;
}

/**
 * Check if the approved digest is ready to send, or nudge if still waiting.
 */
async function sendApprovedDigest(editionDate: string, etHour: number): Promise<WeeklyDigestResult> {
  const result: WeeklyDigestResult = { generated: false, sent: 0, skipped: false };

  const digest = await getDigestByDate(editionDate);
  if (!digest) {
    return result;
  }

  if (digest.status === 'sent' || digest.status === 'skipped') {
    return result;
  }

  // Still a draft — nudge once at 10am
  if (digest.status === 'draft') {
    if (etHour >= 10 && etHour < 11 && digest.review_channel_id && digest.review_message_ts) {
      await sendChannelMessage(digest.review_channel_id, {
        text: `This week's Prompt is still waiting for approval. React with :white_check_mark: to send now, or reply in this thread with edits.`,
        thread_ts: digest.review_message_ts,
      });
    }
    return result;
  }

  // Status is 'approved' — send it
  const sendResult = await sendDigest(digest);
  result.sent = sendResult.sent;
  return result;
}

/**
 * Deliver an approved digest via email and Slack.
 * Called from the scheduled job and from the approval handler (for late approvals).
 */
export async function sendDigest(digest: DigestRecord): Promise<{ sent: number }> {
  if (digest.status !== 'approved') {
    logger.error({ digestId: digest.id, status: digest.status }, 'sendDigest called on non-approved digest');
    return { sent: 0 };
  }

  // Only send current-format digests
  if (isLegacyContent(digest.content)) {
    logger.error({ digestId: digest.id }, 'Cannot send legacy-format digest');
    return { sent: 0 };
  }

  const content = digest.content;
  const editionDate = new Date(digest.edition_date).toISOString().split('T')[0];
  const stats: DigestSendStats = { email_count: 0, slack_count: 0, by_segment: {} };

  // Post to Slack #announcements
  if (ANNOUNCEMENTS_CHANNEL) {
    const slackMessage = renderDigestSlack(content, editionDate);
    const slackResult = await sendChannelMessage(ANNOUNCEMENTS_CHANNEL, slackMessage);
    if (slackResult.ok) {
      stats.slack_count = 1;
    }
  }

  // Prepare and batch-send emails
  const recipients = await getDigestEmailRecipients();
  const subject = generateDigestSubject(content);
  const userWGMap = await getUserWorkingGroupMap();

  const emailBatch: TrackedBatchMarketingEmail[] = [];

  for (const recipient of recipients) {
    const segment: DigestSegment = recipient.has_slack ? 'both' : 'website_only';
    const userWGs = userWGMap.get(recipient.workos_user_id);

    emailBatch.push({
      to: recipient.email,
      subject,
      render: (trackingId: string) => {
        const { html, text } = renderDigestEmail(content, trackingId, editionDate, segment, recipient.first_name || undefined, userWGs);
        return { htmlContent: html, textContent: text };
      },
      category: 'weekly_digest',
      workosUserId: recipient.workos_user_id,
      metadata: { edition_date: editionDate, segment },
    });

    stats.by_segment[segment] = (stats.by_segment[segment] || 0) + 1;
  }

  const batchResult = await sendTrackedBatchMarketingEmails(emailBatch);
  stats.email_count = batchResult.sent;

  if (batchResult.failed > 0) {
    stats.by_segment = { total: batchResult.sent };
  }

  // Mark as sent
  if (stats.email_count > 0 || stats.slack_count > 0) {
    await markSent(digest.id, stats);

    // Publish as perspective for SEO/discoverability (non-blocking)
    publishDigestAsPerspective(digest.id, content, editionDate, subject).catch((err) => {
      logger.error({ error: err, digestId: digest.id }, 'Failed to publish digest as perspective');
    });
  } else {
    logger.error({ editionDate, batchResult }, 'The Prompt delivery failed — leaving as approved for retry');
  }

  logger.info(
    { editionDate, emailCount: stats.email_count, slackCount: stats.slack_count },
    'The Prompt sent',
  );

  // Notify Editorial channel
  if (digest.review_channel_id && digest.review_message_ts) {
    await sendChannelMessage(digest.review_channel_id, {
      text: `The Prompt sent! ${stats.email_count} emails, ${stats.slack_count} Slack posts.`,
      thread_ts: digest.review_message_ts,
    });
  }

  return { sent: stats.email_count + stats.slack_count };
}
