/**
 * Webhook routes for external services
 *
 * Handles incoming webhooks from services like Resend.
 * All routes are mounted under /api/webhooks/
 */

import { Router, Request, Response } from 'express';
import { Webhook } from 'svix';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';
import { getPool } from '../db/client.js';
import { ModelConfig } from '../config/models.js';

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
 * Parse email address to extract name and email parts
 * Handles formats like "John Doe <john@example.com>" or just "john@example.com"
 */
function parseEmailAddress(emailStr: string): { email: string; displayName: string | null; domain: string } {
  const match = emailStr.match(/^(?:"?([^"<]+)"?\s*)?<?([^>]+@([^>]+))>?$/);
  if (match) {
    return {
      displayName: match[1]?.trim() || null,
      email: match[2].toLowerCase(),
      domain: match[3].toLowerCase(),
    };
  }
  // Fallback: treat whole string as email
  const atIndex = emailStr.indexOf('@');
  return {
    displayName: null,
    email: emailStr.toLowerCase(),
    domain: atIndex > 0 ? emailStr.substring(atIndex + 1).toLowerCase() : '',
  };
}

/**
 * Get or create an email contact, and check if they're linked to an org
 */
async function getOrCreateEmailContact(
  emailStr: string
): Promise<{
  contactId: string;
  organizationId: string | null;
  isNew: boolean;
  email: string;
  domain: string;
}> {
  const pool = getPool();
  const { email, displayName, domain } = parseEmailAddress(emailStr);

  // Skip our own addresses
  if (domain === 'agenticadvertising.org' || domain === 'updates.agenticadvertising.org') {
    logger.debug({ email }, 'Skipping our own email address');
    throw new Error('Own email address');
  }

  // Check if contact exists
  const existingResult = await pool.query(
    `SELECT id, organization_id, mapping_status FROM email_contacts WHERE email = $1`,
    [email]
  );

  if (existingResult.rows.length > 0) {
    const contact = existingResult.rows[0];

    // Update last_seen and increment count
    await pool.query(
      `UPDATE email_contacts SET last_seen_at = NOW(), email_count = email_count + 1 WHERE id = $1`,
      [contact.id]
    );

    logger.debug({ email, contactId: contact.id, isNew: false }, 'Found existing email contact');
    return {
      contactId: contact.id,
      organizationId: contact.organization_id,
      isNew: false,
      email,
      domain,
    };
  }

  // New contact - check if they match an existing org member
  const memberResult = await pool.query(
    `SELECT om.organization_id, om.workos_user_id
     FROM organization_members om
     WHERE om.email = $1
     LIMIT 1`,
    [email]
  );

  const organizationId = memberResult.rows[0]?.organization_id || null;
  const workosUserId = memberResult.rows[0]?.workos_user_id || null;
  const mappingStatus = organizationId ? 'mapped' : 'unmapped';
  const mappingSource = organizationId ? 'email_auto' : null;

  // Create new contact
  const insertResult = await pool.query(
    `INSERT INTO email_contacts (
      email, display_name, domain,
      workos_user_id, organization_id,
      mapping_status, mapping_source,
      mapped_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      email,
      displayName,
      domain,
      workosUserId,
      organizationId,
      mappingStatus,
      mappingSource,
      organizationId ? new Date() : null,
    ]
  );

  logger.info({
    email,
    domain,
    contactId: insertResult.rows[0].id,
    organizationId,
    mappingStatus,
    isNew: true,
  }, 'Created new email contact');

  return {
    contactId: insertResult.rows[0].id,
    organizationId,
    isNew: true,
    email,
    domain,
  };
}

/**
 * Find the best contact from email addresses (to/cc)
 * Prioritizes non-AAO addresses and returns the first match
 */
async function findPrimaryContact(
  toAddresses: string[],
  ccAddresses: string[] = []
): Promise<{
  contactId: string;
  organizationId: string | null;
  email: string;
  domain: string;
  isNew: boolean;
} | null> {
  const allAddresses = [...toAddresses, ...ccAddresses];

  for (const emailStr of allAddresses) {
    try {
      const contact = await getOrCreateEmailContact(emailStr);
      return contact;
    } catch {
      // Skip own addresses or invalid emails
      continue;
    }
  }

  return null;
}

/**
 * Fetch email body from Resend API
 */
async function fetchEmailBody(emailId: string): Promise<{ text?: string; html?: string; textLength?: number } | null> {
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

    const data = (await response.json()) as { text?: string; html?: string };
    const textLength = data.text?.length || 0;
    const htmlLength = data.html?.length || 0;

    logger.info({
      emailId,
      durationMs,
      hasText: !!data.text,
      hasHtml: !!data.html,
      textLength,
      htmlLength,
    }, 'Fetched email body from Resend');

    return {
      text: data.text,
      html: data.html,
      textLength,
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
  logger.debug({
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

    const response = await anthropic.messages.create({
      model: ModelConfig.fast,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Please analyze this email and extract insights:\n\n${emailContent}`,
        },
      ],
      system: EMAIL_INSIGHT_PROMPT,
    });

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
 * Create webhook routes router
 */
