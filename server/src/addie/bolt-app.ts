/**
 * Addie Bolt App
 *
 * Slack Bolt application for Addie using the Assistant class.
 * Handles:
 * - assistant_thread_started: User opens Addie
 * - assistant_thread_context_changed: User switches channels while Addie is open
 * - userMessage: User sends a message to Addie
 * - app_mention: User @mentions Addie in a channel
 *
 * Uses ExpressReceiver to integrate with our existing Express server.
 */

// @slack/bolt is CommonJS - for ESM compatibility we need:
// - Named exports (App, Assistant, LogLevel) are on the namespace
// - ExpressReceiver is on the default export
import * as bolt from '@slack/bolt';
const { App, Assistant, LogLevel } = bolt;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ExpressReceiver = (bolt as any).default?.ExpressReceiver ?? (bolt as any).ExpressReceiver;
import type { SlackEventMiddlewareArgs } from '@slack/bolt';
// Import internal Assistant types for handler signatures
import type {
  AssistantThreadStartedMiddlewareArgs,
  AssistantThreadContextChangedMiddlewareArgs,
  AssistantUserMessageMiddlewareArgs,
  AllAssistantMiddlewareArgs,
} from '@slack/bolt/dist/Assistant';
import type { Router } from 'express';
import { logger } from '../logger.js';
import { AddieClaudeClient, ADMIN_MAX_ITERATIONS, type UserScopedToolsResult } from './claude-client.js';
import { AddieDatabase } from '../db/addie-db.js';
import {
  initializeKnowledgeSearch,
  isKnowledgeReady,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from './mcp/knowledge-search.js';
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from './mcp/member-tools.js';
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
  isSlackUserAdmin,
} from './mcp/admin-tools.js';
import {
  EVENT_TOOLS,
  createEventToolHandlers,
  canCreateEvents,
} from './mcp/event-tools.js';
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from './mcp/billing-tools.js';
import { SUGGESTED_PROMPTS, buildDynamicSuggestedPrompts } from './prompts.js';
import { AddieModelConfig } from '../config/models.js';
import { getMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import {
  sanitizeInput,
  validateOutput,
  logInteraction,
} from './security.js';
import type { RequestTools } from './claude-client.js';
import type { SuggestedPrompt } from './types.js';
import { DatabaseThreadContextStore } from './thread-context-store.js';
import { getThreadService, type ThreadContext } from './thread-service.js';
import { getThreadReplies, getSlackUser, getChannelInfo } from '../slack/client.js';
import { AddieRouter, type RoutingContext, type ExecutionPlan } from './router.js';
import { getCachedInsights, prefetchInsights } from './insights-cache.js';
import { getHomeContent, renderHomeView, renderErrorView, invalidateHomeCache } from './home/index.js';
import { URL_TOOLS, createUrlToolHandlers } from './mcp/url-tools.js';
import { initializeEmailHandler } from './email-handler.js';
import {
  isManagedChannel,
  extractArticleUrls,
  queueCommunityArticle,
} from './services/community-articles.js';

/**
 * Slack's built-in system bot user ID.
 * Slackbot sends system notifications (e.g., "added you to #channel") that should be ignored.
 */
const SLACKBOT_USER_ID = 'USLACKBOT';

/**
 * Slack attachment type for forwarded messages
 */
interface SlackAttachment {
  author_name?: string;
  pretext?: string;
  text?: string;
  footer?: string;
  fallback?: string;
  title?: string;
  title_link?: string;
}

/**
 * Slack file type for file shares
 */
interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  permalink?: string;
}

/**
 * Reactions that mean "yes, proceed" or "approved"
 */
const POSITIVE_REACTIONS = new Set([
  'thumbsup', '+1', 'white_check_mark', 'heavy_check_mark', 'ok', 'ok_hand',
  'the_horns', 'raised_hands', 'clap', 'fire', 'rocket', 'star', 'heart',
  'green_heart', 'blue_heart', 'tada', 'sparkles', 'muscle', 'pray',
]);

/**
 * Reactions that mean "no, don't proceed" or "rejected"
 */
const NEGATIVE_REACTIONS = new Set([
  'thumbsdown', '-1', 'x', 'negative_squared_cross_mark', 'no_entry',
  'no_entry_sign', 'octagonal_sign', 'stop_sign', 'hand', 'raised_hand',
]);

/**
 * Extract text content from forwarded messages in Slack attachments.
 * When users forward a message, Slack puts the forwarded content in the attachments array.
 */
function extractForwardedContent(attachments?: SlackAttachment[]): string {
  if (!attachments || attachments.length === 0) {
    return '';
  }

  const attachmentTexts: string[] = [];
  for (const attachment of attachments) {
    const parts: string[] = [];
    if (attachment.author_name) {
      parts.push(`From: ${attachment.author_name}`);
    }
    if (attachment.pretext) {
      parts.push(attachment.pretext);
    }
    if (attachment.text) {
      parts.push(attachment.text);
    }
    if (attachment.footer) {
      parts.push(`(${attachment.footer})`);
    }
    if (parts.length > 0) {
      attachmentTexts.push(parts.join('\n'));
    }
  }

  if (attachmentTexts.length === 0) {
    return '';
  }

  logger.debug({ attachmentCount: attachments.length, extractedLength: attachmentTexts.join('').length }, 'Addie Bolt: Extracted forwarded message content from attachments');
  return `\n\n[Forwarded message]\n${attachmentTexts.join('\n---\n')}`;
}

/**
 * Extract file information from Slack file shares.
 * Provides context about shared files so Claude knows what was shared.
 */
