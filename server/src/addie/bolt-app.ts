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
import { captureEvent } from '../utils/posthog.js';
import { AddieClaudeClient, ADMIN_MAX_ITERATIONS, CERTIFICATION_MAX_ITERATIONS, type UserScopedToolsResult } from './claude-client.js';
import { AddieDatabase } from '../db/addie-db.js';
import { SlackDatabase } from '../db/slack-db.js';
import { EmailPreferencesDatabase } from '../db/email-preferences-db.js';
import { getPool } from '../db/client.js';
import {
  isKnowledgeReady,
  createKnowledgeToolHandlers,
  createUserScopedBookmarkHandler,
} from './mcp/knowledge-search.js';
import { registerBaselineTools } from './register-baseline-tools.js';
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from './mcp/member-tools.js';
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
  isSlackUserAAOAdmin,
} from './mcp/admin-tools.js';
import {
  EVENT_READONLY_TOOLS,
  EVENT_ADMIN_TOOLS,
  createEventToolHandlers,
  canCreateEvents,
} from './mcp/event-tools.js';
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from './mcp/billing-tools.js';
import {
  ESCALATION_TOOLS,
  createEscalationToolHandlers,
} from './mcp/escalation-tools.js';
import {
  NEWSLETTER_TOOLS,
  createNewsletterToolHandlers,
} from './mcp/newsletter-tools.js';
import {
  ADCP_TOOLS,
  createAdcpToolHandlers,
} from './mcp/adcp-tools.js';
import {
  MEETING_TOOLS,
  createMeetingToolHandlers,
  canScheduleMeetings,
} from './mcp/meeting-tools.js';
import { SUGGESTED_PROMPTS, buildDynamicSuggestedPrompts, HISTORY_UNAVAILABLE_NOTE } from './prompts.js';
import { AddieModelConfig, ModelConfig } from '../config/models.js';
import { getMemberContext, formatMemberContextForPrompt, type MemberContext } from './member-context.js';
import {
  sanitizeInput,
  validateOutput,
  wrapUrlsForSlack,
  extractMarkdownImages,
  guardBareJsonEnvelope,
  logInteraction,
} from './security.js';
import type { RequestTools } from './claude-client.js';
import type { SuggestedPrompt } from './types.js';
import { DatabaseThreadContextStore } from './thread-context-store.js';
import { getThreadService, type ThreadContext } from './thread-service.js';
import { isMultiPartyThread, isDirectedAtAddie, isAddressedToAnotherUser, buildThreadStyleHint, buildThreadSummaryForRouter } from './thread-utils.js';
import { getThreadReplies, getSlackUser, getChannelInfo, getChannelHistory } from '../slack/client.js';
import { AddieRouter, type RoutingContext, type ExecutionPlan, type ConfidenceTier } from './router.js';
import {
  getToolsForSets,
  buildUnavailableSetsHint,
} from './tool-sets.js';
import { getHomeContent, renderHomeView, renderErrorView, invalidateHomeCache } from './home/index.js';
import { URL_TOOLS, createUrlToolHandlers } from './mcp/url-tools.js';
import { GOOGLE_DOCS_TOOLS, createGoogleDocsToolHandlers } from './mcp/google-docs.js';
import { ILLUSTRATION_TOOLS, createIllustrationToolHandlers } from './mcp/illustration-tools.js';
// DIRECTORY_TOOLS registered via registerBaselineTools()
import { SI_HOST_TOOLS, createSiHostToolHandlers } from './mcp/si-host-tools.js';
import { BRAND_TOOLS, createBrandToolHandlers } from './mcp/brand-tools.js';
import { COLLABORATION_TOOLS, createCollaborationToolHandlers } from './mcp/collaboration-tools.js';
import { SOCIAL_DRAFT_TOOLS, createSocialDraftToolHandlers } from './mcp/social-draft-tools.js';
import { COMMITTEE_LEADER_TOOLS, createCommitteeLeaderToolHandlers } from './mcp/committee-leader-tools.js';
import { PROPERTY_TOOLS, createPropertyToolHandlers } from './mcp/property-tools.js';
import { SCHEMA_TOOLS, createSchemaToolHandlers } from './mcp/schema-tools.js';
import { CERTIFICATION_TOOLS, createCertificationToolHandlers, buildCertificationContext } from './mcp/certification-tools.js';
import * as certDb from '../db/certification-db.js';
import { siRetriever, type SIRetrievalResult } from './services/si-retriever.js';
import {
  isManagedChannel,
  extractArticleUrls,
  queueCommunityArticle,
} from './services/community-articles.js';
import { isRetriesExhaustedError } from '../utils/anthropic-retry.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { getDigestByReviewMessage, approveDigest, updateDigestContent, revertToDraft, isLegacyContent } from '../db/digest-db.js';
import { applyDigestEdit } from './services/digest-editor.js';
import { renderDigestReview } from './templates/weekly-digest.js';
import * as relationshipDb from '../db/relationship-db.js';
import * as personEvents from '../db/person-events-db.js';
import {
  getProspectChannel,
  getEscalationChannel,
  getBillingChannel,
  getErrorChannel,
  getAdminChannel,
} from '../db/system-settings-db.js';

/**
 * Slack's built-in system bot user ID.
 * Slackbot sends system notifications (e.g., "added you to #channel") that should be ignored.
 */
const SLACKBOT_USER_ID = 'USLACKBOT';
const ADMIN_CHANNEL_WG_SLUG = 'aao-admin';

/**
 * Tool sets to auto-include when Addie is in a system-configured channel.
 * Keyed by the channel's system role from system_settings.
 */
type SystemChannelRole = 'prospect' | 'escalation' | 'billing' | 'error' | 'admin';

const SYSTEM_CHANNEL_TOOL_SETS: Record<SystemChannelRole, string[]> = {
  prospect: ['admin', 'outreach'],
  escalation: ['admin'],
  billing: ['admin', 'billing'],
  error: ['admin'],
  admin: ['admin'],
};

let systemChannelMap: Map<string, SystemChannelRole> | null = null;
let systemChannelMapExpiresAt = 0;
let systemChannelRefreshPromise: Promise<void> | null = null;
const SYSTEM_CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

async function getSystemChannelRole(channelId: string): Promise<SystemChannelRole | null> {
  if (!systemChannelMap || Date.now() > systemChannelMapExpiresAt) {
    if (!systemChannelRefreshPromise) {
      systemChannelRefreshPromise = (async () => {
        const map = new Map<string, SystemChannelRole>();
        const [prospect, escalation, billing, error, admin] = await Promise.all([
          getProspectChannel(),
          getEscalationChannel(),
          getBillingChannel(),
          getErrorChannel(),
          getAdminChannel(),
        ]);
        if (prospect.channel_id) map.set(prospect.channel_id, 'prospect');
        if (escalation.channel_id) map.set(escalation.channel_id, 'escalation');
        if (billing.channel_id) map.set(billing.channel_id, 'billing');
        if (error.channel_id) map.set(error.channel_id, 'error');
        if (admin.channel_id) map.set(admin.channel_id, 'admin');
        systemChannelMap = map;
        systemChannelMapExpiresAt = Date.now() + SYSTEM_CHANNEL_CACHE_TTL_MS;
        systemChannelRefreshPromise = null;
      })();
    }
    await systemChannelRefreshPromise;
  }
  return systemChannelMap!.get(channelId) ?? null;
}

/**
 * Shared database instance for working group lookups
 */
const workingGroupDb = new WorkingGroupDatabase();

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
 * Record a person's inbound message in the relationship system.
 * Resets unreplied_outreach_count, derives sentiment, and logs the event.
 */
async function recordPersonInboundMessage(
  slackUserId: string,
  channel: 'slack' | 'email' | 'web',
  source: string,
  textLength: number
): Promise<void> {
  try {
    const personId = await relationshipDb.resolvePersonId({ slack_user_id: slackUserId });
    await relationshipDb.recordPersonMessage(personId, channel);
    await relationshipDb.deriveSentiment(personId);
    await personEvents.recordEvent(personId, 'message_received', {
      channel,
      data: { source, text_length: textLength },
    });
  } catch (error) {
    // Not all Slack users have person_relationships records yet — that's OK
    logger.debug({ error, slackUserId }, 'Addie Bolt: Could not record person inbound message');
  }
}

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

/**
 * Result of checking Addie's participation in a thread.
 * Returns both the participation status and the messages to avoid duplicate API calls.
 */
interface ThreadParticipationResult {
  participated: boolean;
  messages: Awaited<ReturnType<typeof getThreadReplies>>;
}

/**
 * Check if Addie has already participated in a thread.
 * Used to determine if replies in a thread should be treated as implicit @mentions.
 *
 * When a user replies to a thread where Addie has already responded,
 * we should respond automatically without requiring an explicit @mention.
 * This creates a natural conversational flow.
 *
 * Returns both the participation status AND the thread messages to avoid
 * a duplicate API call when building thread context.
 */
async function checkAddieThreadParticipation(
  channelId: string,
  threadTs: string,
  botUserId: string
): Promise<ThreadParticipationResult> {
  try {
    const messages = await getThreadReplies(channelId, threadTs);
    // Check if any message in the thread is from Addie (matches bot user ID)
    // Note: Slack messages from bots have a 'user' field matching the bot's user ID
    const participated = messages.some(msg => msg.user === botUserId);
    return { participated, messages };
  } catch (error) {
    logger.warn({ error, channelId, threadTs }, 'Addie Bolt: Failed to check thread participation');
    return { participated: false, messages: [] };
  }
}

/** Delay (ms) before Addie responds in channel threads when not explicitly mentioned.
 *  Gives humans time to reply first. After the delay, re-checks the thread
 *  and skips if a human has already responded. */
const THREAD_RESPONSE_DELAY_MS = 45_000; // 45 seconds

/**
 * Wait before responding in a thread, then re-check if a human has already replied.
 * Returns true if Addie should still respond, false if a human got there first.
 */
async function shouldRespondAfterDelay(
  channelId: string,
  threadTs: string,
  triggerMessageTs: string,
  botUserId: string,
): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, THREAD_RESPONSE_DELAY_MS));

  try {
    const freshMessages = await getThreadReplies(channelId, threadTs);
    // Check if any human message arrived AFTER the triggering message.
    // Slack timestamps are "epoch.sequence" strings — string comparison is chronologically correct.
    const hasNewerHumanReply = freshMessages.some(
      msg => msg.user
        && msg.user !== botUserId
        && msg.ts > triggerMessageTs
    );
    return !hasNewerHumanReply;
  } catch (error) {
    logger.warn({ error, channelId, threadTs }, 'Addie Bolt: Failed to re-check thread after delay');
    // On error, respond anyway to avoid silently dropping messages
    return true;
  }
}

/** Working group and council channels get Opus for protocol depth. */
function isDepthChannel(channelName: string | undefined): boolean {
  return channelName ? /^(wg-|council-)/.test(channelName) : false;
}

let boltApp: InstanceType<typeof App> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let expressReceiver: any = null;
let claudeClient: AddieClaudeClient | null = null;

/**
 * Fetch channel info and build a partial ThreadContext with channel details
 * Also looks up any associated working group for the channel
 */
