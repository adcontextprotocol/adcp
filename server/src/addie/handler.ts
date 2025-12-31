/**
 * Addie Event Handler
 *
 * Handles Slack Assistant events and @mentions
 */

import { logger } from '../logger.js';
import { sendChannelMessage } from '../slack/client.js';
import { AddieClaudeClient } from './claude-client.js';
import {
  sanitizeInput,
  validateOutput,
  stripBotMention,
  logInteraction,
  generateInteractionId,
} from './security.js';
import {
  initializeKnowledgeSearch,
  isKnowledgeReady,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from './mcp/knowledge-search.js';
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from './mcp/billing-tools.js';
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
  isSlackUserAdmin,
} from './mcp/admin-tools.js';
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from './mcp/member-tools.js';
import { AddieDatabase } from '../db/addie-db.js';
import { SUGGESTED_PROMPTS, STATUS_MESSAGES } from './prompts.js';
import { AddieModelConfig } from '../config/models.js';
import { getMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import type { RequestTools } from './claude-client.js';
import type {
  AssistantThreadStartedEvent,
  AppMentionEvent,
  AssistantMessageEvent,
  AddieInteractionLog,
  SuggestedPrompt,
} from './types.js';

let claudeClient: AddieClaudeClient | null = null;
let addieDb: AddieDatabase | null = null;
let initialized = false;
let botUserId: string | null = null;

/**
 * Initialize Addie
 */
export async function initializeAddie(): Promise<void> {
  const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    logger.warn('Addie: No ANTHROPIC_API_KEY configured, Addie will be disabled');
    return;
  }

  logger.info('Addie: Initializing...');

  // Initialize Claude client
  claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);

  // Initialize database access
  addieDb = new AddieDatabase();

  // Initialize knowledge search (database-backed)
  await initializeKnowledgeSearch();

  // Register knowledge tools
  const knowledgeHandlers = createKnowledgeToolHandlers();
  for (const tool of KNOWLEDGE_TOOLS) {
    const handler = knowledgeHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register billing tools (for membership signup assistance)
  const billingHandlers = createBillingToolHandlers();
  for (const tool of BILLING_TOOLS) {
    const handler = billingHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register admin tools (available to admin users only - enforced via instructions)
  const adminHandlers = createAdminToolHandlers();
  for (const tool of ADMIN_TOOLS) {
    const handler = adminHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  initialized = true;
  logger.info({ tools: claudeClient.getRegisteredTools() }, 'Addie: Ready');
}

/**
 * Set the bot user ID (for stripping mentions)
 */
export function setAddieBotUserId(userId: string): void {
  botUserId = userId;
}

/**
 * Invalidate the cached system prompt (call after rule changes)
 * This forces Addie to reload rules from the database on next message
 */
export function invalidateAddieRulesCache(): void {
  if (claudeClient) {
    claudeClient.invalidateCache();
    logger.info('Addie: Rules cache invalidated');
  }
}

/**
 * Check if Addie is ready
 */
export function isAddieReady(): boolean {
  return initialized && claudeClient !== null && isKnowledgeReady();
}

/**
 * Build message with member context prepended
 *
 * Fetches member context for the user and formats it as a prefix to the message.
 * Also returns the member context for use in creating user-scoped tools.
 * Gracefully degrades to just the original message if context lookup fails.
 */
async function buildMessageWithMemberContext(
  userId: string,
  sanitizedMessage: string,
  isAdmin: boolean
): Promise<{ message: string; memberContext: MemberContext | null }> {
  try {
    const memberContext = await getMemberContext(userId);
    const memberContextText = formatMemberContextForPrompt(memberContext);

    // Build message with admin prefix if applicable
    let baseMessage = sanitizedMessage;
    if (isAdmin) {
      baseMessage = `[ADMIN USER] ${sanitizedMessage}`;
    }

    if (memberContextText) {
      return {
        message: `${memberContextText}\n---\n\n${baseMessage}`,
        memberContext,
      };
    }
    return { message: baseMessage, memberContext };
  } catch (error) {
    logger.warn({ error, userId }, 'Addie: Failed to get member context, continuing without it');
    // Still add admin prefix if applicable
    const baseMessage = isAdmin ? `[ADMIN USER] ${sanitizedMessage}` : sanitizedMessage;
    return { message: baseMessage, memberContext: null };
  }
}

/**
 * Create user-scoped member tools
 * These tools are created per-request with the user's context
 */
function createUserScopedTools(memberContext: MemberContext | null): RequestTools {
  const handlers = createMemberToolHandlers(memberContext);
  return {
    tools: MEMBER_TOOLS,
    handlers,
  };
}

/**
 * Build dynamic suggested prompts based on user context
 */
async function buildDynamicSuggestedPrompts(userId: string): Promise<SuggestedPrompt[]> {
  try {
    const memberContext = await getMemberContext(userId);

    // Not linked - prioritize account setup
    if (!memberContext.workos_user?.workos_user_id) {
      return [
        {
          title: 'Link my account',
          message: 'Help me link my Slack account to AgenticAdvertising.org',
        },
        {
          title: 'Learn about AdCP',
          message: 'What is AdCP and how does it work?',
        },
        {
          title: 'Why join AgenticAdvertising.org?',
          message: 'What are the benefits of joining AgenticAdvertising.org?',
        },
      ];
    }

    // Linked but maybe not a member - suggest getting involved
    const prompts: SuggestedPrompt[] = [];

    // Personalized: Show working groups if they have some
    if (memberContext.working_groups && memberContext.working_groups.length > 0) {
      prompts.push({
        title: 'My working groups',
        message: 'What\'s happening in my working groups?',
      });
    } else {
      prompts.push({
        title: 'Find a working group',
        message: 'What working groups can I join based on my interests?',
      });
    }

    // Add agent testing prompt
    prompts.push({
      title: 'Test my agent',
      message: 'Help me verify my AdCP agent is working correctly',
    });

    // Standard prompts
    prompts.push({
      title: 'Learn about AdCP',
      message: 'What is AdCP and how does it work?',
    });

    prompts.push({
      title: 'AdCP vs programmatic',
      message: 'How is agentic advertising different from programmatic?',
    });

    return prompts.slice(0, 4); // Slack limits to 4 prompts
  } catch (error) {
    logger.warn({ error, userId }, 'Addie: Failed to build dynamic prompts, using defaults');
    return SUGGESTED_PROMPTS;
  }
}

/**
 * Handle Assistant thread started event
 */
export async function handleAssistantThreadStarted(
  event: AssistantThreadStartedEvent
): Promise<void> {
  if (!initialized || !claudeClient) {
    logger.warn('Addie: Not initialized, ignoring assistant_thread_started');
    return;
  }

  logger.info(
    { userId: event.assistant_thread.user_id, channelId: event.channel_id },
    'Addie: Assistant thread started'
  );

  // Set dynamic suggested prompts based on user context
  try {
    const prompts = await buildDynamicSuggestedPrompts(event.assistant_thread.user_id);
    await setAssistantSuggestedPrompts(event.channel_id, prompts);
  } catch (error) {
    logger.error({ error }, 'Addie: Failed to set suggested prompts');
  }
}

/**
 * Handle message in Assistant thread
 */
export async function handleAssistantMessage(
  event: AssistantMessageEvent,
  channelId: string
): Promise<void> {
  if (!initialized || !claudeClient) {
    logger.warn('Addie: Not initialized, ignoring message');
    return;
  }

  const startTime = Date.now();
  const interactionId = generateInteractionId();

  // Check if user is an admin (for admin-only tools access)
  const isAdmin = await isSlackUserAdmin(event.user);
  logger.debug({ userId: event.user, isAdmin }, 'Addie: Checked admin status');

  // Sanitize input
  const inputValidation = sanitizeInput(event.text);

  // Set status to thinking
  try {
    await setAssistantStatus(channelId, STATUS_MESSAGES.thinking);
  } catch {
    // Status update failed, continue anyway
  }

  // Build message with member context for personalization (includes admin prefix if admin)
  const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
    event.user,
    inputValidation.sanitized,
    isAdmin
  );

  // Create user-scoped tools (these can only operate on behalf of this user)
  const userTools = createUserScopedTools(memberContext);

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, undefined, userTools);
  } catch (error) {
    logger.error({ error }, 'Addie: Error processing message');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }

  // Validate output
  const outputValidation = validateOutput(response.text);

  // Send response using Addie's bot token
  try {
    await sendChannelMessage(channelId, {
      text: outputValidation.sanitized,
      thread_ts: event.thread_ts,
    }, true); // useAddieToken = true
  } catch (error) {
    logger.error({ error }, 'Addie: Failed to send response');
  }

  // Clear status
  try {
    await setAssistantStatus(channelId, '');
  } catch {
    // Ignore
  }

  // Log interaction
  const flagged = inputValidation.flagged || response.flagged || outputValidation.flagged;
  const flagReason = [inputValidation.reason, response.flag_reason, outputValidation.reason]
    .filter(Boolean)
    .join('; ');

  const log: AddieInteractionLog = {
    id: interactionId,
    timestamp: new Date(),
    event_type: 'assistant_thread',
    channel_id: channelId,
    thread_ts: event.thread_ts,
    user_id: event.user,
    input_text: event.text,
    input_sanitized: inputValidation.sanitized,
    output_text: outputValidation.sanitized,
    tools_used: response.tools_used,
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged,
    flag_reason: flagReason || undefined,
  };

  // Log to console and database
  logInteraction(log);
  if (addieDb) {
    try {
      await addieDb.logInteraction(log);
    } catch (error) {
      logger.error({ error }, 'Addie: Failed to log interaction to database');
    }
  }
}