function extractFileInfo(files?: SlackFile[]): string {
  if (!files || files.length === 0) {
    return '';
  }

  const fileDescriptions: string[] = [];
  for (const file of files) {
    const parts: string[] = [];
    const name = file.title || file.name || 'Unnamed file';
    parts.push(`File: ${name}`);
    if (file.filetype) {
      parts.push(`Type: ${file.filetype.toUpperCase()}`);
    }
    if (file.size) {
      const sizeKB = Math.round(file.size / 1024);
      parts.push(`Size: ${sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`}`);
    }
    if (file.permalink) {
      parts.push(`Link: ${file.permalink}`);
    }
    fileDescriptions.push(parts.join(' | '));
  }

  logger.debug({ fileCount: files.length }, 'Addie Bolt: Extracted file information');
  return `\n\n[Shared files]\n${fileDescriptions.join('\n')}`;
}

/**
 * Extract URLs from message text for context.
 * Returns a list of URLs that could be fetched for more context.
 */
function extractUrls(text: string): string[] {
  // Match URLs in Slack format <url|label> or plain URLs
  const slackUrlPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>|(?<![<|])(https?:\/\/[^\s<>]+)/gi;
  const urls: string[] = [];
  let match;
  while ((match = slackUrlPattern.exec(text)) !== null) {
    const url = match[1] || match[2];
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

let boltApp: InstanceType<typeof App> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let expressReceiver: any = null;
let claudeClient: AddieClaudeClient | null = null;

/**
 * Fetch channel info and build a partial ThreadContext with channel details
 */
async function buildChannelContext(channelId: string): Promise<Partial<ThreadContext>> {
  const context: Partial<ThreadContext> = {
    viewing_channel_id: channelId,
  };

  try {
    const channelInfo = await getChannelInfo(channelId);
    if (channelInfo) {
      context.viewing_channel_name = channelInfo.name;
      if (channelInfo.purpose?.value) {
        context.viewing_channel_description = channelInfo.purpose.value;
      }
      if (channelInfo.topic?.value) {
        context.viewing_channel_topic = channelInfo.topic.value;
      }
    }
  } catch (error) {
    logger.debug({ error, channelId }, 'Could not fetch channel info');
  }

  return context;
}

let addieDb: AddieDatabase | null = null;
let addieRouter: AddieRouter | null = null;
let threadContextStore: DatabaseThreadContextStore | null = null;
let initialized = false;

/**
 * Initialize the Bolt app for Addie
 * Returns both the App and the Express router to mount
 */
export async function initializeAddieBolt(): Promise<{ app: InstanceType<typeof App>; router: Router } | null> {
  const botToken = process.env.ADDIE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.ADDIE_SIGNING_SECRET || process.env.SLACK_SIGNING_SECRET;
  const anthropicKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!botToken || !signingSecret) {
    logger.warn('Addie Bolt: Missing ADDIE_BOT_TOKEN or ADDIE_SIGNING_SECRET, Addie will be disabled');
    return null;
  }

  if (!anthropicKey) {
    logger.warn('Addie Bolt: Missing ANTHROPIC_API_KEY, Addie will be disabled');
    return null;
  }

  logger.info('Addie Bolt: Initializing...');

  // Initialize Claude client
  claudeClient = new AddieClaudeClient(anthropicKey, AddieModelConfig.chat);

  // Initialize router (uses Haiku for fast classification)
  addieRouter = new AddieRouter(anthropicKey);

  // Initialize database access
  addieDb = new AddieDatabase();

  // Initialize thread context store
  threadContextStore = new DatabaseThreadContextStore(addieDb);

  // Initialize knowledge search
  await initializeKnowledgeSearch();

  // Register knowledge tools
  const knowledgeHandlers = createKnowledgeToolHandlers();
  for (const tool of KNOWLEDGE_TOOLS) {
    const handler = knowledgeHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register URL fetching tools (for reading links and files shared in Slack)
  const urlHandlers = createUrlToolHandlers(botToken);
  for (const tool of URL_TOOLS) {
    const handler = urlHandlers[tool.name];
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Create the Assistant
  const assistant = new Assistant({
    threadContextStore,
    threadStarted: handleThreadStarted,
    threadContextChanged: handleThreadContextChanged,
    userMessage: handleUserMessage,
  });

  // Create ExpressReceiver - we'll mount its router on our Express app
  // Our wrapper router handles URL verification at /events before passing to Bolt
  expressReceiver = new ExpressReceiver({
    signingSecret,
    endpoints: '/events',
    // Don't start the built-in HTTP server (installerOptions.port=false is undocumented but works)
    installerOptions: { port: false },
    logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.DEBUG,
  });

  // Create the Bolt app with ExpressReceiver
  boltApp = new App({
    token: botToken,
    receiver: expressReceiver,
    logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.DEBUG,
  });

  // Global error handler for Bolt
  boltApp.error(async (error) => {
    logger.error({
      error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Addie Bolt: Unhandled error');
  });

  // Register the assistant
  boltApp.assistant(assistant);

  // Register app_mention handler
  boltApp.event('app_mention', handleAppMention);

  // Register channel message handler (for HITL proposed responses)
  boltApp.event('message', handleChannelMessage);

  // Register feedback button handler
  boltApp.action('addie_feedback', handleFeedbackAction);

  // Register App Home handlers
  boltApp.event('app_home_opened', handleAppHomeOpened);
  boltApp.action('addie_home_refresh', handleHomeRefresh);
  boltApp.action('addie_home_ask_addie', handleAskAddie);
  boltApp.action('addie_home_update_profile', handleUpdateProfile);
  boltApp.action('addie_home_browse_groups', handleBrowseGroups);
  boltApp.action('addie_home_view_flagged', handleViewFlagged);

  // Register reaction handler for thumbs up/down confirmations
  boltApp.event('reaction_added', handleReactionAdded);

  // Initialize email handler (for responding to emails)
  initializeEmailHandler();

  initialized = true;
  logger.info({ tools: claudeClient.getRegisteredTools() }, 'Addie Bolt: Ready');

  return { app: boltApp, router: expressReceiver.router };
}

/**
 * Get the Bolt app instance
 */
export function getAddieBoltApp(): InstanceType<typeof App> | null {
  return boltApp;
}

/**
 * Get the Bolt Express router for mounting in an existing Express app
 */
export function getAddieBoltRouter(): Router | null {
  return expressReceiver?.router ?? null;
}

/**
 * Check if Addie Bolt is ready
 */
export function isAddieBoltReady(): boolean {
  return initialized && boltApp !== null && claudeClient !== null && isKnowledgeReady();
}

/**
 * Invalidate the cached system prompt (call after rule changes)
 */
export function invalidateAddieRulesCache(): void {
  if (claudeClient) {
    claudeClient.invalidateCache();
    logger.info('Addie Bolt: Rules cache invalidated');
  }
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
    logger.warn({ error, userId }, 'Addie Bolt: Failed to build dynamic prompts, using defaults');
    return SUGGESTED_PROMPTS;
  }
}

/**
 * Build message with member context prepended
 */
async function buildMessageWithMemberContext(
  userId: string,
  sanitizedMessage: string,
  threadContext?: ThreadContext
): Promise<{ message: string; memberContext: MemberContext | null }> {
  try {
    const memberContext = await getMemberContext(userId);
    const memberContextText = formatMemberContextForPrompt(memberContext);

    // Build channel context if available
    let channelContextText = '';
    if (threadContext?.viewing_channel_name) {
      const channelLines: string[] = [];
      channelLines.push('## Channel Context');
      channelLines.push(`User is viewing **#${threadContext.viewing_channel_name}**`);
      if (threadContext.viewing_channel_description) {
        channelLines.push(`Channel description: ${threadContext.viewing_channel_description}`);
      }
      if (threadContext.viewing_channel_topic) {
        channelLines.push(`Channel topic: ${threadContext.viewing_channel_topic}`);
      }
      channelContextText = channelLines.join('\n');
    }

    if (memberContextText || channelContextText) {
      // Use double newline between sections for proper markdown spacing
      const sections = [memberContextText, channelContextText].filter(Boolean);
      return {
        message: `${sections.join('\n\n')}\n\n---\n\n${sanitizedMessage}`,
        memberContext,
      };
    }
    return { message: sanitizedMessage, memberContext };
  } catch (error) {
    logger.warn({ error, userId }, 'Addie Bolt: Failed to get member context, continuing without it');
    return { message: sanitizedMessage, memberContext: null };
  }
}

/**
 * Create user-scoped tools based on member context and permissions
 * Admin users also get access to admin tools
 * Event creators (admin or committee leads) get access to event tools
 */
