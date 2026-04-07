/**
 * Shared Newsletter Send Pipeline
 *
 * Handles the send flow for any registered newsletter: Slack announcement,
 * batch email delivery, perspective publishing, and cover image generation.
 */

import { createLogger } from '../logger.js';
import type { NewsletterConfig, EditionRecord, SendStats } from './config.js';
import { getPersonaCluster } from '../db/digest-db.js';
import { sendChannelMessage } from '../slack/client.js';
import { sendTrackedBatchMarketingEmails, type TrackedBatchMarketingEmail } from '../notifications/email.js';
import { proposeContentForUser, type ContentUser } from '../routes/content.js';
import { generateIllustration } from '../services/illustration-generator.js';
import { createIllustration, approveIllustration } from '../db/illustration-db.js';

const logger = createLogger('newsletter-send');

/**
 * Send a newsletter edition to all recipients.
 * Returns the number of emails sent.
 */
export async function sendNewsletter(
  config: NewsletterConfig,
  edition: EditionRecord,
): Promise<{ sent: number }> {
  const content = edition.content;
  const editionDate = edition.edition_date.toISOString().split('T')[0];
  const subject = config.generateSubject(content);
  const bySegment: Record<string, number> = {};
  const stats: SendStats = { email_count: 0, slack_count: 0, by_segment: bySegment };

  // Post to Slack announcements
  const announcementChannel = process.env[config.announcementChannelEnvVar];
  if (announcementChannel) {
    const slackMessage = config.renderSlack(content, editionDate);
    const slackResult = await sendChannelMessage(announcementChannel, slackMessage);
    if (slackResult.ok) stats.slack_count = 1;
  }

  // Batch send emails
  const recipients = await config.db.getRecipients();
  const userWGMap = await config.db.getUserWorkingGroupMap();
  const emailBatch: TrackedBatchMarketingEmail[] = [];

  for (const recipient of recipients) {
    const segment = recipient.has_slack ? 'both' : 'website_only';
    const userWGs = userWGMap.get(recipient.workos_user_id);
    const cluster = getPersonaCluster(recipient.persona);

    emailBatch.push({
      to: recipient.email,
      subject,
      render: (trackingId: string) => {
        const { html, text } = config.renderEmail(content, trackingId, editionDate, segment, recipient.first_name || undefined, userWGs, cluster, recipient);
        return { htmlContent: html, textContent: text };
      },
      category: config.emailCategory,
      workosUserId: recipient.workos_user_id,
      metadata: { edition_date: editionDate, segment },
      from: config.fromEmail,
    });

    bySegment[segment] = (bySegment[segment] || 0) + 1;
  }

  const batchResult = await sendTrackedBatchMarketingEmails(emailBatch);
  stats.email_count = batchResult.sent;

  if (batchResult.failed > 0) {
    stats.by_segment = { total: batchResult.sent };
  }

  // Mark as sent
  if (stats.email_count > 0 || stats.slack_count > 0) {
    await config.db.markSent(edition.id, stats);

    // Publish as perspective (non-blocking)
    publishAsPerspective(config, edition.id, content, editionDate, subject).catch((err) => {
      logger.error({ error: err, newsletterId: config.id, editionId: edition.id }, 'Failed to publish as perspective');
    });
  } else {
    logger.error({ editionDate, newsletterId: config.id }, 'Newsletter delivery failed — leaving as approved for retry');
  }

  logger.info(
    { newsletterId: config.id, editionDate, emailCount: stats.email_count, slackCount: stats.slack_count },
    'Newsletter sent',
  );

  // Notify review channel
  if (edition.review_channel_id && edition.review_message_ts) {
    await sendChannelMessage(edition.review_channel_id, {
      text: `${config.name} sent! ${stats.email_count} emails, ${stats.slack_count} Slack posts.`,
      thread_ts: edition.review_message_ts,
    });
  }

  return { sent: stats.email_count };
}

// ─── Perspective Publishing ────────────────────────────────────────────

async function publishAsPerspective(
  config: NewsletterConfig,
  editionId: number,
  content: unknown,
  editionDate: string,
  subject: string,
): Promise<void> {
  const authorUser: ContentUser = {
    id: config.authorSystemId,
    email: `${config.author.toLowerCase()}@agenticadvertising.org`,
  };

  const result = await proposeContentForUser(authorUser, {
    title: subject,
    content_type: 'article',
    content: config.buildMarkdown(content),
    excerpt: typeof (content as Record<string, unknown>).openingTake === 'string'
      ? (content as Record<string, string>).openingTake
      : typeof (content as Record<string, unknown>).statusLine === 'string'
        ? (content as Record<string, string>).statusLine
        : '',
    category: config.perspectiveCategory,
    tags: config.extractTags(content),
    content_origin: 'official',
    collection: { committee_slug: 'editorial' },
    authors: [{
      user_id: config.authorSystemId,
      display_name: config.author,
      display_title: config.authorTitle,
      display_order: 0,
    }],
  });

  if (!result.success || !result.id) {
    logger.error({ error: result.error, editionDate, newsletterId: config.id }, 'Failed to create perspective');
    return;
  }

  await config.db.setPerspectiveId(editionId, result.id);
  logger.info({ editionId, perspectiveId: result.id, slug: result.slug }, 'Published as perspective');

  // Generate cover image (non-blocking)
  generateCoverImage(config, result.id, subject, editionDate).catch((err) => {
    logger.warn({ error: err, perspectiveId: result.id }, 'Failed to generate cover image');
  });
}

async function generateCoverImage(
  config: NewsletterConfig,
  perspectiveId: string,
  title: string,
  editionDate: string,
): Promise<void> {
  const { imageBuffer, promptUsed } = await generateIllustration({
    title,
    category: config.perspectiveCategory,
    editionDate,
  });

  const illustration = await createIllustration({
    perspective_id: perspectiveId,
    image_data: imageBuffer,
    prompt_used: promptUsed,
    status: 'generated',
  });

  await approveIllustration(illustration.id, perspectiveId);
  logger.info({ perspectiveId, newsletterId: config.id }, 'Cover image generated');
}
