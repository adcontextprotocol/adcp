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
  isSlackUserAAOAdmin,
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
  canScheduleMeetings,
} from './mcp/meeting-tools.js';
import {
  ESCALATION_TOOLS,
  createEscalationToolHandlers,
} from './mcp/escalation-tools.js';
import {
  COLLABORATION_TOOLS,
  createCollaborationToolHandlers,
} from './mcp/collaboration-tools.js';
import {
  ADCP_TOOLS,
  createAdcpToolHandlers,
} from './mcp/adcp-tools.js';
import {
  SCHEMA_TOOLS,
  createSchemaToolHandlers,
} from './mcp/schema-tools.js';
import {
  BRAND_TOOLS,
  createBrandToolHandlers,
} from './mcp/brand-tools.js';
import {
  PROPERTY_TOOLS,
  createPropertyToolHandlers,
} from './mcp/property-tools.js';
import {
  COMMITTEE_LEADER_TOOLS,
  createCommitteeLeaderToolHandlers,
  isCommitteeLeader,
} from './mcp/committee-leader-tools.js';
import {
  SOCIAL_DRAFT_TOOLS,
  createSocialDraftToolHandlers,
} from './mcp/social-draft-tools.js';
import {
  IMAGE_TOOLS,
  createImageToolHandlers,
} from './mcp/image-tools.js';
import { AddieDatabase } from '../db/addie-db.js';
import { SUGGESTED_PROMPTS, STATUS_MESSAGES, buildDynamicSuggestedPrompts } from './prompts.js';
import { AddieModelConfig } from '../config/models.js';
import { getMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import { checkForSensitiveTopics } from './sensitive-topics.js';
import * as relationshipDb from '../db/relationship-db.js';
import { loadRelationshipContext, formatContextForPrompt } from './services/relationship-context.js';
import * as personEvents from '../db/person-events-db.js';
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

  // Billing tools are registered per-request in createUserScopedTools
  // to allow filtering them out in channel mentions (prevents enrollment pitching)

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

  // Register schema tools (validate JSON, get schemas, list schemas)
  const schemaHandlers = createSchemaToolHandlers();
  for (const tool of SCHEMA_TOOLS) {
    const handler = schemaHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register brand tools (research brands, resolve identities, save to registry)
  const brandHandlers = createBrandToolHandlers();
  for (const tool of BRAND_TOOLS) {
    const handler = brandHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register property tools (validate adagents.json, resolve publishers, save hosted properties)
  const propertyHandlers = createPropertyToolHandlers();
  for (const tool of PROPERTY_TOOLS) {
    const handler = propertyHandlers.get(tool.name);
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
 * Build per-request context for the system prompt.
 * Returns context separately from the user message.
 */
async function buildRequestContext(
  userId: string,
  options?: { skipGoals?: boolean }
): Promise<{ requestContext: string; memberContext: MemberContext | null; personId: string | null }> {
  try {
    const memberContext = await getMemberContext(userId);
    const memberContextText = formatMemberContextForPrompt(memberContext);

    // Load cross-surface relationship context
    let relationshipPrompt = '';
    let personId: string | null = null;
    try {
      personId = await relationshipDb.resolvePersonId({
        slack_user_id: userId,
        email: memberContext?.slack_user?.email ?? undefined,
      });
      const relationshipCtx = await loadRelationshipContext(personId);
      relationshipPrompt = formatContextForPrompt(relationshipCtx);
    } catch (error) {
      logger.warn({ error, userId }, 'Addie: Failed to load relationship context, continuing without it');
    }

    const sections = [memberContextText, relationshipPrompt].filter(Boolean);
    return {
      requestContext: sections.length > 0 ? sections.join('\n\n') : '',
      memberContext,
      personId,
    };
  } catch (error) {
    logger.warn({ error, userId }, 'Addie: Failed to get member context, continuing without it');
    return { requestContext: '', memberContext: null, personId: null };
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
  threadId?: string,
  options?: { isChannelMention?: boolean }
): Promise<UserScopedToolsResult> {
  const memberHandlers = createMemberToolHandlers(memberContext, slackUserId);
  const allTools = [...MEMBER_TOOLS];
  const allHandlers = new Map(memberHandlers);

  // Add billing tools (for membership signup assistance)
  // Skip in channel mentions to prevent enrollment pitching
  if (!options?.isChannelMention) {
    const billingHandlers = createBillingToolHandlers(memberContext);
    allTools.push(...BILLING_TOOLS);
    for (const [name, handler] of billingHandlers) {
      allHandlers.set(name, handler);
    }
  }

  // Add escalation tools (available to all users)
  const escalationHandlers = createEscalationToolHandlers(memberContext, slackUserId, threadId);
  allTools.push(...ESCALATION_TOOLS);
  for (const [name, handler] of escalationHandlers) {
    allHandlers.set(name, handler);
  }

  // Add collaboration tools (available to all members - DM other members, forward context)
  if (memberContext?.is_member) {
    const collaborationHandlers = createCollaborationToolHandlers(memberContext, slackUserId, threadId);
    allTools.push(...COLLABORATION_TOOLS);
    for (const [name, handler] of collaborationHandlers) {
      allHandlers.set(name, handler);
    }

    // Add social drafting tools (help members write social posts about industry articles)
    const socialDraftHandlers = createSocialDraftToolHandlers(memberContext);
    allTools.push(...SOCIAL_DRAFT_TOOLS);
    for (const [name, handler] of socialDraftHandlers) {
      allHandlers.set(name, handler);
    }
  }

  // Add image library tools (search approved illustrations, log requests)
  const imageHandlers = createImageToolHandlers(slackUserId, threadId);
  allTools.push(...IMAGE_TOOLS);
  for (const [name, handler] of imageHandlers) {
    allHandlers.set(name, handler);
  }

  // Add AdCP protocol tools (standard MCP tools for interacting with agents)
  // These match the skill format and enable proper protocol interactions
  const adcpHandlers = createAdcpToolHandlers(memberContext);
  allTools.push(...ADCP_TOOLS);
  for (const [name, handler] of adcpHandlers) {
    allHandlers.set(name, handler);
  }

  // Check if user is AAO admin (based on aao-admin working group membership)
  const userIsAdmin = slackUserId ? await isSlackUserAAOAdmin(slackUserId) : false;

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
  }

  // Add meeting tools if user can schedule meetings (admin or committee leader)
  const canSchedule = slackUserId ? await canScheduleMeetings(slackUserId) : userIsAdmin;
  if (canSchedule) {
    const meetingHandlers = createMeetingToolHandlers(memberContext, slackUserId);
    allTools.push(...MEETING_TOOLS);
    for (const [name, handler] of meetingHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie: Meeting tools enabled for this user');
  }

  // Add committee leadership tools if user leads any committees
  const isLeader = slackUserId ? await isCommitteeLeader(slackUserId) : false;
  if (isLeader) {
    const committeeHandlers = createCommitteeLeaderToolHandlers(memberContext, slackUserId);
    allTools.push(...COMMITTEE_LEADER_TOOLS);
    for (const [name, handler] of committeeHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie: Committee leadership tools enabled for this user');
  }

  // Override bookmark_resource handler with user-scoped version (for attribution)
  if (slackUserId) {
    allHandlers.set('bookmark_resource', createUserScopedBookmarkHandler(slackUserId));
  }

  // Override Slack search handlers with user-scoped versions (for private channel access control)
  if (slackUserId) {
    const userScopedKnowledgeHandlers = createKnowledgeToolHandlers(slackUserId);
    const searchSlackHandler = userScopedKnowledgeHandlers.get('search_slack');
    const getChannelActivityHandler = userScopedKnowledgeHandlers.get('get_channel_activity');
    if (searchSlackHandler) {
      allHandlers.set('search_slack', searchSlackHandler);
    }
    if (getChannelActivityHandler) {
      allHandlers.set('get_channel_activity', getChannelActivityHandler);
    }
  }

  return {
    tools: {
      tools: allTools,
      handlers: allHandlers,
    },
    isAAOAdmin: userIsAdmin,
  };
}

/**
 * Get dynamic suggested prompts for a Slack user
 */
async function getDynamicSuggestedPrompts(userId: string): Promise<SuggestedPrompt[]> {
  try {
    const memberContext = await getMemberContext(userId);
    const userIsAdmin = await isSlackUserAAOAdmin(userId);
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

  // Check if user is an AAO admin (for admin-only tools access)
  const isAAOAdmin = await isSlackUserAAOAdmin(event.user);
  logger.debug({ userId: event.user, isAAOAdmin }, 'Addie: Checked admin status');

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

  // Build per-request context for system prompt
  const { requestContext, memberContext, personId } = await buildRequestContext(event.user);

  // Record the user's message in the relationship and event log
  if (personId) {
    relationshipDb.recordPersonMessage(personId, 'slack')
      .then(() => relationshipDb.deriveSentiment(personId))
      .catch(error => {
        logger.warn({ error, personId }, 'Addie: Failed to record person message');
      });
    personEvents.recordEvent(personId, 'message_received', {
      channel: 'slack',
      data: { source: 'dm', text_length: textWithResolvedMentions.length },
    }).catch(err => logger.warn({ err, personId }, 'Addie: Failed to record message_received event'));
  }

  // Add admin prefix to user message if applicable
  const userMessage = isAAOAdmin ? `[ADMIN USER] ${inputValidation.sanitized}` : inputValidation.sanitized;

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
    const { tools: userTools, isAAOAdmin: userIsAdmin } = await createUserScopedTools(memberContext, event.user, event.thread_ts);

    // Admin users get higher iteration limit for bulk operations
    const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS, requestContext } : { requestContext };

    // Process with Claude
    try {
      response = await claudeClient.processMessage(userMessage, undefined, userTools, undefined, processOptions);
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

  // Record Addie's response and evaluate stage transitions
  if (personId) {
    relationshipDb.recordAddieMessage(personId, 'slack').catch(error => {
      logger.warn({ error, personId }, 'Addie: Failed to record Addie message');
    });
    personEvents.recordEvent(personId, 'message_sent', {
      channel: 'slack',
      data: { source: 'dm_reply', text_length: response.text.length },
    }).catch(err => logger.warn({ err, personId }, 'Addie: Failed to record message_sent event'));
    relationshipDb.evaluateStageTransitions(personId).catch(error => {
      logger.warn({ error, personId }, 'Addie: Failed to evaluate stage transitions');
    });
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

  // Check if user is an AAO admin (for admin-only tools access)
  const isAAOAdmin = await isSlackUserAAOAdmin(event.user);
  logger.debug({ userId: event.user, isAAOAdmin }, 'Addie: Checked admin status for mention');

  // Strip bot mention
  const rawText = botUserId ? stripBotMention(event.text, botUserId) : event.text;

  // Resolve user mentions to include names (e.g., <@U123> -> <@U123|John>)
  const textWithResolvedMentions = await resolveSlackMentions(rawText, lookupSlackUserName);

  // Sanitize input
  const inputValidation = sanitizeInput(textWithResolvedMentions);

  // Build per-request context for system prompt
  // Skip goals in channel mentions to prevent membership pitching
  const { requestContext: baseContext, memberContext, personId } = await buildRequestContext(event.user, { skipGoals: true });

  // Record the user's message in the relationship
  if (personId) {
    relationshipDb.recordPersonMessage(personId, 'slack')
      .then(() => relationshipDb.deriveSentiment(personId))
      .catch(error => {
        logger.warn({ error, personId }, 'Addie: Failed to record person message (mention)');
      });
  }

  // Add channel guardrails — mentions always happen in channels
  const channelGuardrails = [
    '',
    '## Channel context',
    '**IMPORTANT: This is a channel message visible to all channel members.**',
    '- You MUST NOT pitch membership, send join links, or recruit in channels — membership conversations belong in DMs.',
    '- You MUST NOT share financial data, member counts, invoice information, individual member details, pricing information, or any other sensitive organizational data.',
  ].join('\n');
  const requestContext = baseContext + channelGuardrails;

  // Add admin prefix to user message if applicable
  const userMessage = isAAOAdmin ? `[ADMIN USER] ${inputValidation.sanitized}` : inputValidation.sanitized;

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
    const { tools: userTools, isAAOAdmin: userIsAdmin } = await createUserScopedTools(memberContext, event.user, event.thread_ts || event.ts, { isChannelMention: true });

    // Admin users get higher iteration limit for bulk operations
    const processOptions = userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS, requestContext } : { requestContext };

    // Process with Claude
    try {
      response = await claudeClient.processMessage(userMessage, undefined, userTools, undefined, processOptions);
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

  // Record Addie's response and evaluate stage transitions
  if (personId) {
    relationshipDb.recordAddieMessage(personId, 'slack').catch(error => {
      logger.warn({ error, personId }, 'Addie: Failed to record Addie message (mention)');
    });
    relationshipDb.evaluateStageTransitions(personId).catch(error => {
      logger.warn({ error, personId }, 'Addie: Failed to evaluate stage transitions (mention)');
    });
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
    });
    logger.info({ slackUserId, channelId: recentThread.channel_id }, 'Addie: Sent account linked message');
    return true;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie: Failed to send account linked message');
    return false;
  }
}
