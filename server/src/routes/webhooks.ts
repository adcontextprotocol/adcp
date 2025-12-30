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
 * Addie email context types
 * Parsed from subaddressing like addie+prospect@agenticadvertising.org
 */
type AddieContext =
  | { type: 'prospect' }
  | { type: 'working-group'; groupId: string }
  | { type: 'unrouted' };

/**
 * Parse Addie context from email addresses
 * Looks for addie+context@agenticadvertising.org patterns in TO/CC
 *
 * Examples:
 *   addie+prospect@agenticadvertising.org → { type: 'prospect' }
 *   addie+wg-governance@agenticadvertising.org → { type: 'working-group', groupId: 'governance' }
 *   addie@agenticadvertising.org → { type: 'unrouted' }
 */
function parseAddieContext(toAddresses: string[], ccAddresses: string[] = []): AddieContext {
  const allAddresses = [...toAddresses, ...ccAddresses];

  for (const addr of allAddresses) {
    const { email } = parseEmailAddress(addr);

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
 * Parse email address to extract name and email parts
 * Handles formats like "John Doe <john@example.com>" or just "john@example.com"
 */
function parseEmailAddress(emailStr: string): { email: string; displayName: string | null; domain: string } {
  // Match: "Display Name" <email@domain> or Display Name <email@domain>
  const withBracketsMatch = emailStr.match(/^(?:"?([^"<]+)"?\s*)?<([^>]+@([^>]+))>$/);
  if (withBracketsMatch) {
    return {
      displayName: withBracketsMatch[1]?.trim() || null,
      email: withBracketsMatch[2].toLowerCase(),
      domain: withBracketsMatch[3].toLowerCase(),
    };
  }

  // Simple email without brackets: email@domain
  const simpleMatch = emailStr.match(/^([^@\s]+)@([^@\s]+)$/);
  if (simpleMatch) {
    return {
      displayName: null,
      email: emailStr.toLowerCase(),
      domain: simpleMatch[2].toLowerCase(),
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
 * Get or create an email contact from pre-parsed participant info
 */
async function getOrCreateEmailContact(
  participant: { email: string; displayName: string | null; domain: string }
): Promise<{
  contactId: string;
  organizationId: string | null;
  isNew: boolean;
  email: string;
  domain: string;
}> {
  const pool = getPool();
  const { email, displayName, domain } = participant;

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
 * Create/update contacts for all external participants
 * Returns array of contact info for tracking
 */
async function ensureContactsForParticipants(
  participants: Array<{ email: string; displayName: string | null; domain: string; role: 'sender' | 'recipient' | 'cc' }>
): Promise<Array<{
  contactId: string;
  organizationId: string | null;
  email: string;
  domain: string;
  role: 'sender' | 'recipient' | 'cc';
  isNew: boolean;
}>> {
  const contacts: Array<{
    contactId: string;
    organizationId: string | null;
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
 * Handle prospect context emails (addie+prospect@)
 *
 * Creates/updates contacts for ALL external participants and stores
 * one activity record with the full context in metadata.
 */
async function handleProspectEmail(data: ResendInboundPayload['data']): Promise<{
  activityId: string;
  contacts: Array<{ contactId: string; email: string; role: string; isNew: boolean }>;
  insights: string;
  method: string;
  tokensUsed?: number;
}> {
  const pool = getPool();

  // Get all external participants
  const participants = getExternalParticipants(data.from, data.to, data.cc);

  if (participants.length === 0) {
    throw new Error('No external participants found in email');
  }

  logger.info({
    participantCount: participants.length,
    participants: participants.map(p => ({ email: p.email, role: p.role })),
  }, 'Processing prospect email with external participants');

  // Create/update contacts for all participants
  const contacts = await ensureContactsForParticipants(participants);

  if (contacts.length === 0) {
    throw new Error('Failed to create any contacts');
  }

  // Fetch email body
  const emailBody = await fetchEmailBody(data.email_id);

  // Extract insights
  const { insights, method, tokensUsed } = await extractInsightsWithClaude({
    from: data.from,
    subject: data.subject,
    text: emailBody?.text,
    to: data.to,
    cc: data.cc,
  });

  // Build metadata with all participants
  const metadata = {
    email_id: data.email_id,
    from: data.from,
    to: data.to,
    cc: data.cc,
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

  // Link all contacts to this activity via junction table
  for (const contact of contacts) {
    await pool.query(
      `INSERT INTO email_activity_contacts (activity_id, contact_id, role, is_primary)
       VALUES ($1, $2, $3, $4)`,
      [activityId, contact.contactId, contact.role, contact.contactId === primaryContact.contactId]
    );
  }

  // If primary contact is linked to an org, also store in org_activities
  if (primaryContact.organizationId) {
    await pool.query(
      `INSERT INTO org_activities (
        organization_id,
        activity_type,
        description,
        logged_by_name,
        activity_date,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        primaryContact.organizationId,
        'email_inbound',
        insights,
        'Addie',
        new Date(data.created_at),
        JSON.stringify({
          ...metadata,
          message_id: data.message_id,
          primary_contact_email: primaryContact.email,
          insight_method: method,
          tokens_used: tokensUsed,
        }),
      ]
    );
  }

  return {
    activityId: activityResult.rows[0].id,
    contacts: contacts.map(c => ({
      contactId: c.contactId,
      email: c.email,
      role: c.role,
      isNew: c.isNew,
    })),
    insights,
    method,
    tokensUsed,
  };
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

  return router;
}