export function createWebhooksRouter(): Router {
  const router = Router();

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
        logger.info({
          emailId: data.email_id,
          messageId: data.message_id,
          from: data.from,
          to: data.to,
          cc: data.cc,
          subject: data.subject,
          attachmentCount: data.attachments?.length || 0,
        }, 'Processing inbound email');

        const pool = getPool();

        // Check for duplicate using message_id in email_contact_activities
        const existingResult = await pool.query(
          `SELECT id FROM email_contact_activities WHERE message_id = $1 LIMIT 1`,
          [data.message_id]
        );

        if (existingResult.rows.length > 0) {
          logger.info({ messageId: data.message_id, existingId: existingResult.rows[0].id }, 'Duplicate email detected, skipping');
          return res.status(200).json({ ok: true, duplicate: true });
        }

        // Find or create the primary contact (recipient)
        const contact = await findPrimaryContact(data.to, data.cc);

        if (!contact) {
          logger.warn({ to: data.to, cc: data.cc }, 'Could not find any valid contact email');
          return res.status(200).json({ ok: true, noContact: true });
        }

        // Fetch the email body
        const emailBody = await fetchEmailBody(data.email_id);

        // Extract insights using Claude
        const { insights, method, tokensUsed } = await extractInsightsWithClaude({
          from: data.from,
          subject: data.subject,
          text: emailBody?.text,
          to: data.to,
          cc: data.cc,
        });

        // Build metadata
        const metadata = {
          email_id: data.email_id,
          from: data.from,
          to: data.to,
          cc: data.cc,
          has_attachments: (data.attachments?.length || 0) > 0,
          received_at: data.created_at,
        };

        // Store in email_contact_activities (always)
        const activityResult = await pool.query(
          `INSERT INTO email_contact_activities (
            email_contact_id,
            email_id,
            message_id,
            subject,
            direction,
            insights,
            insight_method,
            tokens_used,
            metadata,
            email_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id`,
          [
            contact.contactId,
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

        // If contact is linked to an org, also store in org_activities
        if (contact.organizationId) {
          const orgActivityResult = await pool.query(
            `INSERT INTO org_activities (
              organization_id,
              activity_type,
              description,
              logged_by_name,
              activity_date,
              metadata
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id`,
            [
              contact.organizationId,
              'email_inbound',
              insights,
              'Addie',
              new Date(data.created_at),
              JSON.stringify({
                ...metadata,
                message_id: data.message_id,
                contact_email: contact.email,
                insight_method: method,
                tokens_used: tokensUsed,
              }),
            ]
          );

          const totalDurationMs = Date.now() - requestStartTime;
          logger.info({
            activityId: activityResult.rows[0].id,
            orgActivityId: orgActivityResult.rows[0].id,
            contactId: contact.contactId,
            organizationId: contact.organizationId,
            contactEmail: contact.email,
            domain: contact.domain,
            isNewContact: contact.isNew,
            insightMethod: method,
            tokensUsed,
            totalDurationMs,
            insightPreview: insights.substring(0, 100) + (insights.length > 100 ? '...' : ''),
          }, 'Stored inbound email (org-linked contact)');
        } else {
          const totalDurationMs = Date.now() - requestStartTime;
          logger.info({
            activityId: activityResult.rows[0].id,
            contactId: contact.contactId,
            contactEmail: contact.email,
            domain: contact.domain,
            isNewContact: contact.isNew,
            insightMethod: method,
            tokensUsed,
            totalDurationMs,
            insightPreview: insights.substring(0, 100) + (insights.length > 100 ? '...' : ''),
          }, 'Stored inbound email (unmapped contact)');
        }

        res.status(200).json({ ok: true });
      } catch (error) {
        const totalDurationMs = Date.now() - requestStartTime;
        logger.error({ error, totalDurationMs }, 'Error processing Resend inbound webhook');
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return router;
}
