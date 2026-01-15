/**
 * Webhook routes for external services
 *
 * Handles incoming webhooks from services like Resend.
 * All routes are mounted under /api/webhooks/
 */

import { Router, Request, Response } from 'express';
import { Webhook } from 'svix';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { createLogger } from '../logger.js';
import { getPool } from '../db/client.js';
import { ModelConfig } from '../config/models.js';
import { verifyWebhookSignature as verifyZoomSignature } from '../integrations/zoom.js';
import { handleRecordingCompleted } from '../services/meeting-service.js';
import {
  getFeedByEmailSlug,
  createEmailPerspective,
} from '../db/industry-feeds-db.js';
import {
  parseWebhookPayload as parseLumaWebhook,
  type LumaWebhookPayload,
} from '../luma/client.js';
import { eventsDb } from '../db/events-db.js';
import {
  upsertEmailContact,
  parseEmailAddress,
  type EmailContactResult,
} from '../db/contacts-db.js';
import {
  handleEmailInvocation,
  type InboundEmailContext,
} from '../addie/email-handler.js';
import {
  parseForwardedEmailHeaders,
  formatEmailAddress,
  mergeAddresses,
} from '../utils/forwarded-email-parser.js';
import {
  processInteraction,
  type InteractionContext,
} from '../addie/services/interaction-analyzer.js';

const logger = createLogger('webhooks');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Initialize Anthropic client for insight extraction
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Log configuration on module load
logger.info({
  resendConfigured: !!RESEND_API_KEY,
  webhookSecretConfigured: !!RESEND_WEBHOOK_SECRET,
  anthropicConfigured: !!anthropic,
  fastModel: ModelConfig.fast,
}, 'Inbound email webhook configuration');

/**
 * Resend inbound email webhook payload
 */
interface ResendInboundPayload {
  type: 'email.received';
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message_id: string;
    attachments?: Array<{
      id: string;
      filename: string;
      content_type: string;
    }>;
  };
}

/**
 * Addie email context types
 * Parsed from subaddressing like addie+prospect@agenticadvertising.org
 * or feed-<slug>@updates.agenticadvertising.org for newsletter subscriptions
 */
type AddieContext =
  | { type: 'prospect' }
  | { type: 'working-group'; groupId: string }
  | { type: 'feed'; slug: string }
  | { type: 'unrouted' };

/**
 * Parse Addie context from email addresses
 * Looks for addie+context@agenticadvertising.org patterns in TO/CC
 * or feed-<slug>@updates.agenticadvertising.org for newsletter subscriptions
 *
 * Examples:
 *   addie+prospect@agenticadvertising.org → { type: 'prospect' }
 *   addie+wg-governance@agenticadvertising.org → { type: 'working-group', groupId: 'governance' }
 *   feed-adexchanger@updates.agenticadvertising.org → { type: 'feed', slug: 'feed-adexchanger' }
 *   addie@agenticadvertising.org → { type: 'unrouted' }
 */
function parseAddieContext(toAddresses: string[], ccAddresses: string[] = []): AddieContext {
  const allAddresses = [...toAddresses, ...ccAddresses];

  for (const addr of allAddresses) {
    const { email } = parseEmailAddress(addr);

    // Check for feed subscription emails (feed-*@updates.agenticadvertising.org)
    if (email.endsWith('@updates.agenticadvertising.org')) {
      const localPart = email.split('@')[0];
      if (localPart.startsWith('feed-')) {
        return { type: 'feed', slug: localPart };
      }
    }

    // Check if this is an addie address (either domain)
    if (!email.endsWith('@agenticadvertising.org') && !email.endsWith('@updates.agenticadvertising.org')) continue;
    const localPart = email.split('@')[0];
    if (!localPart.startsWith('addie')) continue;

    // Check for subaddressing (addie+context)
    const plusIndex = localPart.indexOf('+');
    if (plusIndex === -1) {
      // Plain addie@ address
      continue;
    }

    const context = localPart.substring(plusIndex + 1);

    if (context === 'prospect') {
      return { type: 'prospect' };
    }

    if (context.startsWith('wg-')) {
      return { type: 'working-group', groupId: context.substring(3) };
    }

    // Unknown context, log and treat as unrouted
    logger.warn({ context, email }, 'Unknown Addie context in email address');
  }

  return { type: 'unrouted' };
}

/**
 * Check if an email address is an AAO-owned address
 */
function isOwnAddress(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain === 'agenticadvertising.org' || domain === 'updates.agenticadvertising.org';
}

/**
 * Get all external (non-AAO) email addresses from an email
 * Returns parsed info for each external participant
 */
function getExternalParticipants(
  from: string,
  toAddresses: string[],
  ccAddresses: string[] = []
): Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }> {
  const participants: Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }> = [];
  const seenEmails = new Set<string>();

  // Check sender
  const senderParsed = parseEmailAddress(from);
  if (!isOwnAddress(senderParsed.email) && !seenEmails.has(senderParsed.email)) {
    seenEmails.add(senderParsed.email);
    participants.push({ ...senderParsed, role: 'sender' });
  }

  // Check TO recipients
  for (const addr of toAddresses) {
    const parsed = parseEmailAddress(addr);
    if (!isOwnAddress(parsed.email) && !seenEmails.has(parsed.email)) {
      seenEmails.add(parsed.email);
      participants.push({ ...parsed, role: 'recipient' });
    }
  }

  // Check CC recipients
  for (const addr of ccAddresses) {
    const parsed = parseEmailAddress(addr);
    if (!isOwnAddress(parsed.email) && !seenEmails.has(parsed.email)) {
      seenEmails.add(parsed.email);
      participants.push({ ...parsed, role: 'cc' });
    }
  }

  return participants;
}