async function createUserScopedTools(
  memberContext: MemberContext | null,
  slackUserId?: string
): Promise<UserScopedToolsResult> {
  const memberHandlers = createMemberToolHandlers(memberContext);
  const allTools = [...MEMBER_TOOLS];
  const allHandlers = new Map(memberHandlers);

  // Add billing tools for all users (membership signup assistance)
  const billingHandlers = createBillingToolHandlers();
  allTools.push(...BILLING_TOOLS);
  for (const [name, handler] of billingHandlers) {
    allHandlers.set(name, handler);
  }
  logger.debug('Addie Bolt: Billing tools enabled');

  // Check if user is AAO admin (based on aao-admin working group membership)
  const userIsAdmin = slackUserId ? await isSlackUserAdmin(slackUserId) : false;

  // Add admin tools if user is admin
  if (userIsAdmin) {
    const adminHandlers = createAdminToolHandlers(memberContext);
    allTools.push(...ADMIN_TOOLS);
    for (const [name, handler] of adminHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie Bolt: Admin tools enabled for this user');
  }

  // Add event tools if user can create events (admin or committee lead)
  const canCreate = slackUserId ? await canCreateEvents(slackUserId) : userIsAdmin;
  if (canCreate) {
    const eventHandlers = createEventToolHandlers(memberContext, slackUserId);
    allTools.push(...EVENT_TOOLS);
    for (const [name, handler] of eventHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie Bolt: Event tools enabled for this user');
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
 * Handle assistant_thread_started event
 * User opened Addie - show suggested prompts
 */
async function handleThreadStarted({
  event,
  setSuggestedPrompts,
  saveThreadContext,
}: AssistantThreadStartedMiddlewareArgs): Promise<void> {
  const userId = event.assistant_thread.user_id;
  const context = event.assistant_thread.context;

  logger.debug(
    { userId, channelId: context.channel_id },
    'Addie Bolt: Thread started'
  );

  // Prefetch member insights in background (warms cache before first message)
  prefetchInsights(userId);

  // Save the initial context
  try {
    await saveThreadContext();
  } catch (error) {
    logger.warn({ error }, 'Addie Bolt: Failed to save initial thread context');
  }

  // Set dynamic suggested prompts
  try {
    const prompts = await getDynamicSuggestedPrompts(userId);
    await setSuggestedPrompts({
      prompts: prompts.map(p => ({ title: p.title, message: p.message })),
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to set suggested prompts');
  }
}

/**
 * Handle assistant_thread_context_changed event
 * User switched channels while Addie is open
 */
async function handleThreadContextChanged({
  event,
  saveThreadContext,
}: AssistantThreadContextChangedMiddlewareArgs): Promise<void> {
  const context = event.assistant_thread.context;

  logger.debug(
    { channelId: context.channel_id },
    'Addie Bolt: Thread context changed'
  );

  // Save the updated context
  try {
    await saveThreadContext();
  } catch (error) {
    logger.warn({ error }, 'Addie Bolt: Failed to save updated thread context');
  }
}

/**
 * Handle user message in assistant thread
 * Uses streaming to show response as it's generated
 */
async function handleUserMessage({
  event,
  client,
  context,
  say,
  setStatus,
  setTitle,
  getThreadContext,
}: AllAssistantMiddlewareArgs<AssistantUserMessageMiddlewareArgs>): Promise<void> {
  if (!claudeClient) {
    logger.warn('Addie Bolt: Claude client not initialized');
    return;
  }

  // Skip bot messages to prevent loops (Addie talking to herself)
  if ('bot_id' in event && event.bot_id) {
    logger.debug({ botId: event.bot_id }, 'Addie Bolt: Ignoring assistant message from bot');
    return;
  }

  // Extract fields safely - not all message events have these fields
  const userId = 'user' in event ? event.user : undefined;
  const messageText = 'text' in event ? event.text : undefined;
  const threadTs = 'thread_ts' in event ? event.thread_ts : ('ts' in event ? event.ts : undefined);

  // Skip if not a user message
  if (!userId || !messageText) {
    logger.debug('Addie Bolt: Ignoring message event without user or text');
    return;
  }

  // Skip Slackbot system messages (e.g., "added you to #channel")
  if (userId === SLACKBOT_USER_ID) {
    logger.debug({ messageText: messageText?.substring(0, 50) }, 'Addie Bolt: Ignoring Slackbot system message');
    return;
  }

  const startTime = Date.now();
  const channelId = event.channel;
  const threadService = getThreadService();

  // Build external ID for Slack: channel_id:thread_ts
  const externalId = `${channelId}:${threadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(messageText || '');

  // Set status with rotating loading messages
  try {
    await setStatus({
      status: 'Thinking...',
      loading_messages: [
        'Consulting the ad tech archives...',
        'Parsing the protocol specs...',
        'Asking the agentic advertising experts...',
        'Crunching the contextual data...',
        'Decoding the RTB mysteries...',
        "Waiting for Ari's next book...",
        'Doom-scrolling adtech twitter...',
        'Thinking up new TLAs...',
        'Calculating carbon footprint savings...',
        'Debating MCP vs A2A...',
      ],
    });
  } catch {
    // Status update failed, continue anyway
  }

  // Get thread context (what channel user is viewing)
  let slackThreadContext: ThreadContext = {};
  try {
    const boltContext = await getThreadContext();
    if (boltContext?.channel_id) {
      const channelContext = await buildChannelContext(boltContext.channel_id);
      slackThreadContext = {
        ...channelContext,
        team_id: boltContext.team_id,
        enterprise_id: boltContext.enterprise_id || undefined,
      };
      logger.debug({ viewingChannel: boltContext.channel_id, channelName: channelContext.viewing_channel_name }, 'Addie Bolt: User is viewing channel');
    }
  } catch (error) {
    logger.debug({ error }, 'Addie Bolt: Could not get thread context');
  }

  // Get member context early so we can include display name in thread creation
  let memberContext: MemberContext | null = null;
  try {
    memberContext = await getMemberContext(userId);
  } catch (error) {
    logger.debug({ error, userId }, 'Addie Bolt: Could not get member context for thread creation');
  }

  // Get or create unified thread (including user_display_name for admin UI)
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    user_display_name: memberContext?.slack_user?.display_name || undefined,
    context: slackThreadContext,
  });

  // Fetch conversation history from database for context
  // This ensures Claude has context from previous turns in the DM thread
  const MAX_HISTORY_MESSAGES = 10;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      // Format previous messages for Claude context
      // Only include user and assistant messages (skip system/tool)
      // Exclude the current message (we just logged it below, but it's not there yet)
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
        }));

      if (conversationHistory.length > 0) {
        logger.debug(
          { threadId: thread.thread_id, messageCount: conversationHistory.length },
          'Addie Bolt: Loaded conversation history for DM thread'
        );
      }
    }
  } catch (error) {
    logger.warn({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to fetch conversation history');
  }

  // Build message with member context (memberContext is fetched again but cached)
  const { message: messageWithContext, memberContext: updatedMemberContext } = await buildMessageWithMemberContext(
    userId,
    inputValidation.sanitized,
    slackThreadContext
  );
  // Use the updated memberContext if we didn't have one before
  if (!memberContext && updatedMemberContext) {
    memberContext = updatedMemberContext;
  }

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'user',
    content: messageText || '',
    content_sanitized: inputValidation.sanitized,
    flagged: userMessageFlagged,
    flag_reason: inputValidation.reason || undefined,
  });

  // Create user-scoped tools (includes admin tools if user is admin)
  const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, userId);

  // Admin users get higher iteration limit for bulk operations
  const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

  // Process with Claude using streaming
  let response;
  let fullText = '';
  const toolsUsed: string[] = [];
  const toolExecutions: { tool_name: string; parameters: Record<string, unknown>; result: string }[] = [];

  try {
    // Get team ID from context for streaming
    const teamId = context.teamId || slackThreadContext.team_id;

    // Check if streaming is available (requires teamId and userId)
    const canStream = teamId && userId && threadTs && 'chatStream' in client;

    if (canStream) {
      // Use streaming for real-time response
      logger.debug('Addie Bolt: Using streaming response');

      // Initialize the stream
      // Note: threadTs (line 416) falls back to event.ts for external ID tracking,
      // but for the API call we only pass thread_ts when continuing an existing thread.
      // This prevents creating unwanted sub-threads on new DM conversations.
      const existingThreadTs = 'thread_ts' in event && event.thread_ts ? event.thread_ts : undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamer = (client as any).chatStream({
        channel: channelId,
        recipient_team_id: teamId,
        recipient_user_id: userId,
        ...(existingThreadTs && { thread_ts: existingThreadTs }),
      });

      // Process Claude response stream (pass conversation history for context)
      for await (const event of claudeClient.processMessageStream(messageWithContext, conversationHistory, userTools, processOptions)) {
        if (event.type === 'text') {
          fullText += event.text;
          // Append text chunk to Slack stream
          try {
            await streamer.append({ markdown_text: event.text });
          } catch (streamError) {
            logger.warn({ streamError }, 'Addie Bolt: Stream append failed, falling back to full response');
          }
        } else if (event.type === 'tool_start') {
          toolsUsed.push(event.tool_name);
          // Optionally update status during tool execution
          try {
            await setStatus(`Using ${event.tool_name}...`);
          } catch {
            // Ignore status update errors
          }
        } else if (event.type === 'tool_end') {
          toolExecutions.push({
            tool_name: event.tool_name,
            parameters: {},
            result: event.result,
          });
        } else if (event.type === 'done') {
          response = event.response;
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }

      // Stop the stream with feedback buttons attached
      try {
        await streamer.stop({
          blocks: [buildFeedbackBlock()],
        });
      } catch (stopError) {
        logger.warn({ stopError }, 'Addie Bolt: Stream stop failed');
      }
    } else {
      // Fall back to non-streaming for compatibility
      logger.debug('Addie Bolt: Using non-streaming response (streaming not available)');
      response = await claudeClient.processMessage(messageWithContext, conversationHistory, userTools, undefined, processOptions);
      fullText = response.text;

      // Send response via say() with feedback buttons
      const outputValidation = validateOutput(response.text);
      try {
        await say({
          text: outputValidation.sanitized,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: outputValidation.sanitized,
              },
            },
            buildFeedbackBlock(),
          ],
        });
      } catch (error) {
        logger.error({ error }, 'Addie Bolt: Failed to send response');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Error processing message');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
    fullText = response.text;

    // Send error response
    try {
      await say(response.text);
    } catch (sayError) {
      logger.error({ sayError }, 'Addie Bolt: Failed to send error response');
    }
  }

  // Build final response object if we used streaming
  if (!response) {
    response = {
      text: fullText,
      tools_used: toolsUsed,
      tool_executions: toolExecutions.map((t, i) => ({
        ...t,
        is_error: false,
        duration_ms: 0,
        sequence: i + 1,
      })),
      flagged: false,
    };
  }

  // Validate output
  const outputValidation = validateOutput(response.text);

  // Update title based on first message (optional - helps organize threads)
  const titleText = inputValidation.sanitized.split(' ').slice(0, 5).join(' ');
  if (titleText.length > 0) {
    const title = titleText + (inputValidation.sanitized.length > titleText.length ? '...' : '');
    try {
      await setTitle(title);
    } catch {
      // Title update is optional, ignore errors
    }
    // Also update unified thread title
    await threadService.updateThreadTitle(thread.thread_id, title);
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');

  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'assistant',
    content: outputValidation.sanitized,
    tools_used: response.tools_used,
    tool_calls: response.tool_executions?.map(exec => ({
      name: exec.tool_name,
      input: exec.parameters,
      result: exec.result,
      duration_ms: exec.duration_ms,
      is_error: exec.is_error,
    })),
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    tokens_input: response.usage?.input_tokens,
    tokens_output: response.usage?.output_tokens,
    flagged: assistantFlagged,
    flag_reason: flagReason || undefined,
    // Enhanced execution metadata
    timing: response.timing ? {
      system_prompt_ms: response.timing.system_prompt_ms,
      total_llm_ms: response.timing.total_llm_ms,
      total_tool_ms: response.timing.total_tool_execution_ms,
      iterations: response.timing.iterations,
    } : undefined,
    tokens_cache_creation: response.usage?.cache_creation_input_tokens,
    tokens_cache_read: response.usage?.cache_read_input_tokens,
    active_rule_ids: response.active_rule_ids,
  });

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    await threadService.flagThread(
      thread.thread_id,
      [inputValidation.reason, flagReason].filter(Boolean).join('; ')
    );
  }

  // Also log to security audit (keeps existing behavior)
  logInteraction({
    id: thread.thread_id,
    timestamp: new Date(),
    event_type: 'assistant_thread',
    channel_id: channelId,
    thread_ts: threadTs,
    user_id: userId,
    input_text: messageText || '',
    input_sanitized: inputValidation.sanitized,
    output_text: outputValidation.sanitized,
    tools_used: response.tools_used,
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged: userMessageFlagged || assistantFlagged,
    flag_reason: [inputValidation.reason, flagReason].filter(Boolean).join('; ') || undefined,
  });
}

/**
 * Handle @mention in a channel
 */
async function handleAppMention({
  event,
  say,
  context,
}: SlackEventMiddlewareArgs<'app_mention'> & { context: { botUserId?: string } }): Promise<void> {
  if (!claudeClient) {
    logger.warn('Addie Bolt: Claude client not initialized');
    return;
  }

  // Skip bot messages to prevent loops (Addie talking to herself)
  if ('bot_id' in event && event.bot_id) {
    logger.debug({ botId: event.bot_id }, 'Addie Bolt: Ignoring mention from bot');
    return;
  }

  const startTime = Date.now();
  const threadService = getThreadService();

  // Strip bot mention
  let rawText = event.text || '';
  if (context.botUserId) {
    rawText = rawText.replace(new RegExp(`<@${context.botUserId}>\\s*`, 'gi'), '').trim();
  }

  // Extract forwarded message content from attachments
  const attachments = 'attachments' in event ? (event.attachments as SlackAttachment[]) : undefined;
  const forwardedContent = extractForwardedContent(attachments);

  // Extract file information from file shares
  const files = 'files' in event ? (event.files as SlackFile[]) : undefined;
  const fileInfo = extractFileInfo(files);

  // Handle empty mentions (just @Addie with no message)
  // This commonly happens when Addie is added to a channel - provide clear context to Claude
  const isEmptyMention = rawText.length === 0 && forwardedContent.length === 0 && fileInfo.length === 0;
  const originalUserInput = rawText + forwardedContent + fileInfo; // Preserve for audit logging
  if (isEmptyMention) {
    rawText = '[Empty mention - user tagged me without a question. Briefly introduce myself and offer help. Do not assume they are new to the channel.]';
  } else {
    // Append forwarded content and file info to the user's message
    rawText = rawText + forwardedContent + fileInfo;
  }

  const userId = event.user;
  if (!userId) {
    logger.warn('Addie Bolt: app_mention event missing user');
    return;
  }

  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const isInThread = Boolean(event.thread_ts);

  // Build external ID for Slack mentions: channel_id:thread_ts (or ts if no thread)
  const externalId = `${channelId}:${threadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(rawText);

  // Fetch channel info for context
  const mentionChannelContext = await buildChannelContext(channelId) as ThreadContext;

  // Fetch thread context if this mention is in a thread
  const MAX_THREAD_CONTEXT_MESSAGES = 25;
  let threadContext = '';
  if (isInThread && event.thread_ts) {
    try {
      const threadMessages = await getThreadReplies(channelId, event.thread_ts);
      if (threadMessages.length > 0) {
        // Filter out Addie's own messages and format the thread history
        const filteredMessages = threadMessages
          .filter(msg => msg.user !== context.botUserId) // Exclude Addie's own messages
          .filter(msg => msg.ts !== event.ts) // Exclude the current mention message
          .filter(msg => (msg.text || '').trim().length > 0) // Filter out empty messages
          .slice(-MAX_THREAD_CONTEXT_MESSAGES);

        // Collect all unique user IDs mentioned in the thread
        const mentionedUserIds = new Set<string>();
        for (const msg of filteredMessages) {
          const mentions = (msg.text || '').matchAll(/<@(U[A-Z0-9]+)>/gi);
          for (const match of mentions) {
            if (match[1] !== context.botUserId) {
              mentionedUserIds.add(match[1]);
            }
          }
        }

        // Look up display names for mentioned users (in parallel)
        const userNameMap = new Map<string, string>();
        if (mentionedUserIds.size > 0) {
          const lookups = await Promise.all(
            Array.from(mentionedUserIds).map(async (uid) => {
              const user = await getSlackUser(uid);
              return { uid, name: user?.profile?.display_name || user?.real_name || user?.name || null };
            })
          );
          for (const { uid, name } of lookups) {
            if (name) {
              userNameMap.set(uid, name);
            }
          }
        }

        // Format messages, replacing user IDs with display names
        const contextMessages = filteredMessages.map(msg => {
          let text = msg.text || '';
          // Strip Addie's mentions entirely (they're noise)
          if (context.botUserId) {
            text = text.replace(new RegExp(`<@${context.botUserId}>\\s*`, 'gi'), '').trim();
          }
          // Replace user mentions with display names or fallback to [someone]
          text = text.replace(/<@(U[A-Z0-9]+)>/gi, (match, uid) => {
            const name = userNameMap.get(uid);
            return name ? `@${name}` : '[someone]';
          });
          return `- ${text}`;
        });

        if (contextMessages.length > 0) {
          threadContext = `\n\n## Thread Context\nThe user is replying in a Slack thread. Here are the previous messages in this thread for context:\n${contextMessages.join('\n')}\n\n---\n`;
          logger.debug({ messageCount: contextMessages.length, resolvedUsers: userNameMap.size }, 'Addie Bolt: Fetched thread context for mention');
        }
      }
    } catch (error) {
      logger.warn({ error, channelId, threadTs: event.thread_ts }, 'Addie Bolt: Failed to fetch thread context');
    }
  }

  // Get or create unified thread for this mention
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    context: {
      mention_channel_id: channelId,
      mention_type: 'app_mention',
    },
  });

  // Build message with member context and channel context
  const { message: messageWithMemberContext, memberContext } = await buildMessageWithMemberContext(
    userId,
    inputValidation.sanitized,
    mentionChannelContext
  );

  // Prepend thread context if available (member context already includes the user's message)
  const messageWithContext = threadContext
    ? `${threadContext}${messageWithMemberContext}`
    : messageWithMemberContext;

  // Log user message to unified thread (use original input, not synthetic instruction)
  const userMessageFlagged = inputValidation.flagged;
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'user',
    content: originalUserInput,
    content_sanitized: isEmptyMention ? '' : inputValidation.sanitized,
    flagged: userMessageFlagged,
    flag_reason: inputValidation.reason || undefined,
  });

  // Create user-scoped tools (includes admin tools if user is admin)
  const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, userId);

  // Admin users get higher iteration limit for bulk operations
  const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, undefined, userTools, undefined, processOptions);
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Error processing mention');
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

  // Send response in thread (must explicitly pass thread_ts for app_mention events)
  try {
    await say({
      text: outputValidation.sanitized,
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send mention response');
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');

  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'assistant',
    content: outputValidation.sanitized,
    tools_used: response.tools_used,
    tool_calls: response.tool_executions?.map(exec => ({
      name: exec.tool_name,
      input: exec.parameters,
      result: exec.result,
      duration_ms: exec.duration_ms,
      is_error: exec.is_error,
    })),
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    tokens_input: response.usage?.input_tokens,
    tokens_output: response.usage?.output_tokens,
    flagged: assistantFlagged,
    flag_reason: flagReason || undefined,
    // Enhanced execution metadata
    timing: response.timing ? {
      system_prompt_ms: response.timing.system_prompt_ms,
      total_llm_ms: response.timing.total_llm_ms,
      total_tool_ms: response.timing.total_tool_execution_ms,
      iterations: response.timing.iterations,
    } : undefined,
    tokens_cache_creation: response.usage?.cache_creation_input_tokens,
    tokens_cache_read: response.usage?.cache_read_input_tokens,
    active_rule_ids: response.active_rule_ids,
  });

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    await threadService.flagThread(
      thread.thread_id,
      [inputValidation.reason, flagReason].filter(Boolean).join('; ')
    );
  }

  // Also log to security audit (keeps existing behavior)
  logInteraction({
    id: thread.thread_id,
    timestamp: new Date(),
    event_type: 'mention',
    channel_id: channelId,
    thread_ts: threadTs,
    user_id: userId,
    input_text: rawText,
    input_sanitized: inputValidation.sanitized,
    output_text: outputValidation.sanitized,
    tools_used: response.tools_used,
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged: userMessageFlagged || assistantFlagged,
    flag_reason: [inputValidation.reason, flagReason].filter(Boolean).join('; ') || undefined,
  });
}

/**
 * Handle feedback button clicks
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFeedbackAction({ ack, body, client }: any): Promise<void> {
  await ack();

  const feedbackValue = body.actions?.[0]?.value;
  const isPositive = feedbackValue === 'positive';
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  const threadTs = body.message?.thread_ts;

  if (!channelId || !messageTs) {
    logger.warn('Addie Bolt: Feedback action missing channel or message');
    return;
  }

  const threadService = getThreadService();

  // Find the thread and message to update
  const externalId = `${channelId}:${threadTs || messageTs}`;
  const thread = await threadService.getThreadByExternalId('slack', externalId);

  if (thread) {
    // Find the most recent assistant message in this thread
    const messages = await threadService.getThreadMessages(thread.thread_id);
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const latestAssistant = assistantMessages[assistantMessages.length - 1];

    if (latestAssistant) {
      // Update the message with feedback
      // Use numeric rating: 5 for positive, 1 for negative
      await threadService.addMessageFeedback(latestAssistant.message_id, {
        rating: isPositive ? 5 : 1,
        rating_category: isPositive ? 'helpful' : 'not_helpful',
        rated_by: userId,
        rating_source: 'user',
      });

      logger.info({
        threadId: thread.thread_id,
        messageId: latestAssistant.message_id,
        feedback: isPositive ? 'positive' : 'negative',
        ratingSource: 'user',
        userId,
      }, 'Addie Bolt: Feedback recorded');
    } else {
      logger.warn({ threadId: thread.thread_id, externalId }, 'Addie Bolt: No assistant messages found for feedback');
    }
  } else {
    logger.warn({ externalId, channelId, messageTs, threadTs }, 'Addie Bolt: Thread not found for feedback');
  }

  // Send ephemeral confirmation
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: isPositive
        ? "Thanks for the positive feedback! I'm glad I could help. 😊"
        : "Thanks for letting me know. I'll work on doing better! Your feedback helps me improve.",
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.warn({ error }, 'Addie Bolt: Failed to send feedback confirmation');
  }
}

/**
 * Build feedback buttons block for assistant responses
 */
function buildFeedbackBlock(): {
  type: 'context_actions';
  elements: Array<{
    type: 'feedback_buttons';
    action_id: string;
    positive_button: {
      text: { type: 'plain_text'; text: string };
      value: string;
      accessibility_label: string;
    };
    negative_button: {
      text: { type: 'plain_text'; text: string };
      value: string;
      accessibility_label: string;
    };
  }>;
} {
  return {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: 'addie_feedback',
        positive_button: {
          text: { type: 'plain_text', text: 'Helpful' },
          value: 'positive',
          accessibility_label: 'Mark this response as helpful',
        },
        negative_button: {
          text: { type: 'plain_text', text: 'Not helpful' },
          value: 'negative',
          accessibility_label: 'Mark this response as not helpful',
        },
      },
    ],
  };
}