/**
 * Handle @mention in a channel
 */
export async function handleAppMention(event: AppMentionEvent): Promise<void> {
  if (!initialized || !claudeClient) {
    logger.warn('Addie: Not initialized, ignoring mention');
    return;
  }

  const startTime = Date.now();
  const interactionId = generateInteractionId();

  // Check if user is an admin (for admin-only tools access)
  const isAdmin = await isSlackUserAdmin(event.user);
  logger.debug({ userId: event.user, isAdmin }, 'Addie: Checked admin status for mention');

  // Strip bot mention
  const rawText = botUserId ? stripBotMention(event.text, botUserId) : event.text;

  // Sanitize input
  const inputValidation = sanitizeInput(rawText);

  // Build message with member context for personalization (includes admin prefix if admin)
  const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
    event.user,
    inputValidation.sanitized,
    isAdmin
  );

  // Create user-scoped tools (these can only operate on behalf of this user)
  const userTools = createUserScopedTools(memberContext);

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, undefined, userTools);
  } catch (error) {
    logger.error({ error }, 'Addie: Error processing mention');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }

  // Validate output
  const outputValidation = validateOutput(response.text);

  // Send response in thread using Addie's bot token
  try {
    await sendChannelMessage(event.channel, {
      text: outputValidation.sanitized,
      thread_ts: event.thread_ts || event.ts,
    }, true); // useAddieToken = true
  } catch (error) {
    logger.error({ error }, 'Addie: Failed to send mention response');
  }

  // Log interaction
  const flagged = inputValidation.flagged || response.flagged || outputValidation.flagged;
  const flagReason = [inputValidation.reason, response.flag_reason, outputValidation.reason]
    .filter(Boolean)
    .join('; ');

  const log: AddieInteractionLog = {
    id: interactionId,
    timestamp: new Date(),
    event_type: 'mention',
    channel_id: event.channel,
    thread_ts: event.thread_ts,
    user_id: event.user,
    input_text: rawText,
    input_sanitized: inputValidation.sanitized,
    output_text: outputValidation.sanitized,
    tools_used: response.tools_used,
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged,
    flag_reason: flagReason || undefined,
  };

  // Log to console and database
  logInteraction(log);
  if (addieDb) {
    try {
      await addieDb.logInteraction(log);
    } catch (error) {
      logger.error({ error }, 'Addie: Failed to log interaction to database');
    }
  }
}