/**
 * Parse a comma-separated email header into individual addresses
 * Handles formats like: "John Doe" <john@example.com>, jane@example.com
 * Splits on commas that aren't inside quoted strings (display names)
 */
function parseEmailHeaderList(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  // Split on comma followed by optional space, but not commas inside quoted strings
  // This regex splits on commas that are followed by text that doesn't have unbalanced quotes
  return headerValue
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(addr => addr.trim())
    .filter(Boolean);
}

// parseEmailAddress is now imported from contacts-db.js

/**
 * Get or create an email contact from pre-parsed participant info
 * Wrapper around shared upsertEmailContact for backwards compatibility
 */
async function getOrCreateEmailContact(
  participant: { email: string; displayName: string | null; domain: string }
): Promise<{
  contactId: string;
  organizationId: string | null;
  workosUserId: string | null;
  isNew: boolean;
  email: string;
  domain: string;
}> {
  const result = await upsertEmailContact({
    email: participant.email,
    displayName: participant.displayName,
    domain: participant.domain,
  });

  return {
    contactId: result.contactId,
    organizationId: result.organizationId,
    workosUserId: result.workosUserId,
    isNew: result.isNew,
    email: result.email,
    domain: result.domain,
  };
}

/**
 * Create/update contacts for all external participants
 * Returns array of contact info for tracking
 */
async function ensureContactsForParticipants(
  participants: Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }>
): Promise<Array<{
  contactId: string;
  organizationId: string | null;
  workosUserId: string | null;
  email: string;
  domain: string;
  role: 'sender' | 'recipient' | 'cc';
  isNew: boolean;
}>> {
  const contacts: Array<{
    contactId: string;
    organizationId: string | null;
    workosUserId: string | null;
    email: string;
    domain: string;
    role: 'sender' | 'recipient' | 'cc';
    isNew: boolean;
  }> = [];

  for (const participant of participants) {
    try {
      const contact = await getOrCreateEmailContact(participant);
      contacts.push({ ...contact, role: participant.role });
    } catch (error) {
      logger.warn({ error, email: participant.email }, 'Failed to create contact for participant');
    }
  }

  return contacts;
}

interface ResendEmailResponse {
  text?: string;
  html?: string;
  headers?: {
    to?: string;
    cc?: string;
    from?: string;
    [key: string]: string | undefined;
  };
}

interface FetchEmailResult {
  text?: string;
  html?: string;
  textLength?: number;
  originalTo?: string[];
  originalCc?: string[];
}

/**
 * Fetch email body and headers from Resend API
 * The headers contain original TO/CC recipients that aren't in the webhook payload
 */
async function fetchEmailBody(emailId: string): Promise<FetchEmailResult | null> {
  if (!RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not configured, cannot fetch email body');
    return null;
  }

  const startTime = Date.now();
  logger.debug({ emailId }, 'Fetching email body from Resend');

  try {
    const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        status: response.status,
        emailId,
        durationMs,
        errorBody: errorBody.substring(0, 500),
      }, 'Failed to fetch email from Resend API');
      return null;
    }

    const data = (await response.json()) as ResendEmailResponse;
    const textLength = data.text?.length || 0;
    const htmlLength = data.html?.length || 0;

    // Parse original recipients from headers (these contain the real TO/CC, not just Resend addresses)
    // Headers can contain multiple comma-separated addresses like: "John Doe" <john@example.com>, jane@example.com
    const originalTo = parseEmailHeaderList(data.headers?.to);
    const originalCc = parseEmailHeaderList(data.headers?.cc);

    logger.info({
      emailId,
      durationMs,
      hasText: !!data.text,
      hasHtml: !!data.html,
      textLength,
      htmlLength,
      hasOriginalTo: originalTo.length > 0,
      hasOriginalCc: originalCc.length > 0,
      originalTo,
      originalCc,
    }, 'Fetched email body from Resend');

    return {
      text: data.text,
      html: data.html,
      textLength,
      originalTo,
      originalCc,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error({ error, emailId, durationMs }, 'Error fetching email body from Resend');
    return null;
  }
}

/**
 * System prompt for email insight extraction
 */
const EMAIL_INSIGHT_PROMPT = `You are Addie, the AI assistant for AgenticAdvertising.org. You're analyzing an email that was CC'd to you to extract insights about member communications.

Your goal is to extract:
1. **Key topics discussed** - What is the email about?
2. **Pitch elements** - Any messaging about AAO or AdCP that worked or was used
3. **Member interests** - What does this tell us about what the member/prospect cares about?
4. **Action items** - Any follow-ups or commitments mentioned
5. **Sentiment** - Is the tone positive, neutral, or concerned?

Output a concise summary (2-4 sentences) focusing on the most important insights.
Do NOT include the raw email content - just the extracted insights.
If this appears to be a transactional email (receipts, notifications, etc.) just note that briefly.`;

