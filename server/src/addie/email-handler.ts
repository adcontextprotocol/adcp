/**
 * Addie Email Handler
 *
 * Handles email invocations when Addie is CC'd on prospect communications
 * and explicitly asked to do something (e.g., "Addie, send a payment link")
 */

import { createLogger } from '../logger.js';
import { AddieClaudeClient } from './claude-client.js';
import {
  sanitizeInput,
  validateOutput,
  generateInteractionId,
} from './security.js';
import { getWebMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import { isAdmin, ADMIN_TOOLS, createAdminToolHandlers } from './mcp/admin-tools.js';
import { MEMBER_TOOLS, createMemberToolHandlers } from './mcp/member-tools.js';
import { BILLING_TOOLS, createBillingToolHandlers } from './mcp/billing-tools.js';
import { sendEmailReply, type EmailThreadContext } from '../notifications/email.js';
import { AddieDatabase } from '../db/addie-db.js';
import { AddieModelConfig } from '../config/models.js';
import type { RequestTools } from './claude-client.js';
import type { AddieInteractionLog } from './types.js';

const logger = createLogger('addie-email');

let claudeClient: AddieClaudeClient | null = null;
let addieDb: AddieDatabase | null = null;

/**
 * Patterns that indicate Addie is being directly invoked
 * We require explicit invocation to avoid responding to every email
 */
const ADDIE_INVOCATION_PATTERNS = [
  /\b@?addie\b[,:]?\s/i,                    // "Addie, ..." or "@Addie ..." or "Addie: ..."
  /\bhey\s+addie\b/i,                        // "Hey Addie"
  /\bhi\s+addie\b/i,                         // "Hi Addie"
  /\baddie[,:]?\s+(?:can|could|please|would)/i,  // "Addie, can you..." or "Addie please..."
  /\bask(?:ing)?\s+addie\b/i,               // "asking Addie" or "ask Addie"
];

/**
 * Check if an email contains an explicit Addie invocation
 */
export function detectAddieInvocation(text: string): { invoked: boolean; request?: string } {
  if (!text) return { invoked: false };

  // Check each pattern
  for (const pattern of ADDIE_INVOCATION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Extract the request - everything after the invocation on the same line
      // or the next few sentences
      const startIndex = (match.index || 0) + match[0].length;
      const afterInvocation = text.substring(startIndex);

      // Take up to 500 chars or until we hit a signature/quote marker
      const endMarkers = ['\n--', '\nOn ', '\nFrom:', '\n>', '\nSent from'];
      let endIndex = afterInvocation.length;

      for (const marker of endMarkers) {
        const markerIndex = afterInvocation.indexOf(marker);
        if (markerIndex !== -1 && markerIndex < endIndex) {
          endIndex = markerIndex;
        }
      }

      const request = afterInvocation.substring(0, Math.min(endIndex, 500)).trim();

      return { invoked: true, request };
    }
  }

  return { invoked: false };
}

/**
 * Initialize the email handler
 * Called during server startup
 */
export function initializeEmailHandler(): void {
  const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY configured, email handler will be disabled');
    return;
  }

  claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);
  addieDb = new AddieDatabase();

  // All tools (billing, member, admin) are registered at request time via RequestTools
  // since they may need member context for scoping

  logger.info('Addie email handler initialized');
}

/**
 * Email context passed from the webhook
 */
export interface InboundEmailContext {
  emailId: string;
  messageId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  textContent?: string;
  htmlContent?: string;
  // The Addie address that was used (e.g., addie+prospect@)
  addieAddress: string;
}

/**
 * Build the prompt for Claude including email context
 */
function buildEmailPrompt(
  request: string,
  emailContext: InboundEmailContext,
  memberContext: MemberContext | null,
  isUserAdmin: boolean
): string {
  let prompt = '';

  // Add admin prefix if applicable
  if (isUserAdmin) {
    prompt += '[ADMIN USER] ';
  }

  // Add member context
  if (memberContext) {
    prompt += formatMemberContextForPrompt(memberContext) + '\n\n';
  }

  // Add email context (sanitize metadata to prevent prompt injection)
  const sanitizedFrom = sanitizeInput(emailContext.from).sanitized;
  const sanitizedSubject = sanitizeInput(emailContext.subject).sanitized;
  prompt += `You are responding to an email thread. Here's the context:\n`;
  prompt += `From: ${sanitizedFrom}\n`;
  prompt += `Subject: ${sanitizedSubject}\n`;
  prompt += `\nThe admin has asked you to: ${request}\n`;
  prompt += `\nIMPORTANT: Your response will be sent as an email reply to this thread. `;
  prompt += `Format your response as if you're writing an email - be professional but friendly. `;
  prompt += `Do NOT include greetings like "Hi" at the start - the email will be sent as a reply in context. `;
  prompt += `Focus on fulfilling the request directly.\n`;

  // Include email content for context (truncated)
  if (emailContext.textContent) {
    const truncatedContent = emailContext.textContent.substring(0, 2000);
    prompt += `\nRecent email content for context:\n---\n${truncatedContent}\n---\n`;
  }

  return prompt;
}