async function buildChannelContext(channelId: string): Promise<Partial<ThreadContext>> {
  const context: Partial<ThreadContext> = {
    viewing_channel_id: channelId,
  };

  try {
    const channelInfo = await getChannelInfo(channelId);
    if (channelInfo) {
      context.viewing_channel_name = channelInfo.name;
      context.viewing_channel_is_private = channelInfo.is_private;
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

  // Look up if this channel is associated with a working group
  try {
    const workingGroup = await workingGroupDb.getWorkingGroupBySlackChannelId(channelId);
    if (workingGroup) {
      context.viewing_channel_working_group_slug = workingGroup.slug;
      context.viewing_channel_working_group_name = workingGroup.name;
      context.viewing_channel_working_group_id = workingGroup.id;
      logger.debug({ channelId, workingGroupSlug: workingGroup.slug }, 'Channel associated with working group');
    }
  } catch (error) {
    logger.debug({ error, channelId }, 'Could not look up working group for channel');
  }

  // Check if this channel is a system-configured channel (prospect, escalation, etc.)
  try {
    const systemRole = await getSystemChannelRole(channelId);
    if (systemRole) {
      context.viewing_channel_system_role = systemRole;
      logger.debug({ channelId, systemRole }, 'Channel is a system channel');
    }
  } catch (error) {
    logger.debug({ error, channelId }, 'Could not check system channel role');
  }

  return context;
}

let addieDb: AddieDatabase | null = null;
let addieRouter: AddieRouter | null = null;
let threadContextStore: DatabaseThreadContextStore | null = null;
let setSiContext: (memberContext: MemberContext | null, threadExternalId: string) => void = () => {};
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

  // Register shared baseline tools (knowledge, billing, schema, directory, brand, property)
  // Shared with web chat handler via register-baseline-tools.ts
  await registerBaselineTools(claudeClient);

  // Register Slack-specific tools below (these need Slack context)

  // Register URL fetching tools (for reading links and files shared in Slack)
  const urlHandlers = createUrlToolHandlers(botToken);
  for (const tool of URL_TOOLS) {
    const handler = urlHandlers[tool.name];
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register Google Docs tools (for reading Google Docs/Drive files)
  const googleDocsHandlers = createGoogleDocsToolHandlers();
  if (googleDocsHandlers) {
    for (const tool of GOOGLE_DOCS_TOOLS) {
      const handler = googleDocsHandlers[tool.name];
      if (handler) {
        claudeClient.registerTool(tool, handler);
      }
    }
    logger.info('Addie: Google Docs tools registered');
  }

  // Register SI host tools (Sponsored Intelligence protocol)
  // These enable Addy to connect users with AAO member brand agents
  // Note: We need to pass context providers that will be called per-request
  // For now, we register with placeholder getters - actual context comes from handleUserMessage
  let currentMemberContext: MemberContext | null = null;
  let currentThreadExternalId: string = '';

  const siHostHandlers = createSiHostToolHandlers(
    () => currentMemberContext,
    () => currentThreadExternalId
  );
  for (const tool of SI_HOST_TOOLS) {
    const handler = siHostHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }
  logger.info('Addie: SI host tools registered');

  // Export setters for SI context (called from handleUserMessage)
  setSiContext = (memberContext: MemberContext | null, threadExternalId: string) => {
    currentMemberContext = memberContext;
    currentThreadExternalId = threadExternalId;
  };

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
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isAssistantError = errorMessage.includes('Assistant') || errorMessage.includes('thread_ts');

    logger.error({
      error,
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      isAssistantError,
    }, 'Addie Bolt: Unhandled error');

    // If this is an Assistant-related error (likely missing thread_ts on first message),
    // the event may have been lost. Log additional context to help debug.
    if (isAssistantError) {
      logger.warn(
        { errorMessage },
        'Addie Bolt: Assistant error detected - first DM may have been lost. Check if thread_ts was missing.'
      );
    }
  });

  // Add middleware to handle DMs that might fail the Assistant check
  // This catches DMs without proper thread_ts before they reach the Assistant middleware
  // and routes them directly to handleDirectMessage.
  // Not calling next() stops the middleware chain, preventing downstream handlers from firing.
  boltApp.use(async ({ payload, next, context }) => {
    // Only intercept message events in IM channels
    if (payload.type === 'message' && 'channel_type' in payload && payload.channel_type === 'im') {
      const hasThreadTs = 'thread_ts' in payload && payload.thread_ts !== undefined;
      const hasTs = 'ts' in payload;
      const hasText = 'text' in payload && payload.text;
      const hasBotId = 'bot_id' in payload && payload.bot_id;
      const hasSubtype = 'subtype' in payload && payload.subtype;
      const userId = 'user' in payload ? payload.user : undefined;
      const channelId = 'channel' in payload ? payload.channel : undefined;

      logger.debug({
        channelId,
        userId,
        hasThreadTs,
        hasTs,
        hasText: !!hasText,
        hasBotId: !!hasBotId,
        hasSubtype: !!hasSubtype,
      }, 'Addie Bolt: DM message received in middleware');

      // If this is a DM without thread_ts (first message in new conversation),
      // the Assistant middleware will fail with AssistantMissingPropertyError.
      // Route directly to handleDirectMessage instead.
      if (!hasThreadTs && hasTs && hasText && !hasBotId && !hasSubtype && userId) {
        logger.info({
          channelId,
          userId,
          ts: payload.ts,
        }, 'Addie Bolt: Intercepting first DM (no thread_ts) - routing directly to handleDirectMessage');

        try {
          // Route directly to handleDirectMessage
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await handleDirectMessage(
            payload as any,
            { botUserId: context.botUserId }
          );
        } catch (error) {
          logger.error({ error, channelId, userId }, 'Addie Bolt: Error handling first DM in middleware');
          // The message was still processed (attempted), so don't retry via next()
        }

        // Don't call next() - we've handled this event
        return;
      }
    }

    // For all other events, continue normal processing
    await next();
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

  // Register prospect notification action handlers
  boltApp.action('prospect_claim', handleProspectClaim);
  boltApp.action('prospect_disqualify', handleProspectDisqualify);

  // Register alias match action handlers
  boltApp.action('alias_confirm', handleAliasConfirm);
  boltApp.action('alias_reject', handleAliasReject);

  // Register marketing opt-in action handlers (from Slack join DM)
  boltApp.action('marketing_optin_yes', handleMarketingOptIn);
  boltApp.action('marketing_optin_no', handleMarketingOptIn);

  // Register reaction handler for thumbs up/down confirmations
  boltApp.event('reaction_added', handleReactionAdded);

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
    const userIsAdmin = await isSlackUserAAOAdmin(userId);
    return buildDynamicSuggestedPrompts(memberContext, userIsAdmin);
  } catch (error) {
    logger.warn({ error, userId }, 'Addie Bolt: Failed to build dynamic prompts, using defaults');
    return SUGGESTED_PROMPTS;
  }
}

/**
 * Build per-request context for the system prompt (member info, channel, goals).
 * Returns context separately from the user message so short messages like "sure"
 * aren't buried under hundreds of tokens of metadata.
 */
async function buildRequestContext(
  userId: string,
  threadContext?: ThreadContext,
  existingMemberContext?: MemberContext | null
): Promise<{ requestContext: string; memberContext: MemberContext | null; hasCertificationContext: boolean }> {
  try {
    const memberContext = existingMemberContext !== undefined ? existingMemberContext : await getMemberContext(userId);
    const memberContextText = memberContext ? formatMemberContextForPrompt(memberContext) : null;

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
      // Include working group association if this channel belongs to one
      if (threadContext.viewing_channel_working_group_name && threadContext.viewing_channel_working_group_slug) {
        channelLines.push(`**Working Group:** ${threadContext.viewing_channel_working_group_name} (slug: "${threadContext.viewing_channel_working_group_slug}")`);
        channelLines.push(`When scheduling meetings for this channel, use working_group_slug="${threadContext.viewing_channel_working_group_slug}" by default.`);
      }
      // Public channels are visible to all workspace members — never share sensitive data there
      if (threadContext.viewing_channel_is_private === false) {
        channelLines.push('');
        channelLines.push('**IMPORTANT: This is a PUBLIC channel visible to all workspace members.**');
        channelLines.push('- You MUST NOT share financial data, member counts, invoice information, individual member details, pricing information, or any other sensitive organizational data in this channel, even if an admin asks. If asked for sensitive information, tell them to ask you in a private message instead.');
        channelLines.push('- You MUST NOT pitch membership, send join links, or recruit in public channels — membership conversations belong in DMs.');
        channelLines.push('- The user context above is for the message sender only. Do not use it to make assumptions about other people in the thread. Do not address other thread participants by their membership status.');
      }
      channelContextText = channelLines.join('\n');
    }

    // Add certification module state so Addie remembers active modules
    // even when conversation history is trimmed
    let certContextText = '';
    const workosUserId = memberContext?.workos_user?.workos_user_id;
    if (workosUserId) {
      try {
        const progress = await certDb.getProgress(workosUserId);
        const inProgress = progress.filter(p => p.status === 'in_progress');
        certContextText = await buildCertificationContext(inProgress, workosUserId) || '';
        // If no module is in progress, inject a strong reminder to call start_certification_module.
        // Without this, Addie can teach certification content in a guardrail-free zone where
        // demonstrations aren't tracked and no progress is recorded.
        if (inProgress.length === 0) {
          const noModuleWarning = [
            '⚠️ [CERTIFICATION — NO MODULE ACTIVE] ⚠️',
            'No certification module is currently in progress for this learner.',
            '',
            'MANDATORY: If the learner wants to learn about AdCP, start any module, or asks about agentic advertising in the context of certification:',
            '1. Call start_certification_module with the appropriate module_id IMMEDIATELY',
            '2. Do NOT teach, explain, demo, or discuss module content before calling it',
            '3. Do NOT say "the module is active" or "we are already in the module" — that is FALSE unless you have called start_certification_module in THIS conversation and received a success response',
            '4. Do NOT call get_products, list_creative_formats, get_signals, or any AdCP demo tool for teaching purposes before starting a module',
            '',
            'The ONLY pre-module conversation allowed is helping the learner choose WHICH module to start.',
            'Once they indicate any module (or say "start certification" / "start A1" / "I want to learn"), call the tool FIRST.',
          ].join('\n');
          certContextText = certContextText
            ? `${noModuleWarning}\n\n${certContextText}`
            : noModuleWarning;
        }
      } catch (error) {
        logger.warn({ error }, 'Addie Bolt: Failed to get certification progress for context');
      }
    }

    const sections = [memberContextText, channelContextText, certContextText].filter(Boolean);
    return {
      requestContext: sections.length > 0 ? sections.join('\n\n') : '',
      memberContext,
      hasCertificationContext: !!certContextText,
    };
  } catch (error) {
    logger.warn({ error, userId }, 'Addie Bolt: Failed to get member context, continuing without it');
    return { requestContext: '', memberContext: null, hasCertificationContext: false };
  }
}

/**
 * Create user-scoped tools based on member context and permissions
 * Admin users also get access to admin tools
 * Event creators (admin or committee leads) get access to event tools
 * Meeting schedulers (admin or committee leaders) get access to meeting tools
 */