/**
 * Extract insights from email content using Claude
 */
async function extractInsightsWithClaude(data: {
  from: string;
  subject: string;
  text?: string;
  to: string[];
  cc?: string[];
}): Promise<{ insights: string; method: 'claude' | 'simple'; tokensUsed?: number }> {
  if (!anthropic) {
    logger.info('Anthropic client not configured, using simple extraction');
    return { insights: extractInsightsSimple(data), method: 'simple' };
  }

  if (!data.text) {
    logger.info('No email text content, using simple extraction');
    return { insights: extractInsightsSimple(data), method: 'simple' };
  }

  const startTime = Date.now();
  logger.info({
    from: data.from,
    subject: data.subject,
    textLength: data.text.length,
    model: ModelConfig.fast,
  }, 'Extracting insights with Claude');

  try {
    const emailContent = `
From: ${data.from}
To: ${data.to.join(', ')}
${data.cc?.length ? `CC: ${data.cc.join(', ')}` : ''}
Subject: ${data.subject}

${data.text}
`.trim();

    // Add timeout to prevent webhook from hanging
    const timeoutMs = 25000; // 25 seconds
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Anthropic API timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    logger.info({ model: ModelConfig.fast, contentLength: emailContent.length }, 'Calling Anthropic API');

    const response = await Promise.race([
      anthropic.messages.create({
        model: ModelConfig.fast,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Please analyze this email and extract insights:\n\n${emailContent}`,
          },
        ],
        system: EMAIL_INSIGHT_PROMPT,
      }),
      timeoutPromise,
    ]);

    const durationMs = Date.now() - startTime;
    const textBlock = response.content.find(block => block.type === 'text');

    if (textBlock && textBlock.type === 'text') {
      const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
      logger.info({
        durationMs,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        tokensUsed,
        insightLength: textBlock.text.length,
        model: ModelConfig.fast,
      }, 'Claude insight extraction completed');

      return { insights: textBlock.text, method: 'claude', tokensUsed };
    }

    logger.warn({ durationMs }, 'Claude returned no text block, falling back to simple extraction');
    return { insights: extractInsightsSimple(data), method: 'simple' };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error({ error, durationMs }, 'Failed to extract insights with Claude, falling back to simple extraction');
    return { insights: extractInsightsSimple(data), method: 'simple' };
  }
}

/**
 * Simple insight extraction fallback (no LLM)
 */
function extractInsightsSimple(data: {
  from: string;
  subject: string;
  text?: string;
}): string {
  const parts: string[] = [];

  if (data.subject) {
    parts.push(`Subject: ${data.subject}`);
  }

  if (data.from) {
    parts.push(`From: ${data.from}`);
  }

  if (data.text) {
    let cleanText = data.text
      .split(/^--\s*$/m)[0]
      .split(/^>+/m)[0]
      .split(/^On .* wrote:$/m)[0]
      .trim();

    if (cleanText.length > 500) {
      cleanText = cleanText.substring(0, 500) + '...';
    }

    if (cleanText) {
      parts.push(`Content: ${cleanText}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Verify Resend webhook signature using Svix
 */
function verifyResendWebhook(req: Request, rawBody: string): boolean {
  if (!RESEND_WEBHOOK_SECRET) {
    logger.warn('RESEND_WEBHOOK_SECRET not configured, skipping signature verification (dev mode)');
    return true;
  }

  const svixId = req.headers['svix-id'] as string | undefined;
  const svixTimestamp = req.headers['svix-timestamp'] as string | undefined;
  const svixSignature = req.headers['svix-signature'] as string | undefined;

  if (!svixId || !svixTimestamp || !svixSignature) {
    logger.warn({
      hasSvixId: !!svixId,
      hasSvixTimestamp: !!svixTimestamp,
      hasSvixSignature: !!svixSignature,
    }, 'Missing Svix headers for webhook verification');
    return false;
  }

  try {
    const wh = new Webhook(RESEND_WEBHOOK_SECRET);
    wh.verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
    logger.debug({ svixId }, 'Webhook signature verified successfully');
    return true;
  } catch (error) {
    logger.error({ error, svixId }, 'Webhook signature verification failed');
    return false;
  }
}

/**
 * Handle prospect context emails (addie+prospect@)
 *
 * Creates/updates contacts for ALL external participants and stores
 * one activity record with the full context in metadata.
 */
async function handleProspectEmail(data: ResendInboundPayload['data']): Promise<{
  activityId: string;
  contacts: Array<{ contactId: string; workosUserId: string | null; organizationId: string | null; email: string; role: string; isNew: boolean }>;
  insights: string;
  method: string;
  tokensUsed?: number;
  // Email content for potential Addie invocation
  emailContent?: {
    text?: string;
    html?: string;
    messageId: string;
    to: string[];
    cc?: string[];
  };
}> {
  const pool = getPool();

  // Fetch email body and original headers first
  // The Resend API returns original TO/CC in headers, which aren't in the webhook payload
  const emailBody = await fetchEmailBody(data.email_id);

  // Use original recipients from headers if available, otherwise fall back to webhook data
  let toAddresses = emailBody?.originalTo?.length ? emailBody.originalTo : data.to;
  let ccAddresses = emailBody?.originalCc?.length ? emailBody.originalCc : data.cc;

  // Check if this is a forwarded email and extract original recipients from the body
  const forwardedInfo = parseForwardedEmailHeaders(data.subject, emailBody?.text);

  if (forwardedInfo.isForwarded && forwardedInfo.confidence !== 'low') {
    // Extract additional recipients from the forwarded email headers in the body
    const forwardedTo = forwardedInfo.originalTo.map(formatEmailAddress);
    const forwardedCc = forwardedInfo.originalCc.map(formatEmailAddress);

    // Merge with existing addresses, avoiding duplicates
    toAddresses = mergeAddresses(toAddresses, forwardedTo);
    ccAddresses = mergeAddresses(ccAddresses || [], forwardedCc);

    logger.info({
      isForwarded: true,
      confidence: forwardedInfo.confidence,
      forwardedToCount: forwardedInfo.originalTo.length,
      forwardedCcCount: forwardedInfo.originalCc.length,
      forwardedTo: forwardedInfo.originalTo.map(a => a.email),
      forwardedCc: forwardedInfo.originalCc.map(a => a.email),
      originalSubject: forwardedInfo.originalSubject,
    }, 'Extracted recipients from forwarded email body');
  }

  logger.info({
    webhookTo: data.to,
    webhookCc: data.cc,
    originalTo: emailBody?.originalTo,
    originalCc: emailBody?.originalCc,
    finalTo: toAddresses,
    finalCc: ccAddresses,
    usingOriginalRecipients: !!(emailBody?.originalTo?.length || emailBody?.originalCc?.length),
    isForwarded: forwardedInfo.isForwarded,
  }, 'Resolving email recipients');

  // Get all external participants using original recipients
  const participants = getExternalParticipants(data.from, toAddresses, ccAddresses);

  if (participants.length === 0) {
    throw new Error('No external participants found in email');
  }

  logger.info({
    participantCount: participants.length,
    participants: participants.map(p => ({ email: p.email, role: p.role })),
  }, 'Processing prospect email with external participants');

  // Create/update contacts for all participants
  const contacts = await ensureContactsForParticipants(participants);

  logger.info({
    contactCount: contacts.length,
    contacts: contacts.map(c => ({ email: c.email, contactId: c.contactId, role: c.role })),
  }, 'Created/updated email contacts');

  if (contacts.length === 0) {
    throw new Error('Failed to create any contacts');
  }

  // Extract insights
  logger.info({ emailId: data.email_id }, 'Starting insight extraction');
  const { insights, method, tokensUsed } = await extractInsightsWithClaude({
    from: data.from,
    subject: data.subject,
    text: emailBody?.text,
    to: toAddresses,
    cc: ccAddresses,
  });
  logger.info({ emailId: data.email_id, method, tokensUsed }, 'Completed insight extraction');

  // Build metadata with all participants (include both original and webhook recipients for debugging)
  const metadata = {
    email_id: data.email_id,
    from: data.from,
    to: toAddresses,
    cc: ccAddresses,
    webhook_to: data.to,
    webhook_cc: data.cc,
    has_attachments: (data.attachments?.length || 0) > 0,
    received_at: data.created_at,
    context: 'prospect',
    all_contacts: contacts.map(c => ({
      contact_id: c.contactId,
      email: c.email,
      domain: c.domain,
      role: c.role,
      is_new: c.isNew,
      organization_id: c.organizationId,
    })),
  };

  // Primary contact is the first recipient (the prospect being reached out to)
  // Fall back to sender only if no external recipients (e.g., prospect replies directly to Addie)
  const primaryContact = contacts.find(c => c.role === 'recipient') || contacts.find(c => c.role === 'cc') || contacts[0];

  // Store activity (contacts linked via junction table)
  logger.info({ emailId: data.email_id, messageId: data.message_id }, 'Storing email activity');
  const activityResult = await pool.query(
    `INSERT INTO email_contact_activities (
      email_id,
      message_id,
      subject,
      direction,
      insights,
      insight_method,
      tokens_used,
      metadata,
      email_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id`,
    [
      data.email_id,
      data.message_id,
      data.subject,
      'inbound',
      insights,
      method,
      tokensUsed || null,
      JSON.stringify(metadata),
      new Date(data.created_at),
    ]
  );

  const activityId = activityResult.rows[0].id;
  logger.info({ emailId: data.email_id, activityId }, 'Stored email activity, linking contacts');

  // Link all contacts to this activity via junction table
  for (const contact of contacts) {
    await pool.query(
      `INSERT INTO email_activity_contacts (activity_id, contact_id, role, is_primary)
       VALUES ($1, $2, $3, $4)`,
      [activityId, contact.contactId, contact.role, contact.contactId === primaryContact.contactId]
    );
  }
  logger.info({ emailId: data.email_id, activityId, contactCount: contacts.length }, 'Linked contacts to email activity');

  // Note: Email activities are shown on org detail pages via a JOIN query
  // through email_contacts.organization_id, so we don't need to duplicate
  // the activity into org_activities here.

  return {
    activityId: activityResult.rows[0].id,
    contacts: contacts.map(c => ({
      contactId: c.contactId,
      workosUserId: c.workosUserId,
      organizationId: c.organizationId,
      email: c.email,
      role: c.role,
      isNew: c.isNew,
    })),
    insights,
    method,
    tokensUsed,
    // Include email content for potential Addie invocation
    emailContent: {
      text: emailBody?.text,
      html: emailBody?.html,
      messageId: data.message_id,
      to: toAddresses,
      cc: ccAddresses,
    },
  };
}

/**
 * Handle feed subscription emails (newsletters forwarded to feed-*@updates.agenticadvertising.org)
 *
 * Extracts article links from the email and creates perspectives from them.
 */
async function handleFeedEmail(
  data: ResendInboundPayload['data'],
  slug: string
): Promise<{ perspectiveId: string | null; feedId: number | null }> {
  // Look up the feed by email slug
  const feed = await getFeedByEmailSlug(slug);

  if (!feed) {
    logger.warn({ slug, to: data.to }, 'No matching feed found for inbound email');
    return { perspectiveId: null, feedId: null };
  }

  // Extract links from HTML content for processing
  const links: { url: string; text?: string }[] = [];

  // Fetch the email body to get HTML content
  const emailBody = await fetchEmailBody(data.email_id);

  if (emailBody?.html) {
    // Simple regex to extract links from HTML
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)</gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(emailBody.html)) !== null) {
      const url = linkMatch[1];
      // Filter out unsubscribe/tracking links
      if (!url.includes('unsubscribe') &&
          !url.includes('list-manage') &&
          !url.includes('track.') &&
          url.startsWith('http')) {
        links.push({ url, text: linkMatch[2] || undefined });
      }
    }
  }

  // Parse sender info
  const senderParsed = parseEmailAddress(data.from);

  // Create perspective from the email
  const perspectiveId = await createEmailPerspective({
    feed_id: feed.id,
    feed_name: feed.name,
    message_id: data.message_id || data.email_id || `resend-${Date.now()}`,
    subject: data.subject || 'No subject',
    from_email: senderParsed.email,
    from_name: senderParsed.displayName || undefined,
    received_at: new Date(data.created_at || Date.now()),
    html_content: emailBody?.html,
    text_content: emailBody?.text,
    links,
  });

  if (perspectiveId) {
    logger.info({
      feedId: feed.id,
      feedName: feed.name,
      perspectiveId,
      subject: data.subject,
      linkCount: links.length,
    }, 'Created perspective from inbound email');
  } else {
    logger.debug({
      feedId: feed.id,
      subject: data.subject,
    }, 'Email already processed (duplicate message_id)');
  }

  return { perspectiveId, feedId: feed.id };
}

/**
 * Handle unrouted emails (plain addie@ or unknown context)
 *
 * Logs the email but doesn't process it - for monitoring what comes in
 * without a clear routing context.
 */
async function handleUnroutedEmail(data: ResendInboundPayload['data']): Promise<void> {
  // Just log for now - no processing
  logger.info({
    emailId: data.email_id,
    messageId: data.message_id,
    from: data.from,
    to: data.to,
    cc: data.cc,
    subject: data.subject,
  }, 'Received unrouted email (no context) - logging only');
}

// ============================================================================
// Luma Webhook Handlers
// ============================================================================

/**
 * Handle Luma guest.created webhook
 * Syncs new registrations from Luma to our database
 */
async function handleLumaGuestCreated(payload: LumaWebhookPayload): Promise<void> {
  const guest = payload.data.guest;
  if (!guest) {
    logger.warn({ payload }, 'Luma guest.created webhook missing guest data');
    return;
  }

  // Find our event by Luma event ID
  const pool = getPool();
  const eventResult = await pool.query(
    `SELECT id, title FROM events WHERE luma_event_id = $1`,
    [guest.event_api_id]
  );

  if (eventResult.rows.length === 0) {
    logger.debug({ lumaEventId: guest.event_api_id }, 'Luma webhook for unknown event, ignoring');
    return;
  }

  const event = eventResult.rows[0];

  // Check if registration already exists
  const existingResult = await pool.query(
    `SELECT id FROM event_registrations WHERE luma_guest_id = $1`,
    [guest.api_id]
  );

  if (existingResult.rows.length > 0) {
    logger.debug({ lumaGuestId: guest.api_id }, 'Luma guest already synced');
    return;
  }

  // Create registration
  await eventsDb.createRegistration({
    event_id: event.id,
    email: guest.user_email,
    name: guest.user_name || undefined,
    registration_source: 'luma',
    luma_guest_id: guest.api_id,
  });

  logger.info({
    eventId: event.id,
    eventTitle: event.title,
    lumaGuestId: guest.api_id,
    email: guest.user_email,
  }, 'Synced Luma registration to database');
}

/**
 * Handle Luma guest.updated webhook
 * Updates registration status (approved, declined, checked-in)
 */
async function handleLumaGuestUpdated(payload: LumaWebhookPayload): Promise<void> {
  const guest = payload.data.guest;
  if (!guest) {
    logger.warn({ payload }, 'Luma guest.updated webhook missing guest data');
    return;
  }

  const pool = getPool();

  // Find our registration by Luma guest ID
  const regResult = await pool.query(
    `SELECT id, event_id FROM event_registrations WHERE luma_guest_id = $1`,
    [guest.api_id]
  );

  if (regResult.rows.length === 0) {
    // Registration doesn't exist, create it
    logger.debug({ lumaGuestId: guest.api_id }, 'Luma guest.updated for unknown registration, creating');
    await handleLumaGuestCreated(payload);
    return;
  }

  const registration = regResult.rows[0];

  // Update based on approval status
  if (guest.approval_status === 'declined') {
    await pool.query(
      `UPDATE event_registrations SET registration_status = 'cancelled' WHERE id = $1`,
      [registration.id]
    );
    logger.info({ registrationId: registration.id, lumaGuestId: guest.api_id }, 'Registration cancelled via Luma');
  }

  // Update check-in status
  if (guest.checked_in_at) {
    await eventsDb.checkInAttendee(registration.id);
    logger.info({ registrationId: registration.id, lumaGuestId: guest.api_id }, 'Attendee checked in via Luma');
  }
}

/**
 * Handle Luma event.updated webhook
 * Syncs event changes from Luma to our database
 */
async function handleLumaEventUpdated(payload: LumaWebhookPayload): Promise<void> {
  const lumaEvent = payload.data.event;
  if (!lumaEvent) {
    logger.warn({ payload }, 'Luma event.updated webhook missing event data');
    return;
  }

  const pool = getPool();

  // Find our event by Luma event ID
  const eventResult = await pool.query(
    `SELECT id FROM events WHERE luma_event_id = $1`,
    [lumaEvent.api_id]
  );

  if (eventResult.rows.length === 0) {
    logger.debug({ lumaEventId: lumaEvent.api_id }, 'Luma event.updated for unknown event, ignoring');
    return;
  }

  const eventId = eventResult.rows[0].id;

  // Update our event with Luma changes
  await eventsDb.updateEvent(eventId, {
    title: lumaEvent.name,
    description: lumaEvent.description || undefined,
    start_time: new Date(lumaEvent.start_at),
    end_time: new Date(lumaEvent.end_at),
    timezone: lumaEvent.timezone,
    venue_name: lumaEvent.geo_address_json?.description || undefined,
    venue_address: lumaEvent.geo_address_json?.full_address || undefined,
    venue_city: lumaEvent.geo_address_json?.city || undefined,
    venue_country: lumaEvent.geo_address_json?.country || undefined,
    virtual_url: lumaEvent.meeting_url || lumaEvent.zoom_meeting_url || undefined,
    featured_image_url: lumaEvent.cover_url || undefined,
  });

  logger.info({ eventId, lumaEventId: lumaEvent.api_id }, 'Updated event from Luma webhook');
}

/**
 * Create webhook routes router
 */
export function createWebhooksRouter(): Router {
  const router = Router();

  // =========================================================================
  // Luma Webhooks
  // =========================================================================

  router.post('/luma', async (req: Request, res: Response) => {
    const requestStartTime = Date.now();

    try {
      logger.info({ body: req.body }, 'Received Luma webhook');

      const payload = parseLumaWebhook(req.body);
      if (!payload) {
        logger.warn({ body: req.body }, 'Invalid Luma webhook payload');
        return res.status(400).json({ error: 'Invalid payload' });
      }

      logger.info({
        action: payload.action,
        apiId: payload.data.api_id,
      }, 'Processing Luma webhook');

      switch (payload.action) {
        case 'guest.created':
          await handleLumaGuestCreated(payload);
          break;
        case 'guest.updated':
          await handleLumaGuestUpdated(payload);
          break;
        case 'event.updated':
          await handleLumaEventUpdated(payload);
          break;
        case 'event.created':
          // Events created via Luma directly are logged but not auto-synced
          // (we create events from AAO, not vice versa)
          logger.info({ lumaEventId: payload.data.api_id }, 'Luma event.created webhook (not synced)');
          break;
        case 'event.deleted':
          // Log but don't auto-delete our events
          logger.info({ lumaEventId: payload.data.api_id }, 'Luma event.deleted webhook (not synced)');
          break;
        default:
          logger.warn({ action: payload.action }, 'Unknown Luma webhook action');
      }

      const totalDurationMs = Date.now() - requestStartTime;
      logger.info({ action: payload.action, totalDurationMs }, 'Processed Luma webhook');

      return res.status(200).json({ ok: true });
    } catch (error) {
      const totalDurationMs = Date.now() - requestStartTime;
      logger.error({ error, totalDurationMs }, 'Error processing Luma webhook');
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // =========================================================================
  // Resend Webhooks
  // =========================================================================

  router.post(
    '/resend-inbound',
    // Custom middleware to capture raw body while still parsing JSON
    (req: Request, res: Response, next) => {
      let rawBody = '';
      req.setEncoding('utf8');

      req.on('data', (chunk: string) => {
        rawBody += chunk;
      });

      req.on('end', () => {
        (req as Request & { rawBody: string }).rawBody = rawBody;
        try {
          req.body = JSON.parse(rawBody);
          next();
        } catch {
          logger.warn({ rawBodyLength: rawBody.length }, 'Invalid JSON in webhook request');
          res.status(400).json({ error: 'Invalid JSON' });
        }
      });
    },
    async (req: Request, res: Response) => {
      const requestStartTime = Date.now();

      try {
        const rawBody = (req as Request & { rawBody: string }).rawBody;

        logger.info({ bodyLength: rawBody.length }, 'Received webhook request');

        if (!verifyResendWebhook(req, rawBody)) {
          logger.warn('Rejecting webhook: invalid signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const payload = req.body as ResendInboundPayload;

        if (payload.type !== 'email.received') {
          logger.info({ type: payload.type }, 'Ignoring non-inbound email event type');
          return res.status(200).json({ ok: true, ignored: true });
        }

        const { data } = payload;

        // Parse the Addie context from the email addresses
        const context = parseAddieContext(data.to, data.cc);

        logger.info({
          emailId: data.email_id,
          messageId: data.message_id,
          from: data.from,
          to: data.to,
          cc: data.cc,
          subject: data.subject,
          attachmentCount: data.attachments?.length || 0,
          context: context.type,
        }, 'Processing inbound email');

        // Check for duplicate using message_id (only for prospect context that stores activities)
        if (context.type === 'prospect') {
          const pool = getPool();
          const existingResult = await pool.query(
            `SELECT id FROM email_contact_activities WHERE message_id = $1 LIMIT 1`,
            [data.message_id]
          );

          if (existingResult.rows.length > 0) {
            logger.info({ messageId: data.message_id, existingId: existingResult.rows[0].id }, 'Duplicate email detected, skipping');
            return res.status(200).json({ ok: true, duplicate: true });
          }
        }

        // Route to appropriate handler based on context
        switch (context.type) {
          case 'prospect': {
            const result = await handleProspectEmail(data);
            const totalDurationMs = Date.now() - requestStartTime;

            logger.info({
              activityId: result.activityId,
              contactCount: result.contacts.length,
              contacts: result.contacts,
              insightMethod: result.method,
              tokensUsed: result.tokensUsed,
              totalDurationMs,
              insightPreview: result.insights.substring(0, 100) + (result.insights.length > 100 ? '...' : ''),
            }, 'Processed prospect email');

            // Check for Addie invocation and respond if needed
            // This runs async - don't block the webhook response
            if (result.emailContent?.text) {
              // Find which addie address was used
              const allAddresses = [...data.to, ...(data.cc || [])];
              const addieAddress = allAddresses.find(addr =>
                addr.toLowerCase().includes('addie') &&
                (addr.includes('@agenticadvertising.org') || addr.includes('@updates.agenticadvertising.org'))
              ) || 'addie+prospect@agenticadvertising.org';

              const emailContext: InboundEmailContext = {
                emailId: data.email_id,
                messageId: data.message_id,
                from: data.from,
                to: result.emailContent.to,
                cc: result.emailContent.cc,
                subject: data.subject,
                textContent: result.emailContent.text,
                htmlContent: result.emailContent.html,
                addieAddress,
              };

              // Find the sender's WorkOS user ID if they're a known member
              const senderContact = result.contacts.find(c => c.email.toLowerCase() === parseEmailAddress(data.from).email.toLowerCase());

              // Fire and forget - don't await (pass workosUserId for authorization, not contactId)
              handleEmailInvocation(emailContext, senderContact?.workosUserId ?? undefined)
                .then(invocationResult => {
                  if (invocationResult.responded) {
                    logger.info({ emailId: data.email_id }, 'Addie responded to email invocation');
                  }
                })
                .catch(err => {
                  logger.error({ err, emailId: data.email_id }, 'Error checking email invocation');
                });
            }

            // Analyze interaction for task management (fire and forget)
            // This looks for pending tasks to complete/reschedule and learns from the email
            if (result.emailContent?.text) {
              const primaryContact = result.contacts[0];
              const interactionContext: InteractionContext = {
                fromEmail: data.from,
                toEmails: result.emailContent.to,
                subject: data.subject,
                content: result.emailContent.text,
                channel: 'email',
                direction: 'inbound',
                contactId: primaryContact?.contactId,
                organizationId: primaryContact?.organizationId || undefined,
              };

              processInteraction(interactionContext)
                .then(interactionResult => {
                  if (interactionResult.analyzed && interactionResult.actionsApplied) {
                    const { completed, rescheduled, created } = interactionResult.actionsApplied;
                    if (completed > 0 || rescheduled > 0 || created > 0) {
                      logger.info({
                        emailId: data.email_id,
                        completed,
                        rescheduled,
                        created,
                      }, 'Applied task actions from email interaction');
                    }
                  }
                })
                .catch(err => {
                  logger.error({ err, emailId: data.email_id }, 'Error analyzing email interaction');
                });
            }

            return res.status(200).json({ ok: true, context: 'prospect' });
          }

          case 'working-group': {
            // Future: route to working group handler
            logger.info({
              groupId: context.groupId,
              emailId: data.email_id,
            }, 'Working group email context not yet implemented');
            return res.status(200).json({ ok: true, context: 'working-group', notImplemented: true });
          }

          case 'feed': {
            const result = await handleFeedEmail(data, context.slug);
            const totalDurationMs = Date.now() - requestStartTime;

            logger.info({
              feedId: result.feedId,
              perspectiveId: result.perspectiveId,
              slug: context.slug,
              totalDurationMs,
            }, 'Processed feed email');

            return res.status(200).json({
              ok: true,
              context: 'feed',
              feedId: result.feedId,
              perspectiveId: result.perspectiveId,
            });
          }

          case 'unrouted':
          default: {
            await handleUnroutedEmail(data);
            return res.status(200).json({ ok: true, context: 'unrouted' });
          }
        }
      } catch (error) {
        const totalDurationMs = Date.now() - requestStartTime;
        logger.error({ error, totalDurationMs }, 'Error processing Resend inbound webhook');
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  // =========================================================================
  // Zoom Webhooks
  // =========================================================================

  router.post(
    '/zoom',
    // Custom middleware to capture raw body for signature verification
    (req: Request, res: Response, next) => {
      let rawBody = '';
      req.setEncoding('utf8');

      req.on('data', (chunk: string) => {
        rawBody += chunk;
      });

      req.on('end', () => {
        (req as Request & { rawBody: string }).rawBody = rawBody;
        try {
          req.body = JSON.parse(rawBody);
          next();
        } catch {
          logger.warn({ rawBodyLength: rawBody.length }, 'Invalid JSON in Zoom webhook request');
          res.status(400).json({ error: 'Invalid JSON' });
        }
      });
    },
    async (req: Request, res: Response) => {
      const requestStartTime = Date.now();

      try {
        const body = req.body;
        const rawBody = (req as Request & { rawBody: string }).rawBody;

        // Log incoming request immediately for debugging
        logger.info({
          event: body?.event,
          hasSignature: !!req.headers['x-zm-signature'],
          hasTimestamp: !!req.headers['x-zm-request-timestamp'],
          bodyLength: rawBody?.length,
        }, 'Received Zoom webhook request');

        // Handle URL validation challenge from Zoom
        // https://developers.zoom.us/docs/api/rest/webhook-reference/#validate-your-webhook-endpoint
        if (body.event === 'endpoint.url_validation') {
          const plainToken = body.payload?.plainToken;
          if (!plainToken) {
            logger.warn('Zoom URL validation request missing plainToken');
            return res.status(400).json({ error: 'Missing plainToken' });
          }

          const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET;
          if (!webhookSecret) {
            logger.error('ZOOM_WEBHOOK_SECRET not configured - cannot validate endpoint');
            return res.status(500).json({ error: 'Webhook secret not configured' });
          }

          // Generate encrypted token using HMAC-SHA256
          const encryptedToken = crypto
            .createHmac('sha256', webhookSecret)
            .update(plainToken)
            .digest('hex');

          logger.info('Responding to Zoom URL validation challenge');
          return res.status(200).json({
            plainToken,
            encryptedToken,
          });
        }

        // Verify webhook signature for real events
        const signature = req.headers['x-zm-signature'] as string;
        const timestamp = req.headers['x-zm-request-timestamp'] as string;

        if (!signature || !timestamp) {
          logger.warn('Zoom webhook missing signature headers');
          return res.status(401).json({ error: 'Missing signature headers' });
        }

        // Validate timestamp is recent (within 5 minutes) to prevent replay attacks
        const requestTime = parseInt(timestamp, 10) * 1000; // Zoom sends seconds
        const currentTime = Date.now();
        const fiveMinutesMs = 5 * 60 * 1000;

        if (isNaN(requestTime) || Math.abs(currentTime - requestTime) > fiveMinutesMs) {
          logger.warn({ timestamp, currentTime }, 'Zoom webhook timestamp too old or invalid');
          return res.status(401).json({ error: 'Timestamp expired' });
        }

        if (!verifyZoomSignature(rawBody, signature, timestamp)) {
          logger.warn('Zoom webhook signature verification failed');
          return res.status(401).json({ error: 'Invalid signature' });
        }

        logger.info({ event: body.event, meetingId: body.payload?.object?.id }, 'Processing Zoom webhook');

        // Handle different event types
        switch (body.event) {
          case 'recording.completed':
          case 'recording.transcript_completed': {
            const meetingUuid = body.payload?.object?.uuid;
            if (meetingUuid && typeof meetingUuid === 'string' && meetingUuid.length < 256) {
              await handleRecordingCompleted(meetingUuid);
            } else if (meetingUuid) {
              logger.warn({ meetingUuidType: typeof meetingUuid }, 'Invalid meetingUuid format');
            }
            break;
          }

          case 'meeting.started':
            logger.info({ meetingId: body.payload?.object?.id }, 'Meeting started');
            break;

          case 'meeting.ended':
            logger.info({ meetingId: body.payload?.object?.id }, 'Meeting ended');
            break;

          default:
            logger.debug({ event: body.event }, 'Unhandled Zoom webhook event');
        }

        const totalDurationMs = Date.now() - requestStartTime;
        logger.info({ event: body.event, totalDurationMs }, 'Processed Zoom webhook');

        return res.status(200).json({ ok: true });
      } catch (error) {
        const totalDurationMs = Date.now() - requestStartTime;
        logger.error({ error, totalDurationMs }, 'Error processing Zoom webhook');
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return router;
}