/**
 * Convert markdown response to simple HTML for email
 */
function markdownToEmailHtml(markdown: string): string {
  let html = markdown
    // Escape HTML first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Links - convert markdown links to HTML
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color: #2563eb;">$1</a>')
    // Plain URLs - make them clickable
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color: #2563eb;">$1</a>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<p>${html}</p>`;
}

/**
 * Handle an email invocation of Addie
 * Returns true if Addie responded, false if not invoked or error
 */
export async function handleEmailInvocation(
  emailContext: InboundEmailContext,
  senderWorkosUserId?: string
): Promise<{ responded: boolean; error?: string }> {
  if (!claudeClient) {
    logger.warn('Email handler not initialized');
    return { responded: false, error: 'Handler not initialized' };
  }

  // Check for explicit invocation
  const content = emailContext.textContent || '';
  const invocation = detectAddieInvocation(content);

  if (!invocation.invoked || !invocation.request) {
    logger.debug({ emailId: emailContext.emailId }, 'No Addie invocation detected in email');
    return { responded: false };
  }

  logger.info({
    emailId: emailContext.emailId,
    from: emailContext.from,
    request: invocation.request.substring(0, 100),
  }, 'Addie invocation detected in email');

  const startTime = Date.now();
  const interactionId = generateInteractionId();

  try {
    // Get member context for the sender (if we have their WorkOS ID)
    let memberContext: MemberContext | null = null;
    let isUserAdmin = false;

    if (senderWorkosUserId) {
      memberContext = await getWebMemberContext(senderWorkosUserId);
      isUserAdmin = isAdmin(memberContext);
    }

    // Sanitize input
    const inputValidation = sanitizeInput(invocation.request);

    // Build prompt with email context
    const prompt = buildEmailPrompt(
      inputValidation.sanitized,
      emailContext,
      memberContext,
      isUserAdmin
    );

    // Build per-request tools with appropriate scope
    const tools = isUserAdmin
      ? [...BILLING_TOOLS, ...MEMBER_TOOLS, ...ADMIN_TOOLS]
      : [...BILLING_TOOLS, ...MEMBER_TOOLS];

    // Build handlers map
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

    // Add billing tool handlers
    const billingHandlers = createBillingToolHandlers();
    for (const [name, handler] of billingHandlers) {
      handlers.set(name, handler);
    }

    // Add member tool handlers
    const memberHandlers = createMemberToolHandlers(memberContext);
    for (const [name, handler] of memberHandlers) {
      handlers.set(name, handler);
    }

    // Add admin tool handlers if user is admin
    if (isUserAdmin) {
      const adminHandlers = createAdminToolHandlers(memberContext);
      for (const [name, handler] of adminHandlers) {
        handlers.set(name, handler);
      }
    }

    const userTools: RequestTools = { tools, handlers };

    // Process with Claude
    const response = await claudeClient.processMessage(prompt, undefined, userTools);

    // Validate output
    const outputValidation = validateOutput(response.text);

    // Build thread context for reply
    const threadContext: EmailThreadContext = {
      messageId: emailContext.messageId,
      subject: emailContext.subject,
      from: emailContext.from,
      to: emailContext.to,
      cc: emailContext.cc,
    };

    // Send email reply
    const htmlContent = markdownToEmailHtml(outputValidation.sanitized);
    const replyResult = await sendEmailReply({
      threadContext,
      htmlContent,
      textContent: outputValidation.sanitized,
      fromEmail: emailContext.addieAddress.includes('+')
        ? emailContext.addieAddress
        : 'addie@agenticadvertising.org',
    });

    if (!replyResult.success) {
      logger.error({ error: replyResult.error, emailId: emailContext.emailId }, 'Failed to send email reply');
      return { responded: false, error: replyResult.error };
    }

    // Log interaction to database
    const flagged = inputValidation.flagged || response.flagged || outputValidation.flagged;
    const flagReason = [inputValidation.reason, response.flag_reason, outputValidation.reason]
      .filter(Boolean)
      .join('; ');

    const log: AddieInteractionLog = {
      id: interactionId,
      timestamp: new Date(),
      event_type: 'email',
      channel_id: emailContext.emailId,
      user_id: senderWorkosUserId || emailContext.from,
      input_text: invocation.request,
      input_sanitized: inputValidation.sanitized,
      output_text: outputValidation.sanitized,
      tools_used: response.tools_used,
      model: AddieModelConfig.chat,
      latency_ms: Date.now() - startTime,
      flagged,
      flag_reason: flagReason || undefined,
    };

    if (addieDb) {
      try {
        await addieDb.logInteraction(log);
      } catch (error) {
        logger.error({ error }, 'Failed to log email interaction to database');
      }
    }

    logger.info({
      emailId: emailContext.emailId,
      responseMessageId: replyResult.messageId,
      toolsUsed: response.tools_used,
      latencyMs: Date.now() - startTime,
    }, 'Addie responded to email invocation');

    return { responded: true };
  } catch (error) {
    logger.error({ error, emailId: emailContext.emailId }, 'Error handling email invocation');
    return { responded: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