async function createUserScopedTools(
  memberContext: MemberContext | null,
  slackUserId?: string,
  threadId?: string,
  threadContext?: ThreadContext | null
): Promise<UserScopedToolsResult> {
  const memberHandlers = createMemberToolHandlers(memberContext, slackUserId);
  let allTools = [...MEMBER_TOOLS];
  const allHandlers = new Map(memberHandlers);

  // Re-register Google Docs tools with user context for per-user rate
  // limiting (see tool-rate-limiter.ts). The boot-time registration
  // remains as a fallback; this per-request copy shadows whenever
  // we have a user id (requestTools beats this.toolHandlers in the
  // claude-client merge at line 531).
  const userIdForRateLimit = memberContext?.workos_user?.workos_user_id ?? null;
  const scopedGoogleDocsHandlers = createGoogleDocsToolHandlers(userIdForRateLimit);
  if (scopedGoogleDocsHandlers) {
    for (const tool of GOOGLE_DOCS_TOOLS) {
      const handler = scopedGoogleDocsHandlers[tool.name];
      if (handler) allHandlers.set(tool.name, handler);
    }
  }

  // Register illustration tools (#2783). Self-gated on author
  // permission + monthly quota + the 10/10min tool-rate-limit
  // added in #2755.
  const illustrationHandlers = createIllustrationToolHandlers(memberContext);
  allTools.push(...ILLUSTRATION_TOOLS);
  for (const [name, handler] of illustrationHandlers) {
    allHandlers.set(name, handler);
  }

  // Add billing tools for all users (membership signup assistance)
  // Skip in public channels — billing tools enable enrollment pitching
  const isPublicChannel = threadContext?.viewing_channel_is_private === false;
  if (!isPublicChannel) {
    const billingHandlers = createBillingToolHandlers(memberContext);
    allTools.push(...BILLING_TOOLS);
    for (const [name, handler] of billingHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie Bolt: Billing tools enabled');
  } else {
    logger.debug('Addie Bolt: Billing tools skipped (public channel)');
  }

  // Add escalation tools for all users
  const escalationHandlers = createEscalationToolHandlers(memberContext, slackUserId, threadId);
  allTools.push(...ESCALATION_TOOLS);
  for (const [name, handler] of escalationHandlers) {
    allHandlers.set(name, handler);
  }
  logger.debug('Addie Bolt: Escalation tools enabled');

  // Add newsletter suggestion tools for all users
  const newsletterHandlers = createNewsletterToolHandlers(memberContext, slackUserId);
  allTools.push(...NEWSLETTER_TOOLS);
  for (const [name, handler] of newsletterHandlers) {
    allHandlers.set(name, handler);
  }
  logger.debug('Addie Bolt: Newsletter suggestion tools enabled');

  // Add AdCP protocol tools (standard MCP tools for interacting with agents)
  const adcpHandlers = createAdcpToolHandlers(memberContext);
  allTools.push(...ADCP_TOOLS);
  for (const [name, handler] of adcpHandlers) {
    allHandlers.set(name, handler);
  }
  logger.debug('Addie Bolt: AdCP protocol tools enabled');

  // Check if user is AAO admin (based on aao-admin working group membership)
  const userIsAdmin = slackUserId ? await isSlackUserAAOAdmin(slackUserId) : false;

  // Add admin tools if user is admin
  if (userIsAdmin) {
    const adminHandlers = createAdminToolHandlers(memberContext);
    allTools.push(...ADMIN_TOOLS);
    for (const [name, handler] of adminHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug({ slackUserId }, 'Addie Bolt: Admin tools enabled for this user');
  } else if (slackUserId) {
    logger.debug({ slackUserId }, 'Addie Bolt: User is NOT an admin — admin tools withheld');
  }

  // Event tools: readonly for all users, admin tools gated behind canCreateEvents
  const eventHandlers = createEventToolHandlers(memberContext, slackUserId);
  allTools.push(...EVENT_READONLY_TOOLS);
  for (const tool of EVENT_READONLY_TOOLS) {
    const handler = eventHandlers.get(tool.name);
    if (handler) allHandlers.set(tool.name, handler);
  }
  logger.debug('Addie Bolt: Event read-only tools enabled');

  const canCreate = slackUserId ? await canCreateEvents(slackUserId) : userIsAdmin;
  if (canCreate) {
    allTools.push(...EVENT_ADMIN_TOOLS);
    for (const tool of EVENT_ADMIN_TOOLS) {
      const handler = eventHandlers.get(tool.name);
      if (handler) allHandlers.set(tool.name, handler);
    }
    logger.debug('Addie Bolt: Event admin tools enabled for this user');
  }

  // Add meeting tools if user can schedule meetings (admin or committee leader)
  const canSchedule = slackUserId ? await canScheduleMeetings(slackUserId) : userIsAdmin;
  if (canSchedule) {
    // Pass thread context to meeting tools so they can auto-detect working group from channel
    const meetingHandlers = createMeetingToolHandlers(memberContext, slackUserId, threadContext);
    allTools.push(...MEETING_TOOLS);
    for (const [name, handler] of meetingHandlers) {
      allHandlers.set(name, handler);
    }
    logger.debug('Addie Bolt: Meeting tools enabled for this user');
  }


  // Add brand tools (brand research and registry management)
  const brandHandlers = createBrandToolHandlers();
  allTools.push(...BRAND_TOOLS);
  for (const [name, handler] of brandHandlers) {
    allHandlers.set(name, handler);
  }

  // Add collaboration tools (DMs between members)
  const collaborationHandlers = createCollaborationToolHandlers(memberContext, slackUserId, threadId);
  allTools.push(...COLLABORATION_TOOLS);
  for (const [name, handler] of collaborationHandlers) {
    allHandlers.set(name, handler);
  }

  // Add social drafting tools (help members write social posts about industry articles)
  if (memberContext?.is_member) {
    const socialDraftHandlers = createSocialDraftToolHandlers(memberContext);
    allTools.push(...SOCIAL_DRAFT_TOOLS);
    for (const [name, handler] of socialDraftHandlers) {
      allHandlers.set(name, handler);
    }
  }

  // Add committee leader tools (co-leader management, self-enforcing permissions)
  const committeeLeaderHandlers = createCommitteeLeaderToolHandlers(memberContext, slackUserId);
  allTools.push(...COMMITTEE_LEADER_TOOLS);
  for (const [name, handler] of committeeLeaderHandlers) {
    allHandlers.set(name, handler);
  }

  // Add property tools (adagents.json validation, publisher resolution)
  const propertyHandlers = createPropertyToolHandlers();
  allTools.push(...PROPERTY_TOOLS);
  for (const [name, handler] of propertyHandlers) {
    allHandlers.set(name, handler);
  }

  // Add schema tools (JSON schema validation and lookup)
  const schemaHandlers = createSchemaToolHandlers();
  allTools.push(...SCHEMA_TOOLS);
  for (const [name, handler] of schemaHandlers) {
    allHandlers.set(name, handler);
  }

  // Add certification tools (learning modules, exams, progress tracking)
  const certificationHandlers = createCertificationToolHandlers(memberContext, { threadId });
  allTools.push(...CERTIFICATION_TOOLS);
  for (const [name, handler] of certificationHandlers) {
    allHandlers.set(name, handler);
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

  // Remove enrollment tools in public channels (covers all handler paths,
  // not just the ones that go through filterToolsBySet)
  if (isPublicChannel) {
    const enrollmentToolNames = new Set(['get_account_link']);
    allTools = allTools.filter(t => !enrollmentToolNames.has(t.name));
    enrollmentToolNames.forEach(name => allHandlers.delete(name));
    logger.debug('Addie Bolt: Enrollment tools removed (public channel)');
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
 * Filter tools to only include those in the selected tool sets.
 * This reduces the context sent to Sonnet based on Haiku's routing decision.
 *
 * @param userTools - All tools available to the user
 * @param selectedSets - Tool set names from the router's execution plan
 * @param isAAOAdmin - Whether the user is an AAO admin (affects which sets are valid)
 * @returns Filtered tools and a hint about unavailable sets
 */
function filterToolsBySet(
  userTools: RequestTools,
  selectedSets: string[],
  isAAOAdmin: boolean,
  isPublicChannel: boolean = false
): { filteredTools: RequestTools; unavailableHint: string } {
  // Get all tool names that should be available based on selected sets
  const allowedToolNames = new Set(getToolsForSets(selectedSets, isAAOAdmin, isPublicChannel));

  // Filter tools to only those allowed
  const filteredToolDefs = userTools.tools.filter(tool => allowedToolNames.has(tool.name));

  // Filter handlers to match
  const filteredHandlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();
  for (const [name, handler] of userTools.handlers) {
    if (allowedToolNames.has(name)) {
      filteredHandlers.set(name, handler);
    }
  }

  // Build hint about unavailable tool sets
  const unavailableHint = buildUnavailableSetsHint(selectedSets, isAAOAdmin);

  logger.debug({
    selectedSets,
    allowedCount: filteredToolDefs.length,
    totalCount: userTools.tools.length,
    filteredToolNames: filteredToolDefs.map(t => t.name),
  }, 'Addie Bolt: Filtered tools by set');

  return {
    filteredTools: {
      tools: filteredToolDefs,
      handlers: filteredHandlers,
    },
    unavailableHint,
  };
}

async function selectRoutedToolsForSlackResponse(
  messageText: string,
  source: 'dm' | 'mention' | 'channel',
  memberContext: MemberContext | null,
  slackUserId: string,
  threadId: string,
  threadContext?: ThreadContext | null,
  options?: { isThread?: boolean; hasCertificationContext?: boolean; threadMessages?: string[] }
): Promise<{
  tools: RequestTools;
  isAAOAdmin: boolean;
  unavailableHint: string;
  requiresPrecision: boolean;
  requiresDepth: boolean;
  confidence: ConfidenceTier;
}> {
  const { tools: userTools, isAAOAdmin: userIsAdmin } = await createUserScopedTools(
    memberContext,
    slackUserId,
    threadId,
    threadContext
  );

  if (!addieRouter) {
    logger.warn('Addie Bolt: Router unavailable, defaulting to knowledge tool set');
    const fallbackSets = ['knowledge'];
    if (userIsAdmin && (source === 'dm' || threadContext?.viewing_channel_working_group_slug === ADMIN_CHANNEL_WG_SLUG)) {
      fallbackSets.push('admin');
    }
    const fallbackSystemRole = threadContext?.viewing_channel_system_role as SystemChannelRole | undefined;
    if (userIsAdmin && fallbackSystemRole) {
      for (const set of SYSTEM_CHANNEL_TOOL_SETS[fallbackSystemRole] ?? []) {
        if (!fallbackSets.includes(set)) {
          fallbackSets.push(set);
        }
      }
    }
    const { filteredTools, unavailableHint } = filterToolsBySet(
      userTools,
      fallbackSets,
      userIsAdmin,
      false
    );
    return {
      tools: filteredTools,
      isAAOAdmin: userIsAdmin,
      unavailableHint,
      requiresPrecision: false,
      requiresDepth: false,
      confidence: 'high',
    };
  }

  const routingContext: RoutingContext = {
    message: messageText,
    source,
    memberContext,
    isThread: options?.isThread,
    isAAOAdmin: userIsAdmin,
    channelName: threadContext?.viewing_channel_name,
    threadMessages: options?.threadMessages,
  };

  const plan = addieRouter.quickMatch(routingContext) ?? await addieRouter.route(routingContext);
  // Direct interactions (DMs, mentions, assistant threads) always respond.
  // Non-respond router actions only make sense for channel messages where Addie can stay silent.
  const isDirectInteraction = source === 'dm' || source === 'mention';
  const selectedSets = plan.action === 'respond'
    ? [...plan.tool_sets]
    : isDirectInteraction ? ['knowledge'] : [];

  // Certification sessions use certification + knowledge tools so Addie can verify protocol claims
  if (options?.hasCertificationContext) {
    selectedSets.length = 0;
    selectedSets.push('certification');
    selectedSets.push('knowledge');
  }

  // Admin DMs and admin channels: always include admin tools.
  // Admins DMing Addie are almost always asking operational questions; relying on
  // the Haiku router to guess "admin" from the message is fragile.
  const isAdminDm = userIsAdmin && source === 'dm';
  const isAdminChannel = userIsAdmin && threadContext?.viewing_channel_working_group_slug === ADMIN_CHANNEL_WG_SLUG;
  if ((isAdminDm || isAdminChannel) && !options?.hasCertificationContext && !selectedSets.includes('admin')) {
    selectedSets.push('admin');
  }

  // System-configured channels: auto-include relevant tool sets for admins
  const systemRole = threadContext?.viewing_channel_system_role as SystemChannelRole | undefined;
  if (userIsAdmin && systemRole && !options?.hasCertificationContext) {
    for (const set of SYSTEM_CHANNEL_TOOL_SETS[systemRole] ?? []) {
      if (!selectedSets.includes(set)) {
        selectedSets.push(set);
      }
    }
  }

  const { filteredTools, unavailableHint } = filterToolsBySet(
    userTools,
    selectedSets,
    userIsAdmin,
    threadContext?.viewing_channel_is_private === false
  );

  logger.debug(
    {
      source,
      action: plan.action,
      reason: plan.reason,
      selectedSets,
      hasCertificationContext: !!options?.hasCertificationContext,
      filteredToolCount: filteredTools.tools.length,
      totalToolCount: userTools.tools.length,
      requiresPrecision: plan.action === 'respond' ? !!plan.requires_precision : false,
      requiresDepth: plan.action === 'respond' ? !!plan.requires_depth : false,
    },
    'Addie Bolt: Routed conversational tools'
  );

  // Extract confidence: respond actions carry it, others default to high
  const confidence: ConfidenceTier = plan.action === 'respond'
    ? plan.confidence
    : 'high';

  return {
    tools: filteredTools,
    isAAOAdmin: userIsAdmin,
    unavailableHint,
    requiresPrecision: plan.action === 'respond' ? !!plan.requires_precision : false,
    requiresDepth: plan.action === 'respond' ? !!plan.requires_depth : false,
    confidence,
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
  // Log entry into Assistant's userMessage handler for debugging
  logger.debug({
    channelId: 'channel' in event ? event.channel : undefined,
    userId: 'user' in event ? event.user : undefined,
    threadTs: 'thread_ts' in event ? event.thread_ts : undefined,
    ts: 'ts' in event ? event.ts : undefined,
    hasText: 'text' in event && !!event.text,
    channelType: 'channel_type' in event ? event.channel_type : undefined,
  }, 'Addie Bolt: handleUserMessage called (Assistant handler)');

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
    logger.debug({ userId, hasText: !!messageText }, 'Addie Bolt: Ignoring message event without user or text');
    return;
  }

  // Skip Slackbot system messages (e.g., "added you to #channel")
  if (userId === SLACKBOT_USER_ID) {
    logger.debug({ messageText: messageText?.substring(0, 50) }, 'Addie Bolt: Ignoring Slackbot system message');
    return;
  }

  // Skip DMs without thread_ts - these are handled by handleDirectMessage via middleware.
  // The Assistant framework receives message.im events through a separate pipeline from
  // the global middleware chain, so both handlers can fire for the same event.
  // First DMs (without thread_ts) are handled by handleDirectMessage; skip them here.
  const channelType = 'channel_type' in event ? event.channel_type : undefined;
  const hasRealThreadTs = 'thread_ts' in event && event.thread_ts !== undefined;
  if (channelType === 'im' && !hasRealThreadTs) {
    logger.debug({ channelType, hasThreadTs: hasRealThreadTs }, 'Addie Bolt: Skipping DM without thread_ts in Assistant handler (handled by middleware)');
    return;
  }

  const startTime = Date.now();
  const channelId = event.channel;
  const threadService = getThreadService();

  // Use permanent thread from person_relationships when available so the
  // addie_threads record stays unified across all DMs with this person.
  let resolvedThreadTs = threadTs;
  if (channelType === 'im') {
    try {
      const rel = await relationshipDb.getRelationshipBySlackId(userId);
      if (rel?.slack_dm_channel_id === channelId && rel.slack_dm_thread_ts) {
        resolvedThreadTs = rel.slack_dm_thread_ts;
      }
    } catch (error) {
      logger.debug({ error, userId }, 'Addie Bolt: Could not look up permanent thread in assistant handler');
    }
  }

  const externalId = `${channelId}:${resolvedThreadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(messageText || '');

  // Record inbound message in the relationship system (resets unreplied count, derives sentiment)
  recordPersonInboundMessage(userId, 'slack', 'assistant_thread', (messageText || '').length);

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
  const MAX_HISTORY_MESSAGES = 20;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  let historyUnavailable = false;
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
          toolCalls: msg.tool_calls ?? undefined,
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
    historyUnavailable = true;
  }

  // Build per-request context for system prompt
  let { requestContext, memberContext: updatedMemberContext, hasCertificationContext } = await buildRequestContext(
    userId,
    slackThreadContext
  );
  // Use the updated memberContext if we didn't have one before
  if (!memberContext && updatedMemberContext) {
    memberContext = updatedMemberContext;
  }
  if (historyUnavailable) {
    requestContext += `\n\n${HISTORY_UNAVAILABLE_NOTE}`;
  }

  // Set SI context for SI host tools (allows them to access member context and thread ID)
  setSiContext(memberContext, externalId);

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: messageText || '',
      content_sanitized: inputValidation.sanitized,
      flagged: userMessageFlagged,
      flag_reason: inputValidation.reason || undefined,
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save user message');
  }

  const routedTools = await selectRoutedToolsForSlackResponse(
    inputValidation.sanitized,
    'dm',
    memberContext,
    userId,
    thread.thread_id,
    slackThreadContext,
    { isThread: true, hasCertificationContext }
  );
  const requestContextWithRouting = [requestContext, routedTools.unavailableHint, buildConfidenceCalibration(routedTools.confidence)]
    .filter(Boolean)
    .join('\n\n');

  // Admin users get higher iteration limit; certification sessions get more iterations
  const certIterations = hasCertificationContext && !routedTools.isAAOAdmin
    ? CERTIFICATION_MAX_ITERATIONS
    : undefined;
  // Resolve the cost-cap identity. Prefer the mapped WorkOS user ID
  // (consistent with tool-rate-limiter's scope keys); fall back to a
  // `slack:${userId}` namespace when no mapping exists so the cap
  // still bounds an individual Slack user's Addie spend (#2790).
  const costScopeUserId = memberContext?.workos_user?.workos_user_id ?? `slack:${userId}`;
  const processOptions: import('./claude-client.js').ProcessMessageOptions = {
    requestContext: requestContextWithRouting,
    ...(routedTools.isAAOAdmin && { maxIterations: ADMIN_MAX_ITERATIONS }),
    ...(certIterations && { maxIterations: certIterations }),
    ...((routedTools.requiresPrecision || routedTools.requiresDepth) && { modelOverride: ModelConfig.precision }),
    slackUserId: userId,
    threadId: thread.thread_id,
    // Conservative tier resolution: member_free for all authenticated
    // Slack users. Upgrading to member_paid for real subscribers is
    // filed as a follow-up — the active-subscription lookup isn't
    // already threaded here. AAO admins should never hit the cap in
    // legitimate use; if they do, the follow-up covers elevating them.
    costScope: { userId: costScopeUserId, tier: 'member_free' },
  };

  // Process with Claude using streaming
  let response;
  let fullText = '';
  const toolsUsed: string[] = [];
  const toolExecutions: { tool_name: string; parameters: Record<string, unknown>; result: string }[] = [];

  try {
    // Get team ID from context for streaming
    const teamId = context.teamId || slackThreadContext.team_id;

    // Check if streaming is available (requires teamId and userId)
    const canStream = teamId && userId && threadTs;

    if (canStream) {
      // Use streaming for real-time response
      logger.debug('Addie Bolt: Using streaming response');

      // Initialize the stream in the assistant thread
      const streamer = client.chatStream({
        channel: channelId,
        thread_ts: threadTs,
        recipient_team_id: teamId,
        recipient_user_id: userId,
      });

      // Process Claude response stream (pass conversation history for context)
      // Track tool invocations for unique task_update IDs (same tool can run multiple times)
      let toolInvocationCount = 0;
      const activeToolTaskIds: string[] = [];

      for await (const event of claudeClient.processMessageStream(inputValidation.sanitized, conversationHistory, routedTools.tools, processOptions)) {
        if (event.type === 'text') {
          fullText += event.text;
          // Append text chunk to Slack stream
          // Note: don't apply wrapUrlsForSlack() per-chunk — URLs can span chunk
          // boundaries. Slack auto-links bare https:// URLs in streamed messages.
          try {
            await streamer.append({ markdown_text: event.text });
          } catch (streamError) {
            logger.warn({ streamError }, 'Addie Bolt: Stream append failed for chunk, continuing');
          }
        } else if (event.type === 'tool_start') {
          toolsUsed.push(event.tool_name);
          toolInvocationCount++;
          const taskId = `${event.tool_name}_${toolInvocationCount}`;
          activeToolTaskIds.push(taskId);
          // Show tool execution as an in-progress task in the streamed message
          try {
            // chunks is a Slack streaming API feature not yet in the SDK types
            await streamer.append({
              chunks: [{
                type: 'task_update',
                id: taskId,
                title: event.tool_name.replace(/_/g, ' '),
                status: 'in_progress',
              }],
            } as unknown as Parameters<typeof streamer.append>[0]);
          } catch {
            // Ignore stream errors for status updates
          }
        } else if (event.type === 'tool_end') {
          toolExecutions.push({
            tool_name: event.tool_name,
            parameters: {},
            result: event.result,
          });
          // Mark tool execution as complete in the streamed message
          const taskId = activeToolTaskIds.pop() || event.tool_name;
          try {
            // chunks is a Slack streaming API feature not yet in the SDK types
            await streamer.append({
              chunks: [{
                type: 'task_update',
                id: taskId,
                title: event.tool_name.replace(/_/g, ' '),
                status: event.is_error ? 'error' : 'complete',
              }],
            } as unknown as Parameters<typeof streamer.append>[0]);
          } catch {
            // Ignore stream errors for status updates
          }
        } else if (event.type === 'retry') {
          // Show retry status to user
          try {
            await setStatus(`${event.reason}, retrying (${event.attempt}/${event.maxRetries})...`);
          } catch {
            // Ignore status update errors
          }
        } else if (event.type === 'done') {
          response = event.response;
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }

      // Stop the stream with feedback buttons and any inline images.
      try {
        // Extract image URLs from streamed text for Slack Block Kit image blocks
        const { images: streamImages } = extractMarkdownImages(fullText);
        const MAX_SLACK_IMAGES = 3;
        const imageBlocks = streamImages.slice(0, MAX_SLACK_IMAGES).map(img => ({
          type: 'image' as const,
          image_url: img.url,
          alt_text: img.alt,
        }));
        // Don't pass markdown_text — the SDK buffer already has all text from
        // append() calls. Passing it again would duplicate the message.
        await streamer.stop({
          blocks: [
            ...imageBlocks,
            buildFeedbackBlock(),
          ],
        });
      } catch (stopError) {
        logger.warn({ stopError }, 'Addie Bolt: Stream stop failed, falling back to say()');
        // Fallback: send via say() so the user isn't left without a response
        try {
          const guarded = guardBareJsonEnvelope(fullText, { pathTag: 'dm-streaming-fallback' });
          const fallbackValidation = validateOutput(guarded.text);
          const { text: fallbackText, images: fallbackImages } = extractMarkdownImages(fallbackValidation.sanitized);
          const slackText = wrapUrlsForSlack(fallbackText);
          // Slack rejects section blocks with empty mrkdwn text. If streaming
          // produced nothing (e.g. upstream overload before any deltas), fall
          // back to a plain apology so the user isn't left silent.
          if (!slackText.trim()) {
            const apology = isRetriesExhaustedError(stopError)
              ? `${stopError.reason}. Please try again in a moment.`
              : "I'm sorry, I encountered an error. Please try again.";
            await say(apology);
          } else {
            await say({
              text: slackText,
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: slackText } },
                ...fallbackImages.slice(0, 3).map(img => ({
                  type: 'image' as const,
                  image_url: img.url,
                  alt_text: img.alt,
                })),
                buildFeedbackBlock(),
              ],
            });
          }
        } catch (sayError) {
          const rootCause = isRetriesExhaustedError(stopError) ? 'retries-exhausted' : 'other';
          const logLevel = rootCause === 'retries-exhausted' ? 'warn' : 'error';
          logger[logLevel]({ sayError, stopError, rootCause }, 'Addie Bolt: Fallback say() also failed');
        }
      }
    } else {
      // Fall back to non-streaming for compatibility
      logger.debug('Addie Bolt: Using non-streaming response (streaming not available)');
      response = await claudeClient.processMessage(inputValidation.sanitized, conversationHistory, routedTools.tools, undefined, processOptions);
      fullText = response.text;

      // Send response via say() with feedback buttons and inline images
      const guarded = guardBareJsonEnvelope(response.text, { pathTag: 'dm-non-streaming' });
      const outputValidation = validateOutput(guarded.text);
      const { text: textWithoutImages, images } = extractMarkdownImages(outputValidation.sanitized);
      const slackText = wrapUrlsForSlack(textWithoutImages);
      try {
        // Slack rejects section blocks with empty mrkdwn text. If the model
        // returned nothing (or everything was sanitized/extracted), fall back
        // to a plain apology instead of a malformed blocks payload.
        if (!slackText.trim()) {
          await say("I'm sorry, I encountered an error. Please try again.");
        } else {
          await say({
            text: slackText,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: slackText,
                },
              },
              ...images.slice(0, 3).map(img => ({
                type: 'image' as const,
                image_url: img.url,
                alt_text: img.alt,
              })),
              buildFeedbackBlock(),
            ],
          });
        }
      } catch (error) {
        logger.error({ error }, 'Addie Bolt: Failed to send response');
      }
    }
  } catch (error) {
    // Provide user-friendly error message based on error type
    let errorMessage: string;
    if (error instanceof Error && error.message.includes('prompt is too long')) {
      logger.warn({ error }, 'Addie Bolt: Conversation exceeded context limit');
      errorMessage = "This conversation is too long for me to process. Please start a new chat and I'll be happy to help!";
    } else {
      logger.error({ error }, 'Addie Bolt: Error processing message');
      errorMessage = isRetriesExhaustedError(error)
        ? `${error.reason}. Please try again in a moment.`
        : "I'm sorry, I encountered an error. Please try again.";
    }

    response = {
      text: errorMessage,
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

  // Build final response object if we used streaming but didn't receive a 'done' event
  // This shouldn't happen normally, but provides a fallback with logging
  if (!response) {
    logger.warn({ fullTextLength: fullText.length, toolsUsedCount: toolsUsed.length },
      'Addie Bolt: Streaming completed without done event - using fallback response');
    response = {
      text: fullText,
      tools_used: toolsUsed,
      tool_executions: toolExecutions.map((t, i) => ({
        ...t,
        is_error: false,
        duration_ms: 0,
        sequence: i + 1,
      })),
      flagged: true,
      flag_reason: 'Streaming completed without done event',
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
    try {
      await threadService.updateThreadTitle(thread.thread_id, title);
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to update thread title');
    }
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');
  const dmEffectiveModel = (routedTools.requiresPrecision || routedTools.requiresDepth) ? ModelConfig.precision : AddieModelConfig.chat;

  try {
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
      model: dmEffectiveModel,
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
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save assistant message');
  }

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    try {
      await threadService.flagThread(
        thread.thread_id,
        [inputValidation.reason, flagReason].filter(Boolean).join('; ')
      );
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to flag thread');
    }
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

  // Fetch surrounding conversation context for the mention.
  // For threaded mentions: fetch thread replies.
  // For top-level mentions: fetch recent channel messages so Addie understands
  // the conversation she's being mentioned in.
  const MAX_CONTEXT_MESSAGES = 25;
  let threadContext = '';
  let mentionRawMessages: Array<{ user?: string; text?: string; ts: string }> = [];
  try {
    let rawMessages: Array<{ user?: string; text?: string; ts: string }> = [];
    let contextLabel = '';

    if (isInThread && event.thread_ts) {
      const threadMessages = await getThreadReplies(channelId, event.thread_ts);
      rawMessages = threadMessages;
      contextLabel = 'Thread';
    } else {
      // Fetch recent channel messages before this mention.
      // conversations.history returns newest-first; reverse to chronological order.
      const { messages: channelMessages } = await getChannelHistory(channelId, {
        latest: event.ts,
        limit: MAX_CONTEXT_MESSAGES + 1, // +1 because the current message may be included
      });
      rawMessages = channelMessages.reverse();
      contextLabel = 'Conversation';
    }

    mentionRawMessages = rawMessages;

    if (rawMessages.length > 0) {
      const filteredMessages = rawMessages
        .filter(msg => msg.ts !== event.ts) // Exclude the current mention message
        .filter(msg => (msg.text || '').trim().length > 0)
        .slice(-MAX_CONTEXT_MESSAGES);

      // Collect all unique user IDs (senders and @mentions)
      const mentionedUserIds = new Set<string>();
      for (const msg of filteredMessages) {
        if (msg.user && msg.user !== context.botUserId) {
          mentionedUserIds.add(msg.user);
        }
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

      // Format messages with speaker identification
      const contextMessages = filteredMessages.map(msg => {
        let text = msg.text || '';
        const isAddie = msg.user === context.botUserId;
        const speaker = isAddie ? 'Addie' : (userNameMap.get(msg.user || '') || 'User');
        if (context.botUserId) {
          text = text.replace(new RegExp(`<@${context.botUserId}>\\s*`, 'gi'), '').trim();
        }
        text = text.replace(/<@(U[A-Z0-9]+)>/gi, (_match, uid) => {
          const name = userNameMap.get(uid);
          return name ? `@${name}` : '[someone]';
        });
        return `- ${speaker}: ${text}`;
      });

      if (contextMessages.length > 0) {
        const header = isInThread
          ? 'The user is replying in a Slack thread. Here are the previous messages in this thread for context:'
          : 'The user mentioned you in a conversation. Here are the recent messages leading up to the mention:';
        threadContext = `\n\n## ${contextLabel} Context\n${header}\n${contextMessages.join('\n')}\n\n---\n`;

        // Calibrate response length to match the thread's conversational register
        const styleHint = buildThreadStyleHint(rawMessages, context.botUserId || '');
        if (styleHint) {
          threadContext += `\n${styleHint}\n`;
        }

        logger.debug({ messageCount: contextMessages.length, resolvedUsers: userNameMap.size }, `Addie Bolt: Fetched ${contextLabel.toLowerCase()} context for mention`);
      }
    }
  } catch (error) {
    logger.warn({ error, channelId, threadTs: event.thread_ts }, 'Addie Bolt: Failed to fetch conversation context');
  }

  // Fetch member context early so we can store display name on the thread
  let mentionMemberContext: MemberContext | null = null;
  try {
    mentionMemberContext = await getMemberContext(userId);
  } catch (error) {
    logger.debug({ error, userId }, 'Addie Bolt: Could not get member context for mention');
  }

  // Get or create unified thread for this mention
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    user_display_name: mentionMemberContext?.slack_user?.display_name || undefined,
    context: {
      mention_channel_id: channelId,
      channel_name: mentionChannelContext.viewing_channel_name,
      mention_type: 'app_mention',
    },
  });

  // Fetch conversation history from database for context
  // This ensures Claude remembers what Addie said in previous turns
  const MAX_HISTORY_MESSAGES = 20;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  let historyUnavailable = false;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
          toolCalls: msg.tool_calls ?? undefined,
        }));

      if (conversationHistory.length > 0) {
        logger.debug(
          { threadId: thread.thread_id, messageCount: conversationHistory.length },
          'Addie Bolt: Loaded conversation history for mention'
        );
      }
    }
  } catch (error) {
    logger.warn({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to fetch mention conversation history');
    historyUnavailable = true;
  }

  // Build per-request context (member info, channel, goals) for system prompt
  // Pass pre-fetched member context to avoid a duplicate DB call
  const { requestContext: memberRequestContext, memberContext } = await buildRequestContext(
    userId,
    mentionChannelContext,
    mentionMemberContext
  );

  // Include Slack thread context in requestContext (reference info, not user speech)
  let requestContext = threadContext
    ? `${memberRequestContext}\n\n${threadContext}`
    : memberRequestContext;
  if (historyUnavailable) {
    requestContext += `\n\n${HISTORY_UNAVAILABLE_NOTE}`;
  }

  // Log user message to unified thread (use original input, not synthetic instruction)
  const userMessageFlagged = inputValidation.flagged;
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: originalUserInput,
      content_sanitized: isEmptyMention ? '' : inputValidation.sanitized,
      flagged: userMessageFlagged,
      flag_reason: inputValidation.reason || undefined,
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save user message');
  }

  const mentionThreadSummary = isInThread && mentionRawMessages.length > 0
    ? buildThreadSummaryForRouter(mentionRawMessages, context.botUserId || '', event.ts, userId)
    : undefined;

  const routedTools = await selectRoutedToolsForSlackResponse(
    inputValidation.sanitized,
    'mention',
    memberContext,
    userId,
    thread.thread_id,
    mentionChannelContext,
    { isThread: isInThread, threadMessages: mentionThreadSummary }
  );

  requestContext = [requestContext, routedTools.unavailableHint, buildConfidenceCalibration(routedTools.confidence)]
    .filter(Boolean)
    .join('\n\n');

  // Use Opus for protocol-depth channels (wg-*, council-*) or router-flagged depth
  const mentionIsDepthChannel = isDepthChannel(mentionChannelContext?.viewing_channel_name);
  const mentionUseOpus = routedTools.requiresPrecision || routedTools.requiresDepth || mentionIsDepthChannel;

  // Admin users get higher iteration limit for bulk operations
  const processOptions = {
    ...(routedTools.isAAOAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : {}),
    ...(mentionUseOpus ? { modelOverride: ModelConfig.precision } : {}),
    requestContext,
    slackUserId: userId,
    threadId: thread.thread_id,
  };

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(inputValidation.sanitized, conversationHistory, routedTools.tools, undefined, processOptions);
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
  const mentionGuarded = guardBareJsonEnvelope(response.text, { pathTag: 'app-mention' });
  const outputValidation = validateOutput(mentionGuarded.text);

  // Send response in thread (must explicitly pass thread_ts for app_mention events)
  try {
    await say({
      text: wrapUrlsForSlack(outputValidation.sanitized),
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send mention response');
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');
  const mentionEffectiveModel = mentionUseOpus ? ModelConfig.precision : AddieModelConfig.chat;

  try {
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
      model: mentionEffectiveModel,
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
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save assistant message');
  }

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    try {
      await threadService.flagThread(
        thread.thread_id,
        [inputValidation.reason, flagReason].filter(Boolean).join('; ')
      );
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to flag thread');
    }
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
      try {
        await threadService.addMessageFeedback(latestAssistant.message_id, {
          rating: isPositive ? 5 : 1,
          rating_category: isPositive ? 'helpful' : 'not_helpful',
          rated_by: userId,
          rating_source: 'user',
        });
      } catch (error) {
        logger.error({ error, messageId: latestAssistant.message_id }, 'Addie Bolt: Failed to save feedback');
      }

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
 * Handle "Claim this prospect" button from prospect notification
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleProspectClaim({ ack, body, client }: any): Promise<void> {
  await ack();

  const orgId = body.actions?.[0]?.value;
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!orgId || !userId || !channelId) {
    logger.warn({ orgId, userId, channelId }, 'Addie Bolt: Prospect claim missing required fields');
    return;
  }

  if (!/^[UW][A-Z0-9]+$/.test(userId)) {
    logger.warn({ userId }, 'Addie Bolt: Invalid Slack user ID format in prospect claim');
    return;
  }

  try {
    const pool = getPool();

    // Look up the Slack user's WorkOS identity and verify they're an admin
    const userResult = await pool.query<{ workos_user_id: string; first_name: string; email: string; is_admin: boolean }>(
      `SELECT u.workos_user_id, u.first_name, u.email,
              EXISTS(
                SELECT 1 FROM org_memberships om
                WHERE om.workos_user_id = u.workos_user_id
                  AND om.workos_organization_id = (
                    SELECT workos_organization_id FROM organizations WHERE slug = 'agenticadvertising-org' LIMIT 1
                  )
                  AND om.role IN ('admin')
              ) as is_admin
       FROM users u WHERE u.slack_user_id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: 'You need to link your Slack account first. Visit the admin portal to connect your account.',
      });
      return;
    }

    const user = userResult.rows[0];

    // Verify the org is still an active prospect
    const orgCheck = await pool.query<{ name: string; subscription_status: string | null; prospect_owner: string | null }>(
      `SELECT name, subscription_status, prospect_owner FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );

    if (!orgCheck.rows[0]) {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'Organization not found.' });
      return;
    }

    if (orgCheck.rows[0].subscription_status) {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'This organization is already a member.' });
      return;
    }

    // Assign the user as owner via org_stakeholders
    await pool.query(
      `INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
       VALUES ($1, $2, $3, $4, 'owner', $5)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = 'owner', notes = $5, updated_at = NOW()`,
      [orgId, user.workos_user_id, user.first_name, user.email, `Claimed via Slack on ${new Date().toISOString().split('T')[0]}`]
    );

    // Also set prospect_owner to the human's name
    await pool.query(
      `UPDATE organizations SET prospect_owner = $1, updated_at = NOW() WHERE workos_organization_id = $2`,
      [user.first_name, orgId]
    );

    // Get org name for confirmation
    const orgResult = await pool.query<{ name: string }>(`SELECT name FROM organizations WHERE workos_organization_id = $1`, [orgId]);
    const orgName = orgResult.rows[0]?.name || orgId;

    // Update the original message to show who claimed it
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Enterprise prospect claimed by <@${userId}>: ${orgName}`,
        blocks: [
          ...(body.message?.blocks?.slice(0, -1) || []),
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Claimed by:* <@${userId}>` },
          },
        ],
      });
    } catch (updateErr) {
      logger.warn({ error: updateErr }, 'Addie Bolt: Failed to update prospect claim message');
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `You are now the owner of ${orgName}. View details in the admin prospects page.`,
    });

    logger.info({ orgId, orgName, userId }, 'Addie Bolt: Prospect claimed via Slack button');
  } catch (error) {
    logger.error({ error, orgId, userId }, 'Addie Bolt: Error handling prospect claim');
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Failed to claim prospect. Please try again or use the admin portal.',
    });
  }
}

