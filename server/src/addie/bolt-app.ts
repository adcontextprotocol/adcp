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
import { AddieClaudeClient } from './claude-client.js';
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
import { SUGGESTED_PROMPTS } from './prompts.js';
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
import { getThreadReplies, getSlackUserWithAddieToken } from '../slack/client.js';

let boltApp: InstanceType<typeof App> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let expressReceiver: any = null;
let claudeClient: AddieClaudeClient | null = null;
let addieDb: AddieDatabase | null = null;
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

  // Register the assistant
  boltApp.assistant(assistant);

  // Register app_mention handler
  boltApp.event('app_mention', handleAppMention);

  // Register channel message handler (for HITL proposed responses)
  boltApp.event('message', handleChannelMessage);

  // Register feedback button handler
  boltApp.action('addie_feedback', handleFeedbackAction);

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

    // Linked - personalized prompts
    const prompts: SuggestedPrompt[] = [];

    if (memberContext.working_groups && memberContext.working_groups.length > 0) {
      prompts.push({
        title: 'My working groups',
        message: "What's happening in my working groups?",
      });
    } else {
      prompts.push({
        title: 'Find a working group',
        message: 'What working groups can I join based on my interests?',
      });
    }

    prompts.push({
      title: 'Test my agent',
      message: 'Help me verify my AdCP agent is working correctly',
    });

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
    logger.warn({ error, userId }, 'Addie Bolt: Failed to build dynamic prompts, using defaults');
    return SUGGESTED_PROMPTS;
  }
}

/**
 * Build message with member context prepended
 */
async function buildMessageWithMemberContext(
  userId: string,
  sanitizedMessage: string
): Promise<{ message: string; memberContext: MemberContext | null }> {
  try {
    const memberContext = await getMemberContext(userId);
    const memberContextText = formatMemberContextForPrompt(memberContext);

    if (memberContextText) {
      return {
        message: `${memberContextText}\n---\n\n${sanitizedMessage}`,
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
 * Create user-scoped member tools
 */
function createUserScopedTools(memberContext: MemberContext | null): RequestTools {
  const handlers = createMemberToolHandlers(memberContext);
  return {
    tools: MEMBER_TOOLS,
    handlers,
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

  logger.info(
    { userId, channelId: context.channel_id },
    'Addie Bolt: Thread started'
  );

  // Save the initial context
  try {
    await saveThreadContext();
  } catch (error) {
    logger.warn({ error }, 'Addie Bolt: Failed to save initial thread context');
  }

  // Set dynamic suggested prompts
  try {
    const prompts = await buildDynamicSuggestedPrompts(userId);
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

  // Extract fields safely - not all message events have these fields
  const userId = 'user' in event ? event.user : undefined;
  const messageText = 'text' in event ? event.text : undefined;
  const threadTs = 'thread_ts' in event ? event.thread_ts : ('ts' in event ? event.ts : undefined);

  // Skip if not a user message
  if (!userId || !messageText) {
    logger.debug('Addie Bolt: Ignoring message event without user or text');
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
      slackThreadContext = {
        viewing_channel_id: boltContext.channel_id,
        team_id: boltContext.team_id,
        enterprise_id: boltContext.enterprise_id || undefined,
      };
      logger.debug({ viewingChannel: boltContext.channel_id }, 'Addie Bolt: User is viewing channel');
    }
  } catch (error) {
    logger.debug({ error }, 'Addie Bolt: Could not get thread context');
  }

  // Get or create unified thread
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    context: slackThreadContext,
  });

  // Build message with member context
  const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
    userId,
    inputValidation.sanitized
  );

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

  // Create user-scoped tools
  const userTools = createUserScopedTools(memberContext);

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamer = (client as any).chatStream({
        channel: channelId,
        recipient_team_id: teamId,
        recipient_user_id: userId,
        thread_ts: threadTs,
      });

      // Process Claude response stream
      for await (const event of claudeClient.processMessageStream(messageWithContext, undefined, userTools)) {
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
      response = await claudeClient.processMessage(messageWithContext, undefined, userTools);
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
    })),
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    tokens_input: response.usage?.input_tokens,
    tokens_output: response.usage?.output_tokens,
    flagged: assistantFlagged,
    flag_reason: flagReason || undefined,
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

  const startTime = Date.now();
  const threadService = getThreadService();

  // Strip bot mention
  let rawText = event.text || '';
  if (context.botUserId) {
    rawText = rawText.replace(new RegExp(`<@${context.botUserId}>\\s*`, 'gi'), '').trim();
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

  // Fetch thread context if this mention is in a thread
  const MAX_THREAD_CONTEXT_MESSAGES = 25;
  let threadContext = '';
  if (isInThread && event.thread_ts) {
    try {
      const threadMessages = await getThreadReplies(channelId, event.thread_ts, true);
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
              const user = await getSlackUserWithAddieToken(uid);
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

  // Build message with member context and thread context
  const { message: messageWithMemberContext, memberContext } = await buildMessageWithMemberContext(
    userId,
    inputValidation.sanitized
  );

  // Prepend thread context if available (member context already includes the user's message)
  const messageWithContext = threadContext
    ? `${threadContext}${messageWithMemberContext}`
    : messageWithMemberContext;

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  await threadService.addMessage({
    thread_id: thread.thread_id,
    role: 'user',
    content: rawText,
    content_sanitized: inputValidation.sanitized,
    flagged: userMessageFlagged,
    flag_reason: inputValidation.reason || undefined,
  });

  // Create user-scoped tools
  const userTools = createUserScopedTools(memberContext);

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(messageWithContext, undefined, userTools);
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
    })),
    model: AddieModelConfig.chat,
    latency_ms: Date.now() - startTime,
    flagged: assistantFlagged,
    flag_reason: flagReason || undefined,
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
      });

      logger.info({
        threadId: thread.thread_id,
        messageId: latestAssistant.message_id,
        feedback: isPositive ? 'positive' : 'negative',
        userId,
      }, 'Addie Bolt: Feedback recorded');
    }
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
 * Handle channel messages (not mentions) for HITL proposed responses
 *
 * When Addie sees a message in a channel it's in, it evaluates whether
 * it could provide a helpful response. If so, it queues a proposed response
 * for admin approval before sending.
 */
