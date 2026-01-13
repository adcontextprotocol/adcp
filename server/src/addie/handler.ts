/**
 * Addie Event Handler
 *
 * Handles Slack Assistant events and @mentions
 */

import { logger } from '../logger.js';
import { sendChannelMessage } from '../slack/client.js';
import { AddieClaudeClient, ADMIN_MAX_ITERATIONS, type UserScopedToolsResult } from './claude-client.js';
import {
  sanitizeInput,
  validateOutput,
  stripBotMention,
  resolveSlackMentions,
  logInteraction,
  generateInteractionId,
} from './security.js';
import { SlackDatabase } from '../db/slack-db.js';
import {
  initializeKnowledgeSearch,
  isKnowledgeReady,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
  createUserScopedBookmarkHandler,
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
import {
  EVENT_TOOLS,
  createEventToolHandlers,
  canCreateEvents,
} from './mcp/event-tools.js';
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from './mcp/directory-tools.js';
import {
  MEETING_TOOLS,
  createMeetingToolHandlers,
} from './mcp/meeting-tools.js';
import {
  ESCALATION_TOOLS,
  createEscalationToolHandlers,
} from './mcp/escalation-tools.js';
import { AddieDatabase } from '../db/addie-db.js';
import { SUGGESTED_PROMPTS, STATUS_MESSAGES, buildDynamicSuggestedPrompts } from './prompts.js';
import { AddieModelConfig } from '../config/models.js';
import { getMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import {
  extractInsights,
  checkAndMarkOutreachResponse,
  getGoalsForSystemPrompt,
  type ExtractionContext,
} from './services/insight-extractor.js';
import { checkForSensitiveTopics } from './sensitive-topics.js';
import type { RequestTools } from './claude-client.js';
import type {
  AssistantThreadStartedEvent,
  AppMentionEvent,
  AssistantMessageEvent,
  AddieInteractionLog,
  SuggestedPrompt,
} from './types.js';

/**
 * Slack's built-in system bot user ID.
 * Slackbot sends system notifications (e.g., "added you to #channel") that should be ignored.
 */
const SLACKBOT_USER_ID = 'USLACKBOT';

let claudeClient: AddieClaudeClient | null = null;
let addieDb: AddieDatabase | null = null;
let slackDb: SlackDatabase | null = null;
let initialized = false;
let botUserId: string | null = null;

/**
 * Look up a Slack user's name by their Slack user ID
 */
async function lookupSlackUserName(slackUserId: string): Promise<string | null> {
  if (!slackDb) return null;
  try {
    const mapping = await slackDb.getBySlackUserId(slackUserId);
    return mapping?.slack_real_name || mapping?.slack_display_name || null;
  } catch (error) {
    logger.warn({ error, slackUserId }, 'Failed to look up Slack user name');
    return null;
  }
}

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
  slackDb = new SlackDatabase();

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

  // Register directory tools (lookup members, agents, publishers)
  const directoryHandlers = createDirectoryToolHandlers();
  for (const tool of DIRECTORY_TOOLS) {
    const handler = directoryHandlers.get(tool.name);
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

    // Get insight goals to naturally work into conversation
    const isMapped = !!memberContext?.is_mapped;
    let insightGoalsText = '';
    try {
      const goalsPrompt = await getGoalsForSystemPrompt(isMapped);
      if (goalsPrompt) {
        insightGoalsText = goalsPrompt;
      }
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to get insight goals for prompt');
    }

    if (memberContextText || insightGoalsText) {
      const sections = [memberContextText, insightGoalsText].filter(Boolean);
      return {
        message: `${sections.join('\n\n')}\n---\n\n${baseMessage}`,
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
 * Admin users also get access to admin tools
 * Event creators (admin or committee leads) get access to event tools
 */
async function createUserScopedTools(
  memberContext: MemberContext | null,
  slackUserId?: string,
  threadId?: string
): Promise<UserScopedToolsResult> {
  const memberHandlers = createMemberToolHandlers(memberContext);
  const allTools = [...MEMBER_TOOLS];
  const allHandlers = new Map(memberHandlers);

  // Add escalation tools (available to all users)
  const escalationHandlers = createEscalationToolHandlers(memberContext, slackUserId, threadId);
  allTools.push(...ESCALATION_TOOLS);
  for (const [name, handler] of escalationHandlers) {
    allHandlers.set(name, handler);
  }

  // Check if user is AAO admin (based on aao-admin working group membership)
  const userIsAdmin = slackUserId ? await isSlackUserAdmin(slackUserId) : false;

  // Add admin tools if user is admin
  if (userIsAdmin) {
    const adminHandlers = createAdminToolHandlers(memberContext);
    allTools.push(...ADMIN_TOOLS);
    for (const [name, handler] of adminHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie: Admin tools enabled for this user');
  }

  // Add event tools if user can create events (admin or committee lead)
  const canCreate = slackUserId ? await canCreateEvents(slackUserId) : userIsAdmin;
  if (canCreate) {
    const eventHandlers = createEventToolHandlers(memberContext, slackUserId);
    allTools.push(...EVENT_TOOLS);
    for (const [name, handler] of eventHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie: Event tools enabled for this user');

    // Add meeting tools (same permission as event tools)
    const meetingHandlers = createMeetingToolHandlers(memberContext, slackUserId);
    allTools.push(...MEETING_TOOLS);
    for (const [name, handler] of meetingHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie: Meeting tools enabled for this user');
  }

  // Override bookmark_resource handler with user-scoped version (for attribution)
  if (slackUserId) {
    allHandlers.set('bookmark_resource', createUserScopedBookmarkHandler(slackUserId));
  }

  return {
    tools: {
      tools: allTools,
      handlers: allHandlers,
    },
    isAdmin: userIsAdmin,
  };
}

/**
 * Get dynamic suggested prompts for a Slack user
 */
async function getDynamicSuggestedPrompts(userId: string): Promise<SuggestedPrompt[]> {
  try {
    const memberContext = await getMemberContext(userId);
    const userIsAdmin = await isSlackUserAdmin(userId);
    return buildDynamicSuggestedPrompts(memberContext, userIsAdmin);
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
    const prompts = await getDynamicSuggestedPrompts(event.assistant_thread.user_id);
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

  // Skip Slackbot system messages (e.g., "added you to #channel")
  if (event.user === SLACKBOT_USER_ID) {
    logger.debug({ messageText: event.text?.substring(0, 50) }, 'Addie: Ignoring Slackbot system message');
    return;
  }

  const startTime = Date.now();
  const interactionId = generateInteractionId();

  // Check if user is an admin (for admin-only tools access)
  const isAdmin = await isSlackUserAdmin(event.user);
  logger.debug({ userId: event.user, isAdmin }, 'Addie: Checked admin status');

  // Resolve user mentions to include names (e.g., <@U123> -> <@U123|John>)
  const textWithResolvedMentions = await resolveSlackMentions(event.text, lookupSlackUserName);

  // Sanitize input
  const inputValidation = sanitizeInput(textWithResolvedMentions);

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

  // Check for sensitive topics before processing
  const sensitiveCheck = await checkForSensitiveTopics(
    inputValidation.sanitized,
    event.user,
    channelId
  );

  // If we should deflect, return the deflection response instead of processing
  let response;
  if (sensitiveCheck.shouldDeflect && sensitiveCheck.deflectResponse) {
    logger.info({
      userId: event.user,
      category: sensitiveCheck.topicResult.category,
      severity: sensitiveCheck.topicResult.severity,
      isKnownMedia: sensitiveCheck.isKnownMedia,
    }, 'Addie: Deflecting sensitive topic');

    response = {
      text: sensitiveCheck.deflectResponse,
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Sensitive topic deflection: ${sensitiveCheck.topicResult.category}`,
    };
  } else {
    // Create user-scoped tools (these can only operate on behalf of this user)
    const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, event.user, event.thread_ts);

    // Admin users get higher iteration limit for bulk operations
    const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

    // Process with Claude
    try {
      response = await claudeClient.processMessage(messageWithContext, undefined, userTools, undefined, processOptions);
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
  }

  // Validate output
  const outputValidation = validateOutput(response.text);

  // Send response
  try {
    await sendChannelMessage(channelId, {
      text: outputValidation.sanitized,
      thread_ts: event.thread_ts,
    });
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

  // Extract insights from the user's message (async, don't block response)
  const extractionContext: ExtractionContext = {
    slackUserId: event.user,
    workosUserId: memberContext?.workos_user?.workos_user_id,
    threadId: event.thread_ts,
    isMapped: memberContext?.is_mapped ?? false,
  };
  extractInsights(inputValidation.sanitized, extractionContext)
    .then(result => {
      if (!result.skipped && (result.insights.length > 0 || result.goal_responses.length > 0)) {
        // Check if this was a response to proactive outreach
        checkAndMarkOutreachResponse(event.user, result.insights.length > 0);
      }
    })
    .catch(error => {
      logger.error({ error }, 'Addie: Error during insight extraction');
    });
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

  // Resolve user mentions to include names (e.g., <@U123> -> <@U123|John>)
  const textWithResolvedMentions = await resolveSlackMentions(rawText, lookupSlackUserName);

  // Sanitize input
  const inputValidation = sanitizeInput(textWithResolvedMentions);

  // Build message with member context for personalization (includes admin prefix if admin)
  const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
    event.user,
    inputValidation.sanitized,
    isAdmin
  );

  // Check for sensitive topics before processing (channel mentions are more public)
  const sensitiveCheck = await checkForSensitiveTopics(
    inputValidation.sanitized,
    event.user,
    event.channel
  );

  // If we should deflect, return the deflection response instead of processing
  let response;
  if (sensitiveCheck.shouldDeflect && sensitiveCheck.deflectResponse) {
    logger.info({
      userId: event.user,
      channel: event.channel,
      category: sensitiveCheck.topicResult.category,
      severity: sensitiveCheck.topicResult.severity,
      isKnownMedia: sensitiveCheck.isKnownMedia,
    }, 'Addie: Deflecting sensitive topic (mention)');

    response = {
      text: sensitiveCheck.deflectResponse,
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Sensitive topic deflection: ${sensitiveCheck.topicResult.category}`,
    };
  } else {
    // Create user-scoped tools (these can only operate on behalf of this user)
    const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, event.user, event.thread_ts || event.ts);

    // Admin users get higher iteration limit for bulk operations
    const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

    // Process with Claude
    try {
      response = await claudeClient.processMessage(messageWithContext, undefined, userTools, undefined, processOptions);
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
  }

  // Validate output
  const outputValidation = validateOutput(response.text);

  // Send response in thread
  try {
    await sendChannelMessage(event.channel, {
      text: outputValidation.sanitized,
      thread_ts: event.thread_ts || event.ts,
    });
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

  // Extract insights from the user's message (async, don't block response)
  const mentionExtractionContext: ExtractionContext = {
    slackUserId: event.user,
    workosUserId: memberContext?.workos_user?.workos_user_id,
    threadId: event.thread_ts || event.ts,
    isMapped: memberContext?.is_mapped ?? false,
  };
  extractInsights(inputValidation.sanitized, mentionExtractionContext)
    .then(result => {
      if (!result.skipped && (result.insights.length > 0 || result.goal_responses.length > 0)) {
        // Check if this was a response to proactive outreach
        checkAndMarkOutreachResponse(event.user, result.insights.length > 0);
      }
    })
    .catch(error => {
      logger.error({ error }, 'Addie: Error during insight extraction (mention)');
    });
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
    });
    logger.info({ slackUserId, channelId: recentThread.channel_id }, 'Addie: Sent account linked message');
    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie: Failed to send account linked message');
    return false;
  }
}