/**
 * Handle "Not relevant" button from prospect notification
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleProspectDisqualify({ ack, body, client }: any): Promise<void> {
  await ack();

  const orgId = body.actions?.[0]?.value;
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!orgId || !userId || !channelId) {
    logger.warn({ orgId, userId, channelId }, 'Addie Bolt: Prospect disqualify missing required fields');
    return;
  }

  if (!/^[UW][A-Z0-9]+$/.test(userId)) {
    logger.warn({ userId }, 'Addie Bolt: Invalid Slack user ID format in prospect disqualify');
    return;
  }

  try {
    const pool = getPool();

    await pool.query(
      `UPDATE organizations
       SET prospect_status = 'disqualified',
           disqualification_reason = $1,
           prospect_notes = COALESCE(prospect_notes, '') || $2,
           updated_at = NOW()
       WHERE workos_organization_id = $3`,
      [
        'Marked not relevant via Slack',
        `\n\n${new Date().toISOString().split('T')[0]}: Marked not relevant via Slack by <@${userId}>`,
        orgId,
      ]
    );

    const orgResult = await pool.query<{ name: string }>(`SELECT name FROM organizations WHERE workos_organization_id = $1`, [orgId]);
    const orgName = orgResult.rows[0]?.name || orgId;

    // Update the original message to show it was disqualified
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Prospect ${orgName} marked as not relevant by <@${userId}>`,
        blocks: [
          ...(body.message?.blocks?.slice(0, -1) || []),
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Disqualified by:* <@${userId}>` },
          },
        ],
      });
    } catch (updateErr) {
      logger.warn({ error: updateErr }, 'Addie Bolt: Failed to update prospect disqualify message');
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `${orgName} has been marked as not relevant.`,
    });

    logger.info({ orgId, orgName, userId }, 'Addie Bolt: Prospect disqualified via Slack button');
  } catch (error) {
    logger.error({ error, orgId, userId }, 'Addie Bolt: Error handling prospect disqualify');
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Failed to update prospect. Please try again or use the admin portal.',
    });
  }
}

/**
 * Handle "Add domain to org" button from alias match notification
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAliasConfirm({ ack, body, client }: any): Promise<void> {
  await ack();

  const rawValue = body.actions?.[0]?.value;
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!rawValue || !userId || !channelId) {
    logger.warn({ rawValue, userId, channelId }, 'Addie Bolt: Alias confirm missing required fields');
    return;
  }

  let domain: string;
  let orgId: string;
  try {
    const parsed = JSON.parse(rawValue);
    domain = parsed.domain;
    orgId = parsed.orgId;
  } catch {
    logger.warn({ rawValue }, 'Addie Bolt: Failed to parse alias confirm value');
    return;
  }

  if (!domain || !orgId) {
    logger.warn({ domain, orgId }, 'Addie Bolt: Alias confirm missing domain or orgId');
    return;
  }

  // Validate inputs before writing to DB
  if (!/^org_/.test(orgId)) {
    logger.warn({ orgId }, 'Addie Bolt: Invalid org ID format in alias confirm');
    return;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    logger.warn({ domain }, 'Addie Bolt: Invalid domain format in alias confirm');
    return;
  }

  try {
    const pool = getPool();

    // Verify the org exists before linking
    const orgResult = await pool.query<{ email_domain: string; name: string }>(
      `SELECT email_domain, name FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );

    if (orgResult.rows.length === 0) {
      logger.warn({ orgId }, 'Addie Bolt: Org not found for alias confirm');
      await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'Organization not found.' });
      return;
    }

    // Add domain to organization_domains
    await pool.query(
      `INSERT INTO organization_domains (workos_organization_id, domain)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [orgId, domain]
    );
    const orgRow = orgResult.rows[0];

    if (orgRow?.email_domain) {
      await pool.query(
        `INSERT INTO brand_domain_aliases (alias_domain, brand_domain, source)
         VALUES ($1, $2, 'manual_confirm')
         ON CONFLICT (alias_domain) DO NOTHING`,
        [domain, orgRow.email_domain]
      );
    }

    const orgName = orgRow?.name ?? orgId;

    // Update the Slack message: remove buttons, show confirmation
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Alias confirmed: ${domain} added to ${orgName} by <@${userId}>`,
        blocks: [
          ...(body.message?.blocks?.slice(0, -1) || []),
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Confirmed by:* <@${userId}>` },
          },
        ],
      });
    } catch (updateErr) {
      logger.warn({ error: updateErr }, 'Addie Bolt: Failed to update alias confirm message');
    }

    // Log to triage log
    await pool.query(
      `INSERT INTO prospect_triage_log (domain, action, reason, owner, priority, verdict, source, enriched)
       VALUES ($1, 'skip', 'alias_confirmed', 'addie', 'standard', $2, 'slack_button', false)`,
      [domain, `Domain ${domain} confirmed as alias of ${orgName} by Slack user ${userId}`]
    ).catch(err => {
      logger.warn({ err, domain }, 'Addie Bolt: Failed to log alias confirmation');
    });

    logger.info({ domain, orgId, orgName, userId }, 'Addie Bolt: Alias confirmed via Slack button');
  } catch (error) {
    logger.error({ error, domain, orgId, userId }, 'Addie Bolt: Error handling alias confirm');
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Failed to confirm alias. Please try again or use the admin portal.',
    });
  }
}

/**
 * Handle "Not a match" button from alias match notification
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleAliasReject({ ack, body, client }: any): Promise<void> {
  await ack();

  const rawValue = body.actions?.[0]?.value;
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;

  if (!rawValue || !userId || !channelId) {
    logger.warn({ rawValue, userId, channelId }, 'Addie Bolt: Alias reject missing required fields');
    return;
  }

  let domain: string;
  let orgId: string;
  try {
    const parsed = JSON.parse(rawValue);
    domain = parsed.domain;
    orgId = parsed.orgId;
  } catch {
    logger.warn({ rawValue }, 'Addie Bolt: Failed to parse alias reject value');
    return;
  }

  if (!domain || !orgId) {
    logger.warn({ domain, orgId }, 'Addie Bolt: Alias reject missing domain or orgId');
    return;
  }

  try {
    const pool = getPool();

    // Update the Slack message: remove buttons, show dismissal
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Alias dismissed: ${domain} is not a match (dismissed by <@${userId}>)`,
        blocks: [
          ...(body.message?.blocks?.slice(0, -1) || []),
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Dismissed by:* <@${userId}>` },
          },
        ],
      });
    } catch (updateErr) {
      logger.warn({ error: updateErr }, 'Addie Bolt: Failed to update alias reject message');
    }

    // Log to triage log
    await pool.query(
      `INSERT INTO prospect_triage_log (domain, action, reason, owner, priority, verdict, source, enriched)
       VALUES ($1, 'skip', 'alias_rejected', 'addie', 'standard', $2, 'slack_button', false)`,
      [domain, `Domain ${domain} rejected as alias match by Slack user ${userId}`]
    ).catch(err => {
      logger.warn({ err, domain }, 'Addie Bolt: Failed to log alias rejection');
    });

    logger.info({ domain, orgId, userId }, 'Addie Bolt: Alias rejected via Slack button');
  } catch (error) {
    logger.error({ error, domain, orgId, userId }, 'Addie Bolt: Error handling alias reject');
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Failed to dismiss alias. Please try again.',
    });
  }
}

/**
 * Handle marketing opt-in button clicks from Slack DM.
 * Both yes and no route here — we distinguish by action_id.
 */
