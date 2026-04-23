/**
 * Email Conversation Handler for Addie
 *
 * Handles full email conversations using the same thread service, Claude client,
 * and tools as web chat. Replaces the limited invocation-only email handler.
 *
 * Two modes based on Addie's position in the email:
 * - TO: Always respond (someone is talking directly to Addie)
 * - CC: Only respond if explicitly invoked (Addie is observing)
 */

import crypto from 'crypto';
import { createLogger } from '../logger.js';
import {
  sanitizeInput,
  validateOutput,
} from './security.js';
import { getThreadService } from './thread-service.js';
import type { Thread } from './thread-service.js';
import { sendEmailReply, type EmailThreadContext } from '../notifications/email.js';
import { markdownToEmailHtml } from '../utils/markdown.js';
import {
  getChatClaudeClient,
  prepareRequestWithMemberTools,
  buildTieredAccess,
} from '../routes/addie-chat.js';
const logger = createLogger('addie-email-conversation');

const MAX_EMAIL_CONTENT_LENGTH = 10_000;

/**
 * Patterns that indicate Addie is being directly invoked with an explicit request.
 * Used for CC'd emails where Addie only responds when asked.
 */
const ADDIE_INVOCATION_PATTERNS = [
  /\b@?addie[,:]?\s+(?:can|could|please|would)\b/i,
  /\b(?:hey|hi)\s+addie[,:]?\s+(?:can|could|please|would|send|help|create|get|find|look|check|tell|show|make|give|do)\b/i,
  /\bask(?:ing)?\s+addie\s+(?:to|about|for)\b/i,
  /\b@?addie[,:]?\s+(?:send|help|create|get|find|look|check|tell|show|make|give|do|schedule|draft|write|prepare|forward)\b/i,
];

/**
 * Strip quoted email content from text.
 * Removes reply quotes, forwarded sections, and signatures.
 */
export function stripQuotedContent(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const cleanLines: string[] = [];

  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line.trim())) break;
    if (/^-{5,}\s*Original Message\s*-{5,}$/i.test(line.trim())) break;
    if (/^From:\s+.+$/i.test(line.trim()) && cleanLines.length > 0) break;
    if (/^Begin forwarded message:$/i.test(line.trim())) break;
    if (line.trim() === '--') break;

    if (/^>+\s*/.test(line)) continue;

    cleanLines.push(line);
  }

  return cleanLines.join('\n').trim();
}

/**
 * Check if text contains an explicit Addie invocation.
 * Only checks new content (not quoted replies).
 */
function detectAddieInvocation(text: string): boolean {
  if (!text) return false;
  const cleanText = stripQuotedContent(text);
  if (!cleanText) return false;

  return ADDIE_INVOCATION_PATTERNS.some(pattern => pattern.test(cleanText));
}

// --- Input type ---

export interface EmailConversationInput {
  emailId: string;
  messageId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  textContent?: string;
  htmlContent?: string;
  addieAddress: string;
  addiePosition: 'to' | 'cc';
  inReplyTo?: string;
  references?: string[];
  senderWorkosUserId?: string;
  senderEmail: string;
  senderDisplayName?: string;
}

export interface EmailConversationResult {
  responded: boolean;
  threadId?: string;
  error?: string;
}

// --- Main handler ---