/**
 * Set suggested prompts for Assistant thread
 * Uses Slack's assistant.threads.setSuggestedPrompts API
 */
async function setAssistantSuggestedPrompts(
  channelId: string,
  prompts: SuggestedPrompt[]
): Promise<void> {
  const token = process.env.ADDIE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  const response = await fetch('https://slack.com/api/assistant.threads.setSuggestedPrompts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: channelId,
      prompts: prompts.map(p => ({ title: p.title, message: p.message })),
    }),
  });

  const data = await response.json() as { ok: boolean; error?: string };
  if (!data.ok) {
    logger.warn({ error: data.error }, 'Addie: Failed to set suggested prompts');
  }
}

/**
 * Set status message for Assistant thread
 * Uses Slack's assistant.threads.setStatus API
 */
async function setAssistantStatus(channelId: string, status: string): Promise<void> {
  const token = process.env.ADDIE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  const response = await fetch('https://slack.com/api/assistant.threads.setStatus', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: channelId,
      status,
    }),
  });

  const data = await response.json() as { ok: boolean; error?: string };
  if (!data.ok && data.error !== 'not_in_channel') {
    logger.debug({ error: data.error }, 'Addie: Failed to set status');
  }
}

/**
 * Send a proactive message when a user links their account
 * Called from the auth callback after successful account linking
 */
export async function sendAccountLinkedMessage(
  slackUserId: string,
  userName?: string
): Promise<boolean> {
  if (!initialized || !addieDb) {
    logger.warn('Addie: Not initialized, cannot send account linked message');
    return false;
  }

  // Find the user's most recent Addie thread (within 30 minutes)
  const recentThread = await addieDb.getUserRecentThread(slackUserId, 30);
  if (!recentThread) {
    logger.debug({ slackUserId }, 'Addie: No recent thread found for account linked message');
    return false;
  }

  // Build a personalized message
  const greeting = userName ? `Thanks for linking your account, ${userName}!` : 'Thanks for linking your account!';
  const message = `${greeting} 🎉\n\nI can now see your profile and help you get more involved with AgenticAdvertising.org. What would you like to do next?`;

  // Send the message
  try {
    await sendChannelMessage(recentThread.channel_id, {
      text: message,
      thread_ts: recentThread.thread_ts,
    }, true); // useAddieToken = true
    logger.info({ slackUserId, channelId: recentThread.channel_id }, 'Addie: Sent account linked message');
    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie: Failed to send account linked message');
    return false;
  }
}