async function handleChannelMessage({
  event,
  context,
}: SlackEventMiddlewareArgs<'message'> & { context: { botUserId?: string } }): Promise<void> {
  // Skip if not initialized
  if (!claudeClient || !addieDb) {
    return;
  }

  // Type guard for message events - skip subtypes (edits, deletes, etc.)
  if (!('text' in event) || !event.text || ('subtype' in event && event.subtype)) {
    return;
  }

  // Skip bot messages (including our own)
  if ('bot_id' in event && event.bot_id) {
    return;
  }

  // Skip if this is a mention (handled by handleAppMention)
  if (context.botUserId && event.text.includes(`<@${context.botUserId}>`)) {
    return;
  }

  // Skip DMs - this is for channel messages only
  if (event.channel_type === 'im') {
    return;
  }

  const userId = 'user' in event ? event.user : undefined;
  if (!userId) {
    return;
  }

  const channelId = event.channel;
  const messageText = event.text;
  const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) || event.ts;

  logger.debug({ channelId, userId, hasThread: !!('thread_ts' in event && event.thread_ts) },
    'Addie Bolt: Evaluating channel message for potential response');

  // First, ask Claude if this message warrants a response from Addie
  // This is a quick evaluation to avoid generating full responses for every message
  const evaluationPrompt = `You are Addie, an AI assistant for AgenticAdvertising.org. A message was posted in a Slack channel you're in.

Evaluate if this message is something you should respond to. You should respond if:
- It's a question about AdCP, agentic advertising, or AgenticAdvertising.org
- It's a request for help that you can assist with
- It's a discussion where you have relevant knowledge to contribute
- Someone is confused or asking for clarification about topics you know about

You should NOT respond if:
- It's casual conversation or social chat
- It's an internal team discussion not related to AdCP
- It's a message that doesn't need your input
- Someone else is clearly handling the question
- It's a simple acknowledgment or emoji reaction

Message: "${messageText.substring(0, 500)}"

Respond with ONLY "yes" or "no" - nothing else.`;

  try {
    // Use empty tools object for evaluation - just need a yes/no
    const emptyTools: RequestTools = { tools: [], handlers: new Map() };
    const evaluation = await claudeClient.processMessage(evaluationPrompt, undefined, emptyTools);
    const shouldRespond = evaluation.text?.toLowerCase().trim() === 'yes';

    if (!shouldRespond) {
      logger.debug({ channelId }, 'Addie Bolt: Message does not warrant response');
      return;
    }

    logger.info({ channelId, userId }, 'Addie Bolt: Generating proposed response for channel message');

    // Get member context for the user
    const { message: messageWithContext, memberContext } = await buildMessageWithMemberContext(
      userId,
      messageText
    );

    // Generate a response
    const userTools = createUserScopedTools(memberContext);
    const response = await claudeClient.processMessage(messageWithContext, undefined, userTools);

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
      },
      // Expire after 24 hours - old responses become stale
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