/**
 * Build router_decision metadata from an ExecutionPlan
 */
function buildRouterDecision(plan: ExecutionPlan): {
  action: string;
  reason: string;
  decision_method: 'quick_match' | 'llm';
  tools?: string[];
  latency_ms?: number;
  tokens_input?: number;
  tokens_output?: number;
  model?: string;
} {
  const base = {
    action: plan.action,
    reason: plan.reason,
    decision_method: plan.decision_method,
    latency_ms: plan.latency_ms,
    tokens_input: plan.tokens_input,
    tokens_output: plan.tokens_output,
    model: plan.model,
  };

  if (plan.action === 'respond') {
    return { ...base, tools: plan.tools };
  }

  return base;
}

/**
 * Index a channel message for local full-text search
 * Stores in addie_knowledge for the search_slack tool
 */
async function indexChannelMessage(
  channelId: string,
  userId: string,
  messageText: string,
  ts: string
): Promise<void> {
  // Only index messages with substantial content
  if (messageText.length < 20) {
    return;
  }

  try {
    // Fetch user and channel info
    const [user, channel] = await Promise.all([
      getSlackUser(userId),
      getChannelInfo(channelId),
    ]);

    if (!user || !channel) {
      logger.debug(
        { userId, channelId },
        'Addie Bolt: Skipping message index - could not fetch user or channel info'
      );
      return;
    }

    // Construct permalink
    const tsForLink = ts.replace('.', '');
    const permalink = `https://agenticads.slack.com/archives/${channelId}/p${tsForLink}`;

    await addieDb?.indexSlackMessage({
      channel_id: channelId,
      channel_name: channel.name || 'unknown',
      user_id: userId,
      username: user.profile?.display_name || user.profile?.real_name || user.name || 'unknown',
      ts,
      text: messageText,
      permalink,
    });

    logger.debug(
      { channelName: channel.name, username: user.name },
      'Addie Bolt: Indexed channel message for search'
    );
  } catch (error) {
    // Don't fail the main handler if indexing fails
    logger.warn({ error, channelId }, 'Addie Bolt: Failed to index message for search');
  }
}