export async function handleEmailConversation(
  input: EmailConversationInput
): Promise<EmailConversationResult> {
  const startTime = Date.now();
  const threadService = getThreadService();

  // Rate limit: max 10 emails per sender per hour
  const recentCount = await threadService.countRecentEmailMessages(input.senderEmail);
  if (recentCount >= 10) {
    logger.warn({ senderEmail: input.senderEmail, recentCount }, 'Email rate limit exceeded');
    return { responded: false, error: 'Rate limit exceeded' };
  }

  // For CC'd emails, only respond if Addie is explicitly invoked
  if (input.addiePosition === 'cc') {
    const invoked = detectAddieInvocation(input.textContent || '');
    if (!invoked) {
      logger.debug({ emailId: input.emailId }, 'Addie CC\'d but not invoked, skipping');
      return { responded: false };
    }
    logger.info({ emailId: input.emailId }, 'Addie CC\'d and explicitly invoked');
  }

  // Apply early length bound before processing to avoid parsing huge emails
  const content = (input.textContent || '').substring(0, MAX_EMAIL_CONTENT_LENGTH * 2);
  let strippedContent = stripQuotedContent(content);

  // Truncate very long emails to prevent token blow-up
  if (strippedContent.length > MAX_EMAIL_CONTENT_LENGTH) {
    strippedContent = strippedContent.substring(0, MAX_EMAIL_CONTENT_LENGTH) + '\n\n[Content truncated]';
  }

  if (!strippedContent.trim()) {
    logger.info({ emailId: input.emailId }, 'No meaningful content after stripping quotes');
    return { responded: false };
  }

  try {
    // 1. Resolve thread (3-tier lookup)
    const thread = await resolveThread(input, threadService);

    // 2. Store inbound user message
    const inputValidation = sanitizeInput(strippedContent);
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: strippedContent,
      content_sanitized: inputValidation.sanitized,
      flagged: inputValidation.flagged,
      flag_reason: inputValidation.reason,
      email_message_id: input.messageId,
    });

    // 3. Get conversation history
    const threadMessages = await threadService.getThreadMessages(thread.thread_id);
    const contextMessages = threadMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        user: m.role === 'user' ? 'User' : 'Addie',
        text: m.content,
        toolCalls: m.tool_calls ?? undefined,
      }));

    // 4. Prepare tools — email senders are always unauthenticated.
    // Email From headers are spoofable, so we cannot use them for authorization.
    // All email conversations get anonymous-tier access (Haiku, directory tools only).
    const isAuthenticated = false;
    const prepared = await prepareRequestWithMemberTools(
      inputValidation.sanitized,
      undefined,
      thread.external_id,
      isAuthenticated,
      thread.thread_id
    );
    const { requestTools, processOptions, effectiveModel } = buildTieredAccess(
      prepared.requestTools,
      isAuthenticated
    );

    // 5. Build email-specific system context
    const emailSystemContext = buildEmailSystemContext(input, prepared.requestContext);

    // 6. Process with Claude.
    //
    // Per-user cost cap scope (#2790 / #2950): email is the highest-
    // priority bypass vector because From headers are spoofable — a
    // cooperative mail server can hit Claude with any identity it
    // wants. We hash the From address (rather than use it raw) so
    // the scope key and surrounding logs don't carry sender PII.
    // 16 hex = 64 bits; for realistic sender volumes, collision is
    // negligible (birthday bound well above any plausible corpus).
    // The upstream 10-emails-per-hour per-sender limiter already
    // bounds single-sender abuse; the cost cap is the second line
    // of defense against a spoofing mail server.
    const emailScopeKey = `email:${crypto
      .createHash('sha256')
      .update(input.senderEmail.toLowerCase().trim())
      .digest('hex')
      .substring(0, 16)}`;

    const claudeClient = await getChatClaudeClient();
    const response = await claudeClient.processMessage(
      prepared.messageToProcess,
      contextMessages,
      requestTools,
      undefined,
      {
        ...processOptions,
        requestContext: emailSystemContext,
        threadId: thread.thread_id,
        userDisplayName: input.senderDisplayName || undefined,
        costScope: { userId: emailScopeKey, tier: 'anonymous' },
      }
    );

    // 7. Validate and send email reply
    const outputValidation = validateOutput(response.text);
    const htmlContent = markdownToEmailHtml(outputValidation.sanitized);

    const threadContext: EmailThreadContext = {
      messageId: input.messageId,
      references: input.references,
      subject: input.subject,
      from: input.from,
      to: input.to,
      cc: input.cc,
      originalText: input.textContent,
    };

    const replyResult = await sendEmailReply({
      threadContext,
      htmlContent,
      textContent: outputValidation.sanitized,
      fromEmail: input.addieAddress.includes('+')
        ? input.addieAddress
        : 'addie@agenticadvertising.org',
    });

    if (!replyResult.success) {
      logger.error({ error: replyResult.error, emailId: input.emailId }, 'Failed to send email reply');
      return { responded: false, threadId: thread.thread_id, error: replyResult.error };
    }

    // 8. Store assistant message with sent email's ID for future threading
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'assistant',
      content: outputValidation.sanitized,
      tools_used: response.tools_used.length > 0 ? response.tools_used : undefined,
      tool_calls: response.tool_executions.length > 0
        ? response.tool_executions.map(exec => ({
            name: exec.tool_name,
            input: exec.parameters,
            result: exec.result,
            duration_ms: exec.duration_ms,
          }))
        : undefined,
      model: effectiveModel,
      latency_ms: Date.now() - startTime,
      tokens_input: response.usage?.input_tokens,
      tokens_output: response.usage?.output_tokens,
      tokens_cache_creation: response.usage?.cache_creation_input_tokens,
      tokens_cache_read: response.usage?.cache_read_input_tokens,
      timing: response.timing ? {
        system_prompt_ms: response.timing.system_prompt_ms,
        total_llm_ms: response.timing.total_llm_ms,
        total_tool_ms: response.timing.total_tool_execution_ms,
        iterations: response.timing.iterations,
      } : undefined,
      active_rule_ids: response.active_rule_ids,
      config_version_id: response.config_version_id,
      flagged: outputValidation.flagged,
      flag_reason: outputValidation.reason,
      email_message_id: replyResult.messageId,
    });

    logger.info({
      emailId: input.emailId,
      threadId: thread.thread_id,
      responseMessageId: replyResult.messageId,
      toolsUsed: response.tools_used,
      latencyMs: Date.now() - startTime,
      addiePosition: input.addiePosition,
      isAuthenticated,
    }, 'Addie responded to email conversation');

    return { responded: true, threadId: thread.thread_id };
  } catch (error) {
    logger.error({ error, emailId: input.emailId }, 'Error handling email conversation');
    return { responded: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// --- Thread resolution ---

async function resolveThread(
  input: EmailConversationInput,
  threadService: ReturnType<typeof getThreadService>
): Promise<Thread> {
  // Tier 1: Look up In-Reply-To header in stored message IDs
  // Verify sender matches thread owner to prevent thread hijacking via crafted headers
  if (input.inReplyTo) {
    const thread = await threadService.findThreadByEmailMessageId(input.inReplyTo);
    if (thread && thread.user_id === input.senderEmail) {
      logger.info({ threadId: thread.thread_id, inReplyTo: input.inReplyTo }, 'Found thread via In-Reply-To');
      return thread;
    }
    if (thread) {
      logger.warn({
        threadId: thread.thread_id,
        inReplyTo: input.inReplyTo,
        threadOwner: thread.user_id,
        sender: input.senderEmail,
      }, 'In-Reply-To matched thread owned by different sender, ignoring');
    }
  }

  // Tier 2: Find recent thread from same sender with same subject
  const thread = await threadService.findRecentEmailThread(input.senderEmail, input.subject);
  if (thread) {
    logger.info({ threadId: thread.thread_id, senderEmail: input.senderEmail }, 'Found thread via recent sender + subject');
    return thread;
  }

  // Tier 3: Create new thread
  // Always use sender email as user_id (not WorkOS ID) since email identity is unverified
  const newThread = await threadService.getOrCreateThread({
    channel: 'email',
    external_id: `email:${input.messageId}`,
    user_type: 'anonymous',
    user_id: input.senderEmail,
    user_display_name: input.senderDisplayName,
    context: {
      sender_email: input.senderEmail,
      subject: input.subject,
    },
    title: input.subject,
  });

  logger.info({ threadId: newThread.thread_id, senderEmail: input.senderEmail }, 'Created new email thread');
  return newThread;
}

// --- System context ---

/**
 * Sanitize email header fields before injecting into system prompt.
 * Strips newlines (prevent prompt injection via header manipulation) and limits length.
 */
function sanitizeHeaderField(value: string, maxLength = 200): string {
  return value.replace(/[\r\n]/g, ' ').trim().substring(0, maxLength);
}

function buildEmailSystemContext(
  input: EmailConversationInput,
  baseContext: string
): string {
  const sections: string[] = [];

  if (baseContext) {
    sections.push(baseContext);
  }

  const safeSubject = sanitizeHeaderField(input.subject);
  const safeFrom = sanitizeHeaderField(input.from);

  sections.push(`[EMAIL CONTEXT]
Subject: ${safeSubject}
From: ${safeFrom}
Channel: email (${input.addiePosition === 'cc' ? 'CC\'d' : 'direct'})`);

  if (input.addiePosition === 'cc') {
    sections.push(`[EMAIL BEHAVIOR]
You were CC'd on this conversation between other people. Only contribute if you can add specific value — a lookup, a link, a factual answer. Don't paraphrase what others said. Don't insert yourself unnecessarily.`);
  } else {
    sections.push(`[EMAIL BEHAVIOR]
You are responding to a direct email. Be concise and professional. Your response will be sent as an email reply.
- Keep responses focused and scannable
- Avoid markdown that doesn't render well in email (no code blocks with backtick fences, no tables)
- Don't include greetings like "Hi" unless this is the first message in the thread
- Use short paragraphs and bullet points for readability`);
  }

  return sections.join('\n\n');
}