async function handleMarketingOptIn({ ack, body, client }: any): Promise<void> {
  await ack();

  const actionId = body.actions?.[0]?.action_id;
  const slackUserId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  const optIn = actionId === 'marketing_optin_yes';

  if (!slackUserId) {
    logger.warn({ actionId }, 'Addie Bolt: Marketing opt-in missing user ID');
    return;
  }

  try {
    const slackDb = new SlackDatabase();
    const mapping = await slackDb.getBySlackUserId(slackUserId);

    if (mapping?.workos_user_id) {
      // User is mapped to a web account — record preference if not already set
      if (!mapping.slack_email) {
        logger.warn({ slackUserId }, 'Cannot record marketing opt-in: no email on Slack mapping, storing as pending');
        await slackDb.setPendingMarketingOptIn(slackUserId, optIn);
      } else {
        const emailPrefsDb = new EmailPreferencesDatabase();
        const wasSet = await emailPrefsDb.setMarketingOptInIfNotSet({
          workos_user_id: mapping.workos_user_id,
          email: mapping.slack_email,
          optIn,
        });
        if (wasSet) {
          logger.info({ slackUserId, workosUserId: mapping.workos_user_id, optIn }, 'Marketing opt-in recorded via Slack');
        } else {
          logger.debug({ slackUserId, workosUserId: mapping.workos_user_id }, 'Skipping marketing opt-in — user already has explicit preference');
        }
      }
    } else {
      // Not mapped yet — store as pending preference
      await slackDb.setPendingMarketingOptIn(slackUserId, optIn);
      logger.info({ slackUserId, optIn }, 'Pending marketing opt-in stored for unmapped Slack user');
    }

    // Update the message to replace buttons with confirmation
    const confirmText = optIn
      ? "You're all set — you'll receive The Prompt, The Build, and event notifications via email."
      : "No problem — you won't receive marketing emails from us.";

    if (channelId && messageTs) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: confirmText,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: confirmText },
            },
          ],
        });
      } catch (updateErr) {
        logger.warn({ error: updateErr }, 'Addie Bolt: Failed to update marketing opt-in message');
      }
    }
  } catch (error) {
    logger.error({ error, slackUserId, actionId }, 'Addie Bolt: Error handling marketing opt-in');
    if (channelId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: slackUserId,
        text: 'Something went wrong recording your preference. Please try again.',
      });
    }
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
 * Build confidence calibration text for the system prompt.
 * Tells Claude how to adjust response style based on confidence tier.
 */