/**
 * Handle direct messages (DMs) to Addie
 *
 * When a user DMs Addie directly (not through the Assistant flow), this handler
 * processes the message and responds. This provides a simpler DM experience
 * similar to chatting with a human user.
 */
async function handleDirectMessage(
  event: { channel: string; user?: string; text?: string; ts: string; thread_ts?: string; bot_id?: string; attachments?: SlackAttachment[]; files?: SlackFile[] },
  _context: { botUserId?: string }
): Promise<void> {
  if (!claudeClient || !boltApp) {
    logger.warn('Addie Bolt: Not initialized for DM handling');
    return;
  }

  // Skip bot messages to prevent loops (Addie talking to herself)
  if (event.bot_id) {
    logger.debug({ botId: event.bot_id }, 'Addie Bolt: Ignoring DM from bot');
    return;
  }

  const userId = event.user;

  // Skip Slackbot system messages (e.g., "added you to #channel")
  if (userId === SLACKBOT_USER_ID) {
    logger.debug({ messageText: event.text?.substring(0, 50) }, 'Addie Bolt: Ignoring Slackbot system message in DM');
    return;
  }

  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;

  // Extract forwarded message content from attachments
  const forwardedContent = extractForwardedContent(event.attachments);

  // Extract file information from file shares
  const fileInfo = extractFileInfo(event.files);

  // Combine message text with any forwarded content and file info
  const messageText = (event.text || '') + forwardedContent + fileInfo;

  if (!userId || !messageText.trim()) {
    logger.debug('Addie Bolt: Ignoring DM without user or text');
    return;
  }

  const startTime = Date.now();
  const threadService = getThreadService();

  // Build external ID for Slack DMs: channel_id:thread_ts
  const externalId = `${channelId}:${threadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(messageText);

  logger.info({ userId, channelId }, 'Addie Bolt: Processing direct message');

  // Get member context
  let memberContext: MemberContext | null = null;
  try {
    memberContext = await getMemberContext(userId);
  } catch (error) {
    logger.debug({ error, userId }, 'Addie Bolt: Could not get member context for DM');
  }

  // Get or create unified thread
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    user_display_name: memberContext?.slack_user?.display_name || undefined,
    context: {
      channel_type: 'im',
    },
  });

  // Fetch conversation history from database for context
  const MAX_HISTORY_MESSAGES = 10;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
        }));

      if (conversationHistory.length > 0) {
        logger.debug(
          { threadId: thread.thread_id, messageCount: conversationHistory.length },
          'Addie Bolt: Loaded conversation history for DM'
        );
      }
    }
  } catch (error) {
    logger.warn({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to fetch DM conversation history');
  }

  // Build message with member context
  // Note: No thread context is passed for DMs since there's no "viewing channel" context
  // like in the Assistant flow. DMs are direct conversations without channel context.
  const { message: messageWithContext, memberContext: updatedMemberContext } = await buildMessageWithMemberContext(
    userId,
    inputValidation.sanitized
  );
  if (!memberContext && updatedMemberContext) {
    memberContext = updatedMemberContext;
  }

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'user',
    content: messageText,
    content_sanitized: inputValidation.sanitized,
    flagged: userMessageFlagged,
    flag_reason: inputValidation.reason || undefined,
  });

  // Create user-scoped tools
  const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, userId);

  // Admin users get higher iteration limit for bulk operations
  const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, conversationHistory, userTools, undefined, processOptions);
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Error processing DM');
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

  // Send response in the DM thread
  try {
    await boltApp.client.chat.postMessage({
      channel: channelId,
      text: outputValidation.sanitized,
      thread_ts: threadTs !== event.ts ? threadTs : undefined, // Only thread if already in a thread
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send DM response');
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');

  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'assistant',
    content: outputValidation.sanitized,
    tools_used: response.tools_used,
    tool_calls: response.tool_executions?.map(exec => ({
      name: exec.tool_name,
      input: exec.parameters,
      result: exec.result,
      duration_ms: exec.duration_ms,
      is_error: exec.is_error,
    })),
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    tokens_input: response.usage?.input_tokens,
    tokens_output: response.usage?.output_tokens,
    flagged: assistantFlagged,
    flag_reason: flagReason || undefined,
    timing: response.timing ? {
      system_prompt_ms: response.timing.system_prompt_ms,
      total_llm_ms: response.timing.total_llm_ms,
      total_tool_ms: response.timing.total_tool_execution_ms,
      iterations: response.timing.iterations,
    } : undefined,
    tokens_cache_creation: response.usage?.cache_creation_input_tokens,
    tokens_cache_read: response.usage?.cache_read_input_tokens,
    active_rule_ids: response.active_rule_ids,
  });

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    await threadService.flagThread(
      thread.thread_id,
      [inputValidation.reason, flagReason].filter(Boolean).join('; ')
    );
  }

  // Log to security audit
  logInteraction({
    id: thread.thread_id,
    timestamp: new Date(),
    event_type: 'dm',
    channel_id: channelId,
    thread_ts: threadTs,
    user_id: userId,
    input_text: messageText,
    input_sanitized: inputValidation.sanitized,
    output_text: outputValidation.sanitized,
    tools_used: response.tools_used,
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged: userMessageFlagged || assistantFlagged,
    flag_reason: [inputValidation.reason, flagReason].filter(Boolean).join('; ') || undefined,
  });

  logger.info(
    { userId, channelId, latencyMs: Date.now() - startTime },
    'Addie Bolt: DM response sent'
  );
}

/**
 * Handle channel messages (not mentions) for HITL proposed responses
 *
 * When Addie sees a message in a channel it's in, it uses the router to
 * determine if/how to respond. Responses are queued for admin approval.
 */
async function handleChannelMessage({
  event,
  context,
}: SlackEventMiddlewareArgs<'message'> & { context: { botUserId?: string } }): Promise<void> {
  // Skip if not initialized
  if (!claudeClient || !addieDb || !addieRouter) {
    return;
  }

  // Skip bot messages (including our own)
  if ('bot_id' in event && event.bot_id) {
    return;
  }

  // Skip subtypes (edits, deletes, etc.) - but only for non-DM messages
  // DMs can have forwarded messages where text is empty but attachments have content
  const hasText = 'text' in event && event.text;
  const hasAttachments = 'attachments' in event && Array.isArray(event.attachments) && event.attachments.length > 0;
  const hasFiles = 'files' in event && Array.isArray(event.files) && event.files.length > 0;
  const hasSubtype = 'subtype' in event && event.subtype;

  const userId = 'user' in event ? event.user : undefined;

  // Handle DMs differently - route to the user message handler
  // For DMs, allow messages with attachments or files even if text is empty
  if (event.channel_type === 'im') {
    if (!hasText && !hasAttachments && !hasFiles) {
      return;
    }
    if (hasSubtype) {
      return;
    }
    logger.debug({ channelId: event.channel, userId }, 'Addie Bolt: Routing DM to user message handler');
    await handleDirectMessage(event as typeof event & { attachments?: SlackAttachment[]; files?: SlackFile[] }, context);
    return;
  }

  // For channel messages, require text and skip subtypes
  if (!hasText || hasSubtype) {
    return;
  }

  // Skip if this is a mention (handled by handleAppMention)
  if (context.botUserId && event.text && event.text.includes(`<@${context.botUserId}>`)) {
    return;
  }
  if (!userId) {
    return;
  }

  const channelId = event.channel;
  // At this point we know hasText is true, so event.text exists
  const messageText = event.text!;
  const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) || event.ts;
  const isInThread = !!('thread_ts' in event && event.thread_ts);
  const startTime = Date.now();
  const threadService = getThreadService();

  // Index message for local search (async, don't await)
  indexChannelMessage(channelId, userId, messageText, event.ts).catch(() => {
    // Errors already logged in indexChannelMessage
  });

  // Check for community article shares in managed channels
  // This happens before routing so we can react quickly
  const articleUrls = extractArticleUrls(messageText);
  if (articleUrls.length > 0 && !isInThread) {
    // Only process articles in top-level messages (not thread replies)
    const isManaged = await isManagedChannel(channelId);
    if (isManaged) {
      // React with eyes to acknowledge we're looking at it
      try {
        await boltApp?.client.reactions.add({
          channel: channelId,
          timestamp: event.ts,
          name: 'eyes',
        });
      } catch (reactionError) {
        // Ignore - may already have reaction
      }

      // Get user display name for context
      let displayName: string | undefined;
      try {
        const slackUser = await getSlackUser(userId);
        displayName = slackUser?.profile?.display_name || slackUser?.profile?.real_name;
      } catch {
        // Ignore
      }

      // Queue each article URL for processing
      for (const url of articleUrls) {
        await queueCommunityArticle({
          url,
          sharedByUserId: userId,
          channelId,
          messageTs: event.ts,
          sharedByDisplayName: displayName,
        });
      }

      logger.info(
        { channelId, userId, articleCount: articleUrls.length },
        'Addie Bolt: Queued community articles for processing'
      );
    }
  }

  logger.debug({ channelId, userId, isInThread },
    'Addie Bolt: Evaluating channel message for potential response');

  try {
    // Fetch member context and insights in parallel (both are independent)
    // Insights use a cache with 5-minute TTL to reduce DB load
    const [memberContext, memberInsights] = await Promise.all([
      getMemberContext(userId),
      getCachedInsights(userId),
    ]);

    if (memberInsights && memberInsights.length > 0) {
      logger.debug(
        { userId, insightCount: memberInsights.length, types: memberInsights.map(i => i.insight_type_name) },
        'Addie Bolt: Found member insights for routing'
      );
    }

    // Build routing context
    const routingCtx: RoutingContext = {
      message: messageText,
      source: 'channel',
      memberContext,
      isThread: isInThread,
      memberInsights,
    };

    // Quick match first (no API call for obvious cases)
    let plan = addieRouter.quickMatch(routingCtx);

    // If no quick match, use the full router
    if (!plan) {
      plan = await addieRouter.route(routingCtx);
    }

    logger.debug({ channelId, action: plan.action, reason: plan.reason },
      'Addie Bolt: Router decision for channel message');

    // Build external ID for Slack channel messages: channel_id:thread_ts
    const externalId = `${channelId}:${threadTs}`;

    // Get or create unified thread for this channel message
    const thread = await threadService.getOrCreateThread({
      channel: 'slack',
      external_id: externalId,
      user_type: 'slack',
      user_id: userId,
      context: {
        channel_id: channelId,
        message_type: 'channel_message',
      },
    });

    // Sanitize input for logging
    const inputValidation = sanitizeInput(messageText);

    // Log user message to unified thread with router decision
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: messageText,
      content_sanitized: inputValidation.sanitized,
      flagged: inputValidation.flagged,
      flag_reason: inputValidation.reason || undefined,
      router_decision: buildRouterDecision(plan),
    });

    // Handle based on execution plan
    if (plan.action === 'ignore') {
      logger.debug({ channelId, userId, reason: plan.reason }, 'Addie Bolt: Ignoring channel message');
      return;
    }

    if (plan.action === 'react') {
      try {
        await boltApp?.client.reactions.add({
          channel: channelId,
          timestamp: event.ts,
          name: plan.emoji,
        });
        logger.info({ channelId, userId, emoji: plan.emoji }, 'Addie Bolt: Added reaction');
      } catch (reactionError) {
        logger.debug({ error: reactionError, channelId }, 'Addie Bolt: Could not add reaction (may already exist)');
      }
      return;
    }

    if (plan.action === 'clarify') {
      // Queue clarifying question for approval
      await addieDb.queueForApproval({
        action_type: 'reply',
        target_channel_id: channelId,
        target_thread_ts: threadTs,
        proposed_content: plan.question,
        trigger_type: 'channel_message',
        trigger_context: {
          original_message: messageText.substring(0, 1000),
          user_id: userId,
          user_display_name: memberContext?.slack_user?.display_name || undefined,
          is_clarifying_question: true,
          router_reason: plan.reason,
          router_decision_method: plan.decision_method,
          router_latency_ms: plan.latency_ms,
        },
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      logger.info({ channelId, userId }, 'Addie Bolt: Clarifying question queued for approval');
      return;
    }

    // action === 'respond'
    logger.info({ channelId, userId, tools: plan.tools },
      'Addie Bolt: Generating proposed response for channel message');

    // Build message with member context
    const { message: messageWithContext } = await buildMessageWithMemberContext(
      userId,
      messageText
    );

    // Generate a response with the specified tools (includes admin tools if user is admin)
    const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, userId);
    const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;
    const response = await claudeClient.processMessage(messageWithContext, undefined, userTools, undefined, processOptions);

    if (!response.text || response.text.trim().length === 0) {
      logger.debug({ channelId }, 'Addie Bolt: No response generated');
      return;
    }

    // Validate the output
    const outputValidation = validateOutput(response.text);
    if (outputValidation.flagged) {
      logger.warn({ channelId, reason: outputValidation.reason }, 'Addie Bolt: Proposed response flagged');
      return;
    }

    // Log assistant response to unified thread (even though it's pending approval)
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'assistant',
      content: outputValidation.sanitized,
      tools_used: response.tools_used,
      tool_calls: response.tool_executions?.map(exec => ({
        name: exec.tool_name,
        input: exec.parameters,
        result: exec.result,
        duration_ms: exec.duration_ms,
        is_error: exec.is_error,
      })),
      model: AddieModelConfig.chat,
      latency_ms: Date.now() - startTime,
      tokens_input: response.usage?.input_tokens,
      tokens_output: response.usage?.output_tokens,
      timing: response.timing ? {
        system_prompt_ms: response.timing.system_prompt_ms,
        total_llm_ms: response.timing.total_llm_ms,
        total_tool_ms: response.timing.total_tool_execution_ms,
        iterations: response.timing.iterations,
      } : undefined,
      tokens_cache_creation: response.usage?.cache_creation_input_tokens,
      tokens_cache_read: response.usage?.cache_read_input_tokens,
      active_rule_ids: response.active_rule_ids,
      config_version_id: response.config_version_id,
      router_decision: buildRouterDecision(plan),
    });

    // Queue the response for admin approval
    await addieDb.queueForApproval({
      action_type: 'reply',
      target_channel_id: channelId,
      target_thread_ts: threadTs,
      proposed_content: outputValidation.sanitized,
      trigger_type: 'channel_message',
      trigger_context: {
        original_message: messageText.substring(0, 1000),
        user_id: userId,
        user_display_name: memberContext?.slack_user?.display_name || undefined,
        tools_used: response.tools_used,
        router_tools: plan.tools,
        router_reason: plan.reason,
        router_decision_method: plan.decision_method,
        router_latency_ms: plan.latency_ms,
        router_tokens_input: plan.tokens_input,
        router_tokens_output: plan.tokens_output,
        router_model: plan.model,
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    logger.info({ channelId, userId }, 'Addie Bolt: Proposed response queued for approval');

  } catch (error) {
    logger.error({ error, channelId }, 'Addie Bolt: Error processing channel message');
  }
}

/**
 * Send a proactive message when a user links their account
 */
export async function sendAccountLinkedMessage(
  slackUserId: string,
  userName?: string
): Promise<boolean> {
  if (!initialized || !boltApp) {
    logger.warn('Addie Bolt: Not initialized, cannot send account linked message');
    return false;
  }

  const threadService = getThreadService();

  // Find the user's most recent Addie thread (within 30 minutes)
  const recentThread = await threadService.getUserRecentThread(slackUserId, 'slack', 30);
  if (!recentThread) {
    logger.debug({ slackUserId }, 'Addie Bolt: No recent thread found for account linked message');
    return false;
  }

  // Parse external_id back to channel_id:thread_ts
  const [channelId, threadTs] = recentThread.external_id.split(':');
  if (!channelId || !threadTs) {
    logger.warn({ slackUserId, externalId: recentThread.external_id }, 'Addie Bolt: Invalid external_id format');
    return false;
  }

  // Build a personalized message
  const greeting = userName ? `Thanks for linking your account, ${userName}!` : 'Thanks for linking your account!';
  const messageText = `${greeting} 🎉\n\nI can now see your profile and help you get more involved with AgenticAdvertising.org. What would you like to do next?`;

  // Send the message using Bolt's client
  try {
    await boltApp.client.chat.postMessage({
      channel: channelId,
      text: messageText,
      thread_ts: threadTs,
    });

    // Also log this as a system message in the unified thread
    await threadService.addMessage({
      thread_id: recentThread.thread_id,
      role: 'system',
      content: messageText,
    });

    logger.info({ slackUserId, channelId }, 'Addie Bolt: Sent account linked message');
    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie Bolt: Failed to send account linked message');
    return false;
  }
}

// ============================================================================
// App Home Handlers
// ============================================================================

/**
 * Handle app_home_opened event - user opened Addie's App Home tab
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAppHomeOpened({ event, client }: any): Promise<void> {
  const userId = event.user;

  logger.debug({ userId }, 'Addie Bolt: App Home opened');

  try {
    const content = await getHomeContent(userId);
    const view = renderHomeView(content);

    await client.views.publish({
      user_id: userId,
      view,
    });

    logger.info({ userId }, 'Addie Bolt: App Home published');
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to render App Home');

    // Publish error state
    try {
      await client.views.publish({
        user_id: userId,
        view: renderErrorView('Unable to load your home. Please try again.'),
      });
    } catch (publishError) {
      logger.error({ error: publishError, userId }, 'Addie Bolt: Failed to publish error view');
    }
  }
}

/**
 * Handle refresh button click - force refresh home content
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleHomeRefresh({ ack, body, client }: any): Promise<void> {
  await ack();

  const userId = body.user?.id;
  logger.debug({ userId }, 'Addie Bolt: Home refresh requested');

  try {
    // Force refresh by bypassing cache
    const content = await getHomeContent(userId, { forceRefresh: true });
    const view = renderHomeView(content);

    await client.views.publish({
      user_id: userId,
      view,
    });
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to refresh App Home');
  }
}

/**
 * Handle "Ask Addie" button - open DM with Addie
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAskAddie({ ack, body, client }: any): Promise<void> {
  await ack();

  const userId = body.user?.id;
  logger.debug({ userId }, 'Addie Bolt: Ask Addie clicked');

  try {
    // Open a DM with the user
    const result = await client.conversations.open({
      users: userId,
    });

    if (result.channel?.id) {
      // Send a welcome message to start the conversation
      await client.chat.postMessage({
        channel: result.channel.id,
        text: "Hi! I'm Addie, your AI assistant for AgenticAdvertising.org. How can I help you today?",
      });
    }
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to open DM');
  }
}

/**
 * Handle "Update Profile" button - start profile update conversation
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleUpdateProfile({ ack, body, client }: any): Promise<void> {
  await ack();

  const userId = body.user?.id;
  logger.debug({ userId }, 'Addie Bolt: Update Profile clicked');

  try {
    // Open a DM with the user
    const result = await client.conversations.open({
      users: userId,
    });

    if (result.channel?.id) {
      // Send a message to start the profile update flow
      await client.chat.postMessage({
        channel: result.channel.id,
        text: "I'd be happy to help you update your profile! What would you like to change?\n\n• Company description\n• Add or update agents\n• Add or update publishers\n• Contact information\n• Markets served\n\nJust let me know what you'd like to update.",
      });
    }
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to start profile update conversation');
  }
}

/**
 * Handle "Browse Working Groups" button - show available groups
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleBrowseGroups({ ack, body, client }: any): Promise<void> {
  await ack();

  const userId = body.user?.id;
  logger.debug({ userId }, 'Addie Bolt: Browse Groups clicked');

  try {
    // Open a DM with the user
    const result = await client.conversations.open({
      users: userId,
    });

    if (result.channel?.id) {
      // Send a message to show working groups
      await client.chat.postMessage({
        channel: result.channel.id,
        text: "I can help you explore working groups! Would you like me to:\n\n• List all available working groups\n• Show groups you're already in\n• Find groups by topic (e.g., Signals, Creatives, Publishers)\n\nWhat sounds most helpful?",
      });
    }
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to start working groups conversation');
  }
}

/**
 * Handle "View Flagged" button (admin only) - show flagged conversations
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleViewFlagged({ ack, body, client }: any): Promise<void> {
  await ack();

  const userId = body.user?.id;
  logger.debug({ userId }, 'Addie Bolt: View Flagged clicked');

  // Verify admin status
  const admin = await isSlackUserAdmin(userId);
  if (!admin) {
    logger.warn({ userId }, 'Addie Bolt: Non-admin tried to view flagged threads');
    return;
  }

  try {
    // Post an ephemeral message with link to admin dashboard
    // Using the channel from the home tab context isn't straightforward,
    // so we open a DM instead
    const result = await client.conversations.open({
      users: userId,
    });

    if (result.channel?.id) {
      await client.chat.postMessage({
        channel: result.channel.id,
        text: "You can view flagged conversations in the admin dashboard:\n\n<https://agenticadvertising.org/admin/addie|Open Addie Admin>",
      });
    }
  } catch (error) {
    logger.error({ error, userId }, 'Addie Bolt: Failed to send flagged threads link');
  }
}

/**
 * Handle reaction_added events
 * When users react to Addie's messages, interpret the reaction as input:
 * - Thumbs up / check = "yes, proceed" or positive feedback
 * - Thumbs down / X = "no, don't do that" or negative feedback
 */
async function handleReactionAdded({
  event,
  context,
}: SlackEventMiddlewareArgs<'reaction_added'> & { context: { botUserId?: string } }): Promise<void> {
  if (!claudeClient || !boltApp) {
    return;
  }

  // Use boltApp.client for API calls
  const client = boltApp.client;

  const reaction = event.reaction;
  const reactingUserId = event.user;
  const itemChannel = event.item.channel;
  const itemTs = event.item.ts;
  const itemUser = event.item_user; // Who authored the message that received the reaction

  // Only process reactions on Addie's messages
  if (!context.botUserId || itemUser !== context.botUserId) {
    return;
  }

  // Check if this is a meaningful reaction (positive or negative)
  const isPositive = POSITIVE_REACTIONS.has(reaction);
  const isNegative = NEGATIVE_REACTIONS.has(reaction);

  if (!isPositive && !isNegative) {
    // Not a reaction we care about
    return;
  }

  logger.info(
    { reaction, isPositive, isNegative, reactingUserId, itemChannel, itemTs },
    'Addie Bolt: Received reaction on Addie message'
  );

  const threadService = getThreadService();

  // Build external ID to find the thread
  // For thread replies, itemTs is the reply ts; we need to find the thread
  // First, try to get the message to find its thread_ts
  let threadTs = itemTs;
  try {
    const result = await client.conversations.replies({
      channel: itemChannel,
      ts: itemTs,
      limit: 1,
      inclusive: true,
    });
    if (result.messages && result.messages.length > 0) {
      // If the message has a thread_ts, use that; otherwise use the message ts
      threadTs = result.messages[0].thread_ts || result.messages[0].ts || itemTs;
    }
  } catch (error) {
    logger.debug({ error, itemChannel, itemTs }, 'Addie Bolt: Could not fetch message for thread_ts');
  }

  const externalId = `${itemChannel}:${threadTs}`;

  // Find the thread
  const thread = await threadService.getThreadByExternalId('slack', externalId);
  if (!thread) {
    logger.debug({ externalId }, 'Addie Bolt: No thread found for reaction');
    return;
  }

  // Get the last few messages to understand context
  const messages = await threadService.getThreadMessages(thread.thread_id);
  const lastAssistantMessage = messages
    .filter(m => m.role === 'assistant')
    .pop();

  if (!lastAssistantMessage) {
    return;
  }

  // Check if the last assistant message was asking for confirmation
  const messageContent = lastAssistantMessage.content.toLowerCase();
  const isConfirmationRequest =
    messageContent.includes('should i') ||
    messageContent.includes('shall i') ||
    messageContent.includes('want me to') ||
    messageContent.includes('go ahead') ||
    messageContent.includes('proceed') ||
    messageContent.includes('confirm') ||
    messageContent.includes('would you like me to') ||
    messageContent.includes('do you want me to');

  // Determine the user's intent
  let userInput: string;
  if (isConfirmationRequest) {
    if (isPositive) {
      userInput = '[User reacted with ' + reaction + ' emoji to confirm: Yes, go ahead]';
    } else {
      userInput = '[User reacted with ' + reaction + ' emoji to decline: No, don\'t do that]';
    }
  } else {
    // Not a confirmation, just feedback
    if (isPositive) {
      userInput = '[User reacted with ' + reaction + ' emoji as positive feedback]';
      // Record as positive feedback
      await threadService.addMessageFeedback(lastAssistantMessage.message_id, {
        rating: 5,
        rating_category: 'emoji_feedback',
        rating_notes: `User reacted with :${reaction}:`,
        rated_by: reactingUserId,
        rating_source: 'user',
      });
      // Don't respond to general positive feedback
      return;
    } else {
      userInput = '[User reacted with ' + reaction + ' emoji as negative feedback]';
      // Record as negative feedback
      await threadService.addMessageFeedback(lastAssistantMessage.message_id, {
        rating: 1,
        rating_category: 'emoji_feedback',
        rating_notes: `User reacted with :${reaction}:`,
        rated_by: reactingUserId,
        rating_source: 'user',
      });
      // Don't respond to general negative feedback
      return;
    }
  }

  // Log the reaction as a user message
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'user',
    content: userInput,
    content_sanitized: userInput,
  });

  // Get member context
  const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
    reactingUserId,
    userInput
  );

  // Create user-scoped tools
  const { tools: userTools, isAdmin: userIsAdmin } = await createUserScopedTools(memberContext, reactingUserId);

  // Admin users get higher iteration limit for bulk operations
  const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : undefined;

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, undefined, userTools, undefined, processOptions);
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Error processing reaction response');
    response = {
      text: isPositive ? "Got it, I'll proceed!" : "Understood, I won't do that.",
      tools_used: [],
      tool_executions: [],
      flagged: false,
    };
  }

  // Send response in thread
  try {
    await client.chat.postMessage({
      channel: itemChannel,
      text: response.text,
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send reaction response');
  }

  // Log assistant response
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'assistant',
    content: response.text,
    tools_used: response.tools_used,
    tool_calls: response.tool_executions?.map(exec => ({
      name: exec.tool_name,
      input: exec.parameters,
      result: exec.result,
    })),
    model: AddieModelConfig.chat,
  });

  logger.info(
    { threadId: thread.thread_id, reaction, isConfirmation: isConfirmationRequest },
    'Addie Bolt: Processed reaction and responded'
  );
}
