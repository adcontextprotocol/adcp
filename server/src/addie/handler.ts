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
import { AddieDatabase } from '../db/addie-db.js';
import { SUGGESTED_PROMPTS, STATUS_MESSAGES } from './prompts.js';
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
let addieModel: string = 'claude-sonnet-4-20250514';

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
  addieModel = process.env.ADDIE_ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  claudeClient = new AddieClaudeClient(apiKey, addieModel);

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

  // Set suggested prompts
  try {
    await setAssistantSuggestedPrompts(event.channel_id, SUGGESTED_PROMPTS);
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

  // Sanitize input
  const inputValidation = sanitizeInput(event.text);

  // Set status to thinking
  try {
    await setAssistantStatus(channelId, STATUS_MESSAGES.thinking);
  } catch {
    // Status update failed, continue anyway
  }

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(inputValidation.sanitized);
  } catch (error) {
    logger.error({ error }, 'Addie: Error processing message');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
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
    model: addieModel,
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

  // Strip bot mention
  const rawText = botUserId ? stripBotMention(event.text, botUserId) : event.text;

  // Sanitize input
  const inputValidation = sanitizeInput(rawText);

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(inputValidation.sanitized);
  } catch (error) {
    logger.error({ error }, 'Addie: Error processing mention');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
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
    model: addieModel,
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