function buildConfidenceCalibration(confidence: ConfidenceTier): string {
  if (confidence === 'low') {
    return '## Response Calibration\nYou are not confident you can answer this well. Lead with "I\'m not sure about this" and keep it brief (2-3 sentences). Suggest who might help if you know.';
  }
  if (confidence === 'suggest') {
    return '## Response Calibration\nYou cannot answer this directly but know who can. Give a brief pointer (1-2 sentences) to a specific person, working group, or channel. Do not explain what you cannot do.';
  }
  return '';
}

function buildRouterDecision(plan: ExecutionPlan): {
  action: string;
  reason: string;
  decision_method: 'quick_match' | 'llm';
  tool_sets?: string[];
  confidence?: string;
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
    return { ...base, tool_sets: plan.tool_sets, confidence: plan.confidence };
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
  // Log entry for DM debugging
  logger.debug({
    channelId: event.channel,
    userId: event.user,
    ts: event.ts,
    threadTs: event.thread_ts,
    hasText: !!event.text,
    textLength: event.text?.length || 0,
    botId: event.bot_id,
  }, 'Addie Bolt: handleDirectMessage called');

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
  const slackThreadTs = event.thread_ts || event.ts;

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

  // Look up the permanent thread from person_relationships so all DMs with this
  // person route to a single addie_threads record — even if the Slack event
  // arrives as a top-level message without thread_ts.
  let permThreadTs: string | null = null;
  let cachedRel: Awaited<ReturnType<typeof relationshipDb.getRelationshipBySlackId>> | null = null;
  try {
    cachedRel = await relationshipDb.getRelationshipBySlackId(userId);
    if (cachedRel?.slack_dm_channel_id === channelId && cachedRel.slack_dm_thread_ts) {
      permThreadTs = cachedRel.slack_dm_thread_ts;
    }
  } catch (error) {
    logger.debug({ error, userId }, 'Addie Bolt: Could not look up permanent thread');
  }

  const threadTs = permThreadTs || slackThreadTs;
  const externalId = `${channelId}:${threadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(messageText);

  logger.info({ userId, channelId }, 'Addie Bolt: Processing direct message');

  // Record inbound message in the relationship system (resets unreplied count, derives sentiment)
  recordPersonInboundMessage(userId, 'slack', 'dm', messageText.length);

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
  const MAX_HISTORY_MESSAGES = 20;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  let historyUnavailable = false;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
          toolCalls: msg.tool_calls ?? undefined,
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
    historyUnavailable = true;
  }

  // Build per-request context for system prompt (no channel context for DMs)
  let { requestContext, memberContext: updatedMemberContext } = await buildRequestContext(userId);
  if (historyUnavailable) {
    requestContext += `\n\n${HISTORY_UNAVAILABLE_NOTE}`;
  }
  if (!memberContext && updatedMemberContext) {
    memberContext = updatedMemberContext;
  }

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: messageText,
      content_sanitized: inputValidation.sanitized,
      flagged: userMessageFlagged,
      flag_reason: inputValidation.reason || undefined,
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save user message');
  }

  const routedTools = await selectRoutedToolsForSlackResponse(
    inputValidation.sanitized,
    'dm',
    memberContext,
    userId,
    thread.thread_id,
    null
  );

  requestContext = [requestContext, routedTools.unavailableHint, buildConfidenceCalibration(routedTools.confidence)]
    .filter(Boolean)
    .join('\n\n');

  // Admin users get higher iteration limit for bulk operations
  const processOptions = {
    ...(routedTools.isAAOAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : {}),
    ...((routedTools.requiresPrecision || routedTools.requiresDepth) ? { modelOverride: ModelConfig.precision } : {}),
    requestContext,
    slackUserId: userId,
    threadId: thread.thread_id,
  };

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(inputValidation.sanitized, conversationHistory, routedTools.tools, undefined, processOptions);
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
  const dmGuarded = guardBareJsonEnvelope(response.text, { pathTag: 'dm-assistant' });
  const outputValidation = validateOutput(dmGuarded.text);

  // Always thread the response to the user's message. This ensures:
  // 1. Slack Assistant "Chat" tab: response appears inline in the conversation
  //    (first DMs have no thread_ts, so we use event.ts to start the thread)
  // 2. Regular DMs: response threads to the user's message (Slack shows
  //    threaded DM replies inline, so UX is unchanged)
  const replyThreadTs = event.thread_ts || event.ts;
  let responseTs: string | undefined;
  try {
    const postResult = await boltApp.client.chat.postMessage({
      channel: channelId,
      text: wrapUrlsForSlack(outputValidation.sanitized),
      thread_ts: replyThreadTs,
    });
    responseTs = postResult.ts;
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send DM response');
  }

  // If no permanent thread existed, save the user's message ts as the permanent
  // thread so the orchestrator will continue in this same thread later.
  if (!permThreadTs) {
    try {
      const rel = cachedRel ?? await relationshipDb.getRelationshipBySlackId(userId);
      if (rel && !rel.slack_dm_thread_ts) {
        await relationshipDb.setSlackDmThread(rel.id, channelId, slackThreadTs);
        logger.info({ userId, channelId, threadTs: slackThreadTs }, 'Addie Bolt: Saved permanent DM thread from inbound conversation');
      }
    } catch (error) {
      logger.debug({ error, userId }, 'Addie Bolt: Could not save permanent thread');
    }
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');

  try {
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
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save assistant message');
  }

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    try {
      await threadService.flagThread(
        thread.thread_id,
        [inputValidation.reason, flagReason].filter(Boolean).join('; ')
      );
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to flag thread');
    }
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
 * Handle replies in threads where Addie has already participated.
 *
 * When a user replies to a thread where Addie has already responded,
 * we treat it as an implicit @mention and respond directly. This creates
 * natural conversational flow - users don't need to explicitly @mention
 * Addie to continue a conversation.
 *
 * This is similar to DM handling but with thread context included.
 */
async function handleActiveThreadReply({
  event,
  context,
  channelId,
  userId,
  messageText,
  threadTs,
  startTime,
  threadService,
  slackThreadMessages,
}: {
  event: SlackEventMiddlewareArgs<'message'>['event'];
  context: { botUserId?: string };
  channelId: string;
  userId: string;
  messageText: string;
  threadTs: string;
  startTime: number;
  threadService: ReturnType<typeof getThreadService>;
  slackThreadMessages: Awaited<ReturnType<typeof getThreadReplies>>;
}): Promise<void> {
  if (!claudeClient || !boltApp) {
    logger.warn('Addie Bolt: Not initialized for active thread reply');
    return;
  }

  // Build external ID for thread: channel_id:thread_ts
  const externalId = `${channelId}:${threadTs}`;

  // Sanitize input
  const inputValidation = sanitizeInput(messageText);

  // Fetch channel context (includes working group if channel is linked to one)
  let channelContext: ThreadContext | undefined;
  try {
    channelContext = await buildChannelContext(channelId);
  } catch (error) {
    logger.debug({ error, channelId }, 'Addie Bolt: Could not get channel context for active thread reply');
  }

  // Build thread context from the messages already fetched (avoid duplicate API call)
  const MAX_THREAD_CONTEXT_MESSAGES = 25;
  let threadContext = '';

  if (slackThreadMessages.length > 0) {
    // Include all messages (including Addie's) for full context
    // but exclude the current message
    const filteredMessages = slackThreadMessages
      .filter(msg => msg.ts !== event.ts) // Exclude current message
      .filter(msg => (msg.text || '').trim().length > 0)
      .slice(-MAX_THREAD_CONTEXT_MESSAGES);

    // Collect user IDs for display name lookup
    const mentionedUserIds = new Set<string>();
    for (const msg of filteredMessages) {
      if (msg.user && msg.user !== context.botUserId) {
        mentionedUserIds.add(msg.user);
      }
      const mentions = (msg.text || '').matchAll(/<@(U[A-Z0-9]+)>/gi);
      for (const match of mentions) {
        if (match[1] !== context.botUserId) {
          mentionedUserIds.add(match[1]);
        }
      }
    }

    // Look up display names
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

    // Format messages with speaker identification
    const contextMessages = filteredMessages.map(msg => {
      let text = msg.text || '';
      const isAddie = msg.user === context.botUserId;
      const speaker = isAddie ? 'Addie' : (userNameMap.get(msg.user || '') || 'User');

      // Strip bot mentions
      if (context.botUserId) {
        text = text.replace(new RegExp(`<@${context.botUserId}>\\s*`, 'gi'), '').trim();
      }
      // Replace user mentions with display names
      text = text.replace(/<@(U[A-Z0-9]+)>/gi, (match, uid) => {
        const name = userNameMap.get(uid);
        return name ? `@${name}` : '[someone]';
      });

      return `- ${speaker}: ${text}`;
    });

    if (contextMessages.length > 0) {
      threadContext = `\n\n## Thread Context\nThis is a continuation of a conversation in a Slack thread. Here are the previous messages:\n${contextMessages.join('\n')}\n\n---\n`;

      // Calibrate response length to match the thread's conversational register
      const styleHint = buildThreadStyleHint(slackThreadMessages, context.botUserId || '');
      if (styleHint) {
        threadContext += `\n${styleHint}\n`;
      }

      logger.debug({ messageCount: contextMessages.length }, 'Addie Bolt: Built thread context for active reply');
    }
  }

  // Get member context
  let memberContext: MemberContext | null = null;
  try {
    memberContext = await getMemberContext(userId);
  } catch (error) {
    logger.debug({ error, userId }, 'Addie Bolt: Could not get member context for active thread reply');
  }

  // Get or create unified thread
  const thread = await threadService.getOrCreateThread({
    channel: 'slack',
    external_id: externalId,
    user_type: 'slack',
    user_id: userId,
    user_display_name: memberContext?.slack_user?.display_name || undefined,
    context: {
      channel_id: channelId,
      channel_name: channelContext?.viewing_channel_name,
      message_type: 'active_thread_reply',
    },
  });

  // Fetch conversation history from database for context
  // This ensures Claude remembers what Addie said in previous turns
  const MAX_DB_HISTORY_MESSAGES = 20;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  let historyUnavailable = false;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_DB_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
          toolCalls: msg.tool_calls ?? undefined,
        }));

      if (conversationHistory.length > 0) {
        logger.debug(
          { threadId: thread.thread_id, messageCount: conversationHistory.length },
          'Addie Bolt: Loaded conversation history for active thread reply'
        );
      }
    }
  } catch (error) {
    logger.warn({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to fetch conversation history for active thread reply');
    historyUnavailable = true;
  }

  // Build per-request context for system prompt (pass channelContext so public channel guard is included)
  const { requestContext: memberRequestContext, memberContext: updatedMemberContext } = await buildRequestContext(userId, channelContext);
  if (!memberContext && updatedMemberContext) {
    memberContext = updatedMemberContext;
  }

  // When DB history is available, skip Slack thread context (DB history is more structured
  // and already represented as proper user/assistant turns). Use Slack thread context as
  // fallback when DB history is unavailable.
  let requestContext = (!conversationHistory || conversationHistory.length === 0) && threadContext
    ? `${memberRequestContext}\n\n${threadContext}`
    : memberRequestContext;
  // Only warn about missing history when there's no Slack thread context either.
  // When threadContext exists it serves as a usable fallback for conversation continuity.
  if (historyUnavailable && (!threadContext || threadContext.length === 0)) {
    requestContext += `\n\n${HISTORY_UNAVAILABLE_NOTE}`;
  }

  // Log user message to unified thread
  const userMessageFlagged = inputValidation.flagged;
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: messageText,
      content_sanitized: inputValidation.sanitized,
      flagged: userMessageFlagged,
      flag_reason: inputValidation.reason || undefined,
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save user message');
  }

  const threadSummary = buildThreadSummaryForRouter(
    slackThreadMessages,
    context.botUserId || '',
    event.ts,
    userId,
  );

  const routedTools = await selectRoutedToolsForSlackResponse(
    inputValidation.sanitized,
    'channel',
    memberContext,
    userId,
    thread.thread_id,
    channelContext,
    { isThread: true, threadMessages: threadSummary }
  );

  // Suppress low-confidence replies in active channel threads, flag for review
  if (routedTools.confidence === 'low') {
    logger.info({ channelId, userId, threadTs },
      'Addie Bolt: Suppressing low-confidence active thread reply');
    try {
      await threadService.flagThread(thread.thread_id, 'Low-confidence suppression (active thread)');
    } catch (flagError) {
      logger.debug({ error: flagError }, 'Addie Bolt: Could not flag suppressed thread');
    }
    return;
  }

  requestContext = [requestContext, routedTools.unavailableHint, buildConfidenceCalibration(routedTools.confidence)]
    .filter(Boolean)
    .join('\n\n');

  // Use Opus for protocol-depth channels (wg-*, council-*) or router-flagged depth
  const threadIsDepthChannel = isDepthChannel(channelContext?.viewing_channel_name);
  const threadUseOpus = routedTools.requiresPrecision || routedTools.requiresDepth || threadIsDepthChannel;

  // Admin users get higher iteration limit
  const processOptions = {
    ...(routedTools.isAAOAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : {}),
    ...(threadUseOpus ? { modelOverride: ModelConfig.precision } : {}),
    requestContext,
    slackUserId: userId,
    threadId: thread.thread_id,
  };

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(inputValidation.sanitized, conversationHistory, routedTools.tools, undefined, processOptions);
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Error processing active thread reply');
    response = {
      text: "I'm sorry, I encountered an error. Please try again.",
      tools_used: [],
      tool_executions: [],
      flagged: true,
      flag_reason: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
    };
  }

  // Validate output
  const activeThreadGuarded = guardBareJsonEnvelope(response.text, { pathTag: 'active-thread-reply' });
  const outputValidation = validateOutput(activeThreadGuarded.text);

  // Send response in the thread
  try {
    await boltApp.client.chat.postMessage({
      channel: channelId,
      text: wrapUrlsForSlack(outputValidation.sanitized),
      thread_ts: threadTs, // Reply in the thread
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send active thread reply');
  }

  // Log assistant response to unified thread
  const assistantFlagged = response.flagged || outputValidation.flagged;
  const flagReason = [response.flag_reason, outputValidation.reason].filter(Boolean).join('; ');
  const activeThreadEffectiveModel = threadUseOpus ? ModelConfig.precision : AddieModelConfig.chat;

  try {
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
      model: activeThreadEffectiveModel,
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
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save assistant message');
  }

  // Flag the thread if any message was flagged
  if (userMessageFlagged || assistantFlagged) {
    try {
      await threadService.flagThread(
        thread.thread_id,
        [inputValidation.reason, flagReason].filter(Boolean).join('; ')
      );
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to flag thread');
    }
  }

  // Log to security audit (using 'mention' since this behaves like an implicit mention)
  logInteraction({
    id: thread.thread_id,
    timestamp: new Date(),
    event_type: 'mention',
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
    { userId, channelId, threadTs, latencyMs: Date.now() - startTime },
    'Addie Bolt: Active thread reply sent'
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

  // Handle message_deleted for any channel type (DMs included)
  if (hasSubtype && 'subtype' in event && event.subtype === 'message_deleted') {
    const deletedTs = 'deleted_ts' in event ? (event as { deleted_ts: string }).deleted_ts : undefined;
    if (deletedTs) {
      const externalId = `${event.channel}:${deletedTs}`;
      const threadService = getThreadService();
      const deleted = await threadService.markSlackDeleted('slack', externalId);
      if (deleted) {
        logger.info({ channelId: event.channel, deletedTs }, 'Addie Bolt: Marked thread slack_deleted for deleted Slack message');
      }
    }
    return;
  }

  // Handle DMs differently - route to the user message handler
  // For DMs, allow messages with attachments or files even if text is empty
  if (event.channel_type === 'im') {
    // Log detailed info for DM debugging (use same check as middleware for consistency)
    const hasThreadTs = 'thread_ts' in event && event.thread_ts !== undefined;
    logger.debug({
      channelId: event.channel,
      userId,
      hasText,
      hasAttachments,
      hasFiles,
      hasSubtype,
      subtype: 'subtype' in event ? event.subtype : undefined,
      hasThreadTs,
      threadTs: 'thread_ts' in event ? event.thread_ts : undefined,
      ts: 'ts' in event ? event.ts : undefined,
    }, 'Addie Bolt: Received DM in handleChannelMessage');

    // DMs with thread_ts are handled by the Assistant framework (handleUserMessage).
    // Only handle first DMs (no thread_ts) here to avoid sending duplicate responses.
    if (hasThreadTs) {
      logger.debug({ channelId: event.channel, userId }, 'Addie Bolt: Skipping threaded DM - handled by Assistant framework');
      return;
    }

    if (!hasText && !hasAttachments && !hasFiles) {
      logger.debug({ channelId: event.channel, userId }, 'Addie Bolt: Ignoring DM without content');
      return;
    }
    if (hasSubtype) {
      logger.debug({ channelId: event.channel, userId, subtype: 'subtype' in event ? event.subtype : undefined }, 'Addie Bolt: Ignoring DM with subtype');
      return;
    }
    logger.debug({ channelId: event.channel, userId }, 'Addie Bolt: Routing DM to handleDirectMessage');
    await handleDirectMessage(event as typeof event & { attachments?: SlackAttachment[]; files?: SlackFile[] }, context);
    return;
  }

  // For channel messages, require text and skip remaining subtypes
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

  // Check if this is a reply in a digest review thread — route to digest editor
  if (isInThread) {
    const digestThreadTs = 'thread_ts' in event ? event.thread_ts! : event.ts;
    const digestHandled = await handleDigestEditReply(channelId, digestThreadTs, messageText, userId);
    if (digestHandled) return;
  }

  // Check if this is a reply in a thread where Addie has already participated.
  // If so, treat it as an implicit @mention and respond directly.
  // This creates natural conversational flow when users reply to Addie's questions.
  if (isInThread && context.botUserId) {
    const threadTsForCheck = 'thread_ts' in event ? event.thread_ts! : event.ts;
    const { participated, messages: slackThreadMessages } = await checkAddieThreadParticipation(
      channelId,
      threadTsForCheck,
      context.botUserId
    );

    if (participated) {
      // Skip if the message is not directed at Addie. In multi-party threads this
      // prevents butting into human-to-human conversation. In single-party threads
      // we still skip when the message explicitly starts with a @mention of someone
      // else (e.g. "@Christina know anything about this?").
      const multiParty = isMultiPartyThread(slackThreadMessages, context.botUserId, userId);
      const directedAtAddie = isDirectedAtAddie(messageText, slackThreadMessages, event.ts, userId, context.botUserId);
      const addressedToOther = isAddressedToAnotherUser(messageText, context.botUserId);
      if (!directedAtAddie && (multiParty || addressedToOther)) {
        const uniqueHumans = new Set(
          slackThreadMessages.map(msg => msg.user).filter(u => u && u !== context.botUserId)
        ).size;
        logger.info(
          { channelId, userId, threadTs: threadTsForCheck, uniqueHumans, multiParty, addressedToOther },
          'Addie Bolt: Skipping auto-response in thread (message not directed at Addie)'
        );
        return;
      }

      // In multi-party threads, delay before responding to let humans go first.
      // Skip delay if user explicitly named Addie (they want her input).
      const explicitlyNamedAddie = /\baddie\b/i.test(messageText);
      if (!explicitlyNamedAddie && multiParty) {
        const shouldRespond = await shouldRespondAfterDelay(
          channelId, threadTsForCheck, event.ts, context.botUserId
        );
        if (!shouldRespond) {
          logger.info(
            { channelId, userId, threadTs: threadTsForCheck },
            'Addie Bolt: Skipping active thread reply — human replied during delay'
          );
          return;
        }
      }

      logger.info({ channelId, userId, threadTs: threadTsForCheck },
        'Addie Bolt: Responding to active thread reply (Addie already participating)');

      await handleActiveThreadReply({
        event,
        context,
        channelId,
        userId,
        messageText,
        threadTs,
        startTime,
        threadService,
        slackThreadMessages, // Pass messages to avoid duplicate API call
      });
      return;
    }
  }

  try {
    // Fetch channel context (includes working group if channel is linked to one)
    let channelContext: ThreadContext | undefined;
    try {
      channelContext = await buildChannelContext(channelId);
    } catch (error) {
      logger.debug({ error, channelId }, 'Addie Bolt: Could not get channel context');
    }

    // Fetch member context, admin status, and thread messages (if in a thread) in parallel
    const threadRepliesPromise = isInThread && event.thread_ts
      ? getThreadReplies(channelId, event.thread_ts).catch((err) => {
          logger.debug({ error: err, channelId }, 'Addie Bolt: Could not fetch thread replies for routing context');
          return [] as Awaited<ReturnType<typeof getThreadReplies>>;
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof getThreadReplies>>);

    const [memberContext, isAdminForRouting, coldThreadMessages] = await Promise.all([
      getMemberContext(userId),
      isSlackUserAAOAdmin(userId),
      threadRepliesPromise,
    ]);

    const coldThreadSummary = coldThreadMessages.length > 0
      ? buildThreadSummaryForRouter(coldThreadMessages, context.botUserId || '', event.ts, userId)
      : undefined;

    // Build routing context
    const routingCtx: RoutingContext = {
      message: messageText,
      source: 'channel',
      memberContext,
      isThread: isInThread,
      isAAOAdmin: isAdminForRouting,
      channelName: channelContext?.viewing_channel_name,
      threadMessages: coldThreadSummary,
    };

    // Quick match first (no API call for obvious cases)
    let plan = addieRouter.quickMatch(routingCtx);
    let siRetrievalResult: SIRetrievalResult | null = null;

    // If no quick match, use the full router AND retrieve SI agents in parallel
    if (!plan) {
      const [routerPlan, siResult] = await Promise.all([
        addieRouter.route(routingCtx),
        siRetriever.retrieve(messageText),
      ]);
      plan = routerPlan;
      siRetrievalResult = siResult;
    }

    logger.debug({
      channelId,
      action: plan.action,
      reason: plan.reason,
      siAgentsFound: siRetrievalResult?.agents.length ?? 0,
    }, 'Addie Bolt: Router decision for channel message');

    // Build external ID for Slack channel messages: channel_id:thread_ts
    const externalId = `${channelId}:${threadTs}`;

    // Get or create unified thread for this channel message
    const thread = await threadService.getOrCreateThread({
      channel: 'slack',
      external_id: externalId,
      user_type: 'slack',
      user_id: userId,
      user_display_name: memberContext?.slack_user?.display_name || undefined,
      context: {
        channel_id: channelId,
        channel_name: channelContext?.viewing_channel_name,
        message_type: 'channel_message',
      },
    });

    // Sanitize input for logging
    const inputValidation = sanitizeInput(messageText);

    // Log user message to unified thread with router decision
    try {
      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: messageText,
        content_sanitized: inputValidation.sanitized,
        flagged: inputValidation.flagged,
        flag_reason: inputValidation.reason || undefined,
        router_decision: buildRouterDecision(plan),
      });
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save user message');
    }

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

    // action === 'respond'
    // Suppress low-confidence channel responses — let humans answer, but flag for review
    if (plan.confidence === 'low') {
      logger.info({ channelId, userId, reason: plan.reason },
        'Addie Bolt: Suppressing low-confidence channel response');
      try {
        await threadService.flagThread(thread.thread_id, `Low-confidence suppression: ${plan.reason}`);
      } catch (flagError) {
        logger.debug({ error: flagError }, 'Addie Bolt: Could not flag suppressed thread');
      }
      return;
    }

    // In threaded channel messages where Addie hasn't participated yet,
    // check if humans have already been answering. If so, don't jump in
    // unless explicitly named — humans are handling it.
    if (isInThread && context.botUserId && !/\baddie\b/i.test(messageText)) {
      try {
        // Reuse thread messages already fetched for routing (avoid duplicate API call)
        const threadReplies = coldThreadMessages.length > 0
          ? coldThreadMessages
          : await getThreadReplies(channelId, threadTs);
        const humanRepliesBeforeTrigger = threadReplies.filter(
          msg => msg.user && msg.user !== context.botUserId && msg.user !== userId && msg.ts < event.ts
        );
        if (humanRepliesBeforeTrigger.length > 0) {
          const confidence = plan.action === 'respond' ? plan.confidence : undefined;
          logger.info(
            { channelId, userId, threadTs, humanReplies: humanRepliesBeforeTrigger.length, confidence },
            'Addie Bolt: Skipping channel thread — humans already answering'
          );
          // Flag high-confidence suppressions and queue shadow evaluation —
          // Addie had a good answer but stayed silent. The shadow evaluator will
          // generate what she would have said and compare with the human's answer.
          if (confidence === 'high') {
            try {
              await threadService.flagThread(
                thread.thread_id,
                `Suppressed high-confidence response (humans answering): ${plan.reason}`
              );
              await threadService.patchThreadContext(thread.thread_id, {
                shadow_eval_status: 'pending',
                shadow_eval_requested_at: new Date().toISOString(),
                shadow_eval_channel_id: channelId,
                shadow_eval_thread_ts: threadTs,
                shadow_eval_tool_sets: plan.action === 'respond' ? plan.tool_sets : [],
                shadow_eval_question: messageText,
              });
            } catch (flagError) {
              logger.debug({ error: flagError }, 'Addie Bolt: Could not flag/queue shadow eval');
            }
          }
          return;
        }
      } catch (error) {
        logger.debug({ error, channelId }, 'Addie Bolt: Could not check thread replies');
      }

      // Also delay and re-check for new human replies after the trigger
      const shouldRespond = await shouldRespondAfterDelay(
        channelId, threadTs, event.ts, context.botUserId
      );
      if (!shouldRespond) {
        const confidence = plan.action === 'respond' ? plan.confidence : undefined;
        logger.info(
          { channelId, userId, threadTs, confidence },
          'Addie Bolt: Skipping channel response — human replied during delay'
        );
        if (confidence === 'high') {
          try {
            await threadService.flagThread(
              thread.thread_id,
              `Suppressed high-confidence response (human replied during delay): ${plan.reason}`
            );
            await threadService.patchThreadContext(thread.thread_id, {
              shadow_eval_status: 'pending',
              shadow_eval_requested_at: new Date().toISOString(),
              shadow_eval_channel_id: channelId,
              shadow_eval_thread_ts: threadTs,
              shadow_eval_tool_sets: plan.action === 'respond' ? plan.tool_sets : [],
              shadow_eval_question: messageText,
            });
          } catch (flagError) {
            logger.debug({ error: flagError }, 'Addie Bolt: Could not flag/queue shadow eval');
          }
        }
        return;
      }
    }

    logger.info({ channelId, userId, toolSets: plan.tool_sets },
      'Addie Bolt: Generating proposed response for channel message');

    // Build per-request context for system prompt (pass channelContext so public channel guard is included)
    const { requestContext: memberRequestContext } = await buildRequestContext(userId, channelContext);

    // Get all user-scoped tools then filter by selected tool sets
    const { tools: userTools, isAAOAdmin: userIsAdmin } = await createUserScopedTools(memberContext, userId, thread.thread_id, channelContext);
    const proposedSets = [...plan.tool_sets];
    if (userIsAdmin && channelContext?.viewing_channel_working_group_slug === ADMIN_CHANNEL_WG_SLUG && !proposedSets.includes('admin')) {
      proposedSets.push('admin');
    }
    // System channels are operational channels — certification sessions don't happen here,
    // so no hasCertificationContext guard needed (unlike selectRoutedToolsForSlackResponse).
    const channelSystemRole = channelContext?.viewing_channel_system_role as SystemChannelRole | undefined;
    if (userIsAdmin && channelSystemRole) {
      for (const set of SYSTEM_CHANNEL_TOOL_SETS[channelSystemRole] ?? []) {
        if (!proposedSets.includes(set)) {
          proposedSets.push(set);
        }
      }
    }
    const { filteredTools, unavailableHint } = filterToolsBySet(userTools, proposedSets, userIsAdmin, channelContext?.viewing_channel_is_private === false);

    // Build SI context from retrieved agents
    const siContext = siRetrievalResult?.agents.length
      ? siRetriever.formatContext(siRetrievalResult.agents)
      : '';

    // Combine all context for system prompt (member info, unavailable tool hints, SI agents, confidence calibration)
    const requestContext = [memberRequestContext, unavailableHint, siContext, buildConfidenceCalibration(plan.confidence)]
      .filter(Boolean)
      .join('\n\n');

    // Use Opus for billing, router-flagged depth, or protocol-depth channels (wg-*, council-*)
    const channelIsDepthChannel = isDepthChannel(channelContext?.viewing_channel_name);
    const channelUseOpus = plan.requires_precision || plan.requires_depth || channelIsDepthChannel;
    const effectiveModel = channelUseOpus ? ModelConfig.precision : AddieModelConfig.chat;
    const processOptions = {
      ...(userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : {}),
      ...(channelUseOpus ? { modelOverride: ModelConfig.precision } : {}),
      requestContext,
      slackUserId: userId,
      threadId: thread.thread_id,
    };
    const response = await claudeClient.processMessage(messageText, undefined, filteredTools, undefined, processOptions);

    if (!response.text || response.text.trim().length === 0) {
      logger.debug({ channelId }, 'Addie Bolt: No response generated');
      return;
    }

    // Validate the output
    const proposedGuarded = guardBareJsonEnvelope(response.text, { pathTag: 'proposed-channel-response' });
    const outputValidation = validateOutput(proposedGuarded.text);
    if (outputValidation.flagged) {
      logger.warn({ channelId, reason: outputValidation.reason }, 'Addie Bolt: Proposed response flagged');
      return;
    }

    // Log assistant response to unified thread
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
      model: effectiveModel,
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

    // Post the response directly to the channel thread
    try {
      await boltApp?.client.chat.postMessage({
        channel: channelId,
        text: wrapUrlsForSlack(outputValidation.sanitized),
        thread_ts: threadTs,
      });
      logger.info({ channelId, userId }, 'Addie Bolt: Posted response to channel');
    } catch (error) {
      logger.error({ error, channelId }, 'Addie Bolt: Failed to post response to channel');
    }

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
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie Bolt: Failed to send account linked message');
    return false;
  }

  // Log as a system message in the unified thread (separate from Slack send)
  try {
    await threadService.addMessage({
      thread_id: recentThread.thread_id,
      role: 'system',
      content: messageText,
    });
  } catch (error) {
    logger.error({ error, threadId: recentThread.thread_id }, 'Addie Bolt: Failed to save account linked message');
  }

  logger.info({ slackUserId, channelId }, 'Addie Bolt: Sent account linked message');
  return true;
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
  const admin = await isSlackUserAAOAdmin(userId);
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
 * Handle a thread reply on a digest review message.
 * Processes editorial feedback and updates the draft.
 * Returns true if this was a digest review thread (handled), false otherwise.
 */
async function handleDigestEditReply(
  channelId: string,
  threadTs: string,
  messageText: string,
  userId: string,
): Promise<boolean> {
  const digest = await getDigestByReviewMessage(channelId, threadTs);
  if (!digest) {
    return false;
  }

  // Verify editor is an Editorial working group leader or member before any state changes
  const editorial = await workingGroupDb.getWorkingGroupBySlug('editorial');
  if (!editorial) {
    logger.warn('Editorial working group not found for digest edit');
    return true;
  }
  const isLeader = (editorial.leaders || []).some(
    (l) => l.user_id === userId || l.canonical_user_id === userId,
  );
  const isMember = isLeader || await workingGroupDb.isMember(editorial.id, userId);
  if (!isMember) {
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Only Editorial working group members can edit the digest.',
      });
    }
    return true;
  }

  if (digest.status === 'skipped') {
    // Revive skipped digest so editorial can continue collaborating
    const revived = await revertToDraft(digest.id);
    if (!revived) {
      if (boltApp) {
        await boltApp.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Could not reopen this digest. It may have already been sent.`,
        });
      }
      return true;
    }
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Digest reopened as a draft. Applying your edit...`,
      });
    }
  } else if (digest.status !== 'draft') {
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `This digest has already been sent. Edits can only be made to drafts.`,
      });
    }
    return true;
  }

  // Resolve editor name
  let editorName = 'An editor';
  try {
    const { resolveSlackUserDisplayName } = await import('../slack/client.js');
    const resolved = await resolveSlackUserDisplayName(userId);
    if (resolved?.display_name) {
      editorName = resolved.display_name;
    }
  } catch {
    // Use default
  }

  let result;
  try {
    if (isLegacyContent(digest.content)) {
      logger.warn({ digestId: digest.id }, 'Cannot edit legacy-format digest');
      return true;
    }
    result = await applyDigestEdit(digest.content, messageText, editorName);
  } catch (err) {
    logger.error({ error: err, digestId: digest.id }, 'Failed to apply digest edit');
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Something went wrong applying that edit. Try again or try a simpler instruction.',
      });
    }
    return true;
  }

  // Persist the updated content
  const updated = await updateDigestContent(digest.id, result.content);

  try {
    if (boltApp) {
      // Post the edit summary
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: result.summary,
      });

      // If content was actually changed, post an updated preview
      if (updated) {
        const editionDate = new Date(digest.edition_date).toISOString().split('T')[0];
        const preview = renderDigestReview(result.content, editionDate);

        await boltApp.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: preview.text,
          blocks: preview.blocks,
        });
      }
    }
  } catch (err) {
    logger.warn({ error: err, digestId: digest.id }, 'Failed to post digest edit response to Slack');
  }

  logger.info(
    { digestId: digest.id, editorName },
    'Digest edit applied',
  );

  return true;
}

/**
 * Handle 🔄 (arrows_counterclockwise) reaction on a digest review message.
 * Verifies the reactor is an Editorial working group member, then regenerates.
 */
async function handleDigestRegenerate(
  reactingUserId: string,
  channelId: string,
  messageTs: string,
): Promise<boolean> {
  const digest = await getDigestByReviewMessage(channelId, messageTs);
  if (!digest || (digest.status !== 'draft' && digest.status !== 'skipped')) {
    return false;
  }

  // Verify reactor is an Editorial working group leader or member before any state changes
  const editorial = await workingGroupDb.getWorkingGroupBySlug('editorial');
  if (!editorial) {
    logger.warn('Editorial working group not found for digest regenerate');
    return true;
  }
  const isLeader = (editorial.leaders || []).some(
    (l) => l.user_id === reactingUserId || l.canonical_user_id === reactingUserId,
  );
  const isMember = isLeader || await workingGroupDb.isMember(editorial.id, reactingUserId);
  if (!isMember) {
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: 'Only Editorial working group members can regenerate the digest.',
      });
    }
    return true;
  }

  // Delegate to handleDigestEditReply which handles revert, regeneration, and edit history
  return handleDigestEditReply(channelId, messageTs, 'regenerate', reactingUserId);
}

/**
 * Handle white_check_mark reaction on a weekly digest review message.
 * Verifies the reactor is an Editorial working group leader, then approves the digest.
 * Returns true if the reaction was for a digest review message (handled), false otherwise.
 */
async function handleDigestApproval(
  reactingUserId: string,
  channelId: string,
  messageTs: string,
): Promise<boolean> {
  const digest = await getDigestByReviewMessage(channelId, messageTs);
  if (!digest || (digest.status !== 'draft' && digest.status !== 'skipped')) {
    return false;
  }

  // Verify reactor is an Editorial working group leader
  const editorial = await workingGroupDb.getWorkingGroupBySlug('editorial');
  if (!editorial) {
    logger.warn('Editorial working group not found for digest approval');
    return true; // Still handled - don't fall through to general reaction logic
  }

  const leaders = editorial.leaders || [];
  // Check both user_id and canonical_user_id since leaders may be added via Slack ID
  const matchedLeader = leaders.find(
    (l) => l.user_id === reactingUserId || l.canonical_user_id === reactingUserId,
  );

  if (!matchedLeader) {
    logger.info({ reactingUserId }, 'Non-leader attempted digest approval');
    if (boltApp) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: 'Only Editorial working group leaders can approve the digest.',
      });
    }
    return true;
  }

  // Revive skipped digest before approving
  if (digest.status === 'skipped') {
    const revived = await revertToDraft(digest.id);
    if (!revived) return false;
  }

  // Store canonical (WorkOS) user ID for audit trail
  const approverUserId = matchedLeader.canonical_user_id || reactingUserId;
  const approved = await approveDigest(digest.id, approverUserId);
  if (approved && boltApp) {
    // Resolve the approver's name for the confirmation message
    const { resolveSlackUserDisplayName } = await import('../slack/client.js');
    const resolved = await resolveSlackUserDisplayName(reactingUserId);
    const name = resolved?.display_name || 'An editor';

    // If approved after the normal 10am send window, send immediately
    const { getETHour, sendDigest } = await import('./jobs/weekly-digest.js');
    const etHour = getETHour();

    if (etHour >= 10) {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Approved by ${name}! Sending now...`,
      });

      const sendResult = await sendDigest(approved);
      if (sendResult.sent === 0) {
        await boltApp.client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `Delivery failed — nothing was sent. The digest is still approved and will retry on the next scheduled check.`,
        });
      }
    } else {
      await boltApp.client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Approved by ${name}! Will send at 10am ET.`,
      });
    }

    logger.info(
      { digestId: digest.id, approvedBy: approverUserId },
      'Weekly digest approved',
    );
  }

  return true;
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

  // Check for weekly digest approval (white_check_mark on digest review message)
  if (reaction === 'white_check_mark') {
    const handled = await handleDigestApproval(reactingUserId, itemChannel, itemTs);
    if (handled) return;
  }

  // Check for weekly digest regeneration (🔄 on digest review message)
  if (reaction === 'arrows_counterclockwise') {
    const handled = await handleDigestRegenerate(reactingUserId, itemChannel, itemTs);
    if (handled) return;
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

  const startTime = Date.now();
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
      try {
        await threadService.addMessageFeedback(lastAssistantMessage.message_id, {
          rating: 5,
          rating_category: 'emoji_feedback',
          rating_notes: `User reacted with :${reaction}:`,
          rated_by: reactingUserId,
          rating_source: 'user',
        });
      } catch (error) {
        logger.error({ error, messageId: lastAssistantMessage.message_id }, 'Addie Bolt: Failed to save emoji feedback');
      }
      // Don't respond to general positive feedback
      return;
    } else {
      userInput = '[User reacted with ' + reaction + ' emoji as negative feedback]';
      // Record as negative feedback
      try {
        await threadService.addMessageFeedback(lastAssistantMessage.message_id, {
          rating: 1,
          rating_category: 'emoji_feedback',
          rating_notes: `User reacted with :${reaction}:`,
          rated_by: reactingUserId,
          rating_source: 'user',
        });
      } catch (error) {
        logger.error({ error, messageId: lastAssistantMessage.message_id }, 'Addie Bolt: Failed to save emoji feedback');
      }
      // Don't respond to general negative feedback
      return;
    }
  }

  // Log the reaction as a user message
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'user',
      content: userInput,
      content_sanitized: userInput,
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to save reaction message');
  }

  // Fetch conversation history from database for context
  const MAX_HISTORY_MESSAGES = 20;
  let conversationHistory: Array<{ user: string; text: string }> | undefined;
  let historyUnavailable = false;
  try {
    const previousMessages = await threadService.getThreadMessages(thread.thread_id);
    if (previousMessages.length > 0) {
      conversationHistory = previousMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .slice(-MAX_HISTORY_MESSAGES)
        .map(msg => ({
          user: msg.role === 'user' ? 'User' : 'Addie',
          text: msg.content_sanitized || msg.content,
          toolCalls: msg.tool_calls ?? undefined,
        }));

      if (conversationHistory.length > 0) {
        logger.debug(
          { threadId: thread.thread_id, messageCount: conversationHistory.length },
          'Addie Bolt: Loaded conversation history for reaction handler'
        );
      }
    }
  } catch (error) {
    logger.warn({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to fetch reaction conversation history');
    historyUnavailable = true;
  }

  // Fetch channel context (includes working group if channel is linked to one)
  let channelContext: ThreadContext | undefined;
  try {
    channelContext = await buildChannelContext(itemChannel);
  } catch (error) {
    logger.debug({ error, itemChannel }, 'Addie Bolt: Could not get channel context for reaction handler');
  }

  // Build per-request context for system prompt (pass channelContext so public channel guard is included)
  let { requestContext, memberContext } = await buildRequestContext(reactingUserId, channelContext);
  if (historyUnavailable) {
    requestContext += `\n\n${HISTORY_UNAVAILABLE_NOTE}`;
  }

  // Create user-scoped tools (pass channel context for working group auto-detection)
  const { tools: userTools, isAAOAdmin: userIsAdmin } = await createUserScopedTools(memberContext, reactingUserId, thread.thread_id, channelContext);

  // Admin users get higher iteration limit for bulk operations
  const processOptions = {
    ...(userIsAdmin ? { maxIterations: ADMIN_MAX_ITERATIONS } : {}),
    requestContext,
    slackUserId: reactingUserId,
    threadId: thread.thread_id,
  };

  // Process with Claude
  let response;
  try {
    response = await claudeClient.processMessage(userInput, conversationHistory, userTools, undefined, processOptions);
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
  const reactionGuarded = guardBareJsonEnvelope(response.text, { pathTag: 'reaction-response' });
  try {
    await client.chat.postMessage({
      channel: itemChannel,
      text: wrapUrlsForSlack(reactionGuarded.text),
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.error({ error }, 'Addie Bolt: Failed to send reaction response');
  }

  // Log assistant response with performance data
  try {
    await threadService.addMessage({
      thread_id: thread.thread_id,
      role: 'assistant',
      content: response.text,
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
    });
  } catch (error) {
    logger.error({ error, threadId: thread.thread_id }, 'Addie Bolt: Failed to log reaction response');
  }

  logger.info(
    { threadId: thread.thread_id, reaction, isConfirmation: isConfirmationRequest, latencyMs: Date.now() - startTime },
    'Addie Bolt: Processed reaction and responded'
  );
}
