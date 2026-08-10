/**
 * Addie Chat routes module
 *
 * Public chat API for web-based chat with Addie.
 * Stores conversation history for training purposes.
 */

import { Router, type Request, type Response } from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validate as uuidValidate } from "uuid";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import cors from "cors";
import { createLogger } from "../logger.js";
import { CachedPostgresStore } from "../middleware/pg-rate-limit-store.js";
import { optionalAuth } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { AddieClaudeClient, type AddieResponse, type RequestTools } from "../addie/claude-client.js";
import { sanitizeSpeakerName } from "../addie/prompts.js";
import { resolveUserTierFromDb } from "../addie/claude-cost-tracker.js";
import {
  sanitizeInput,
  validateOutput,
} from "../addie/security.js";
import { matchRuleIdFromMessage } from "../addie/home/builders/rules/prompt-rules.js";
import { recordPromptClicked } from "../db/addie-prompt-telemetry-db.js";
import {
  isKnowledgeReady,
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
  createSlackKnowledgeRequestTools,
  isSlackKnowledgeTool,
} from "../addie/mcp/knowledge-search.js";
import { ANONYMOUS_SAFE_KNOWLEDGE_TOOLS } from "../mcp/chat-tool.js";
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from "../addie/mcp/member-tools.js";
import {
  SI_HOST_TOOLS,
  createSiHostToolHandlers,
} from "../addie/mcp/si-host-tools.js";
import {
  ADCP_TOOLS,
  createAdcpToolHandlers,
} from "../addie/mcp/adcp-tools.js";
import {
  ESCALATION_TOOLS,
  createEscalationToolHandlers,
} from "../addie/mcp/escalation-tools.js";
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
  isWebUserAAOAdmin,
} from "../addie/mcp/admin-tools.js";
import {
  EVENT_READONLY_TOOLS,
  EVENT_ADMIN_TOOLS,
  createEventToolHandlers,
  EVENT_CREATOR_COMMITTEE_TYPES,
} from "../addie/mcp/event-tools.js";
import {
  MEETING_TOOLS,
  createMeetingToolHandlers,
} from "../addie/mcp/meeting-tools.js";
import {
  COLLABORATION_TOOLS,
  createCollaborationToolHandlers,
} from "../addie/mcp/collaboration-tools.js";
import {
  COMMITTEE_LEADER_TOOLS,
  createCommitteeLeaderToolHandlers,
} from "../addie/mcp/committee-leader-tools.js";
import {
  MOLTBOOK_TOOLS,
  createMoltbookToolHandlers,
} from "../addie/mcp/moltbook-tools.js";
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from "../addie/mcp/billing-tools.js";
import {
  CERTIFICATION_TOOLS,
  createCertificationToolHandlers,
  buildCertificationContext,
} from "../addie/mcp/certification-tools.js";
import * as certDb from "../db/certification-db.js";
import {
  SCHEMA_TOOLS,
  createSchemaToolHandlers,
} from "../addie/mcp/schema-tools.js";
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from "../addie/mcp/directory-tools.js";
import {
  BRAND_TOOLS,
  createBrandToolHandlers,
} from "../addie/mcp/brand-tools.js";
import {
  PROPERTY_TOOLS,
  createPropertyToolHandlers,
} from "../addie/mcp/property-tools.js";
import {
  IMAGE_TOOLS,
  createImageToolHandlers,
} from "../addie/mcp/image-tools.js";
import {
  AUTH_GRADER_TOOLS,
  createAuthGraderToolHandlers,
} from "../addie/mcp/auth-grader-tools.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";
import { siRetriever, type RetrievedSIAgent } from "../addie/services/si-retriever.js";
import { AddieModelConfig } from "../config/models.js";
import {
  getCertificationExperienceForClientRequest,
  getCertificationModuleExperience,
  recordCertificationExperienceEvent,
} from "../services/certification-experience.js";
import {
  getWebMemberContext,
  formatMemberContextForPrompt,
  type MemberContext,
} from "../addie/member-context.js";
import {
  getThreadService,
  type Thread,
  type ThreadContext,
} from "../addie/thread-service.js";
import { UsersDatabase } from "../db/users-db.js";
import { isRetriesExhaustedError } from "../utils/anthropic-retry.js";
import * as relationshipDb from "../db/relationship-db.js";
import * as personEvents from "../db/person-events-db.js";
import {
  ChatAttachmentValidationError,
  summarizeAttachmentsForMessage,
  validateChatAttachments,
} from "../addie/chat-attachments.js";
import {
  issueAnonymousSessionCapability,
  verifyAnonymousSessionCapability,
} from "./helpers/anonymous-session-capability.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ATTACHMENT_VALIDATION_CLIENT_MESSAGE =
  "Attachment could not be processed. Use PNG, JPEG, GIF, WebP, or PDF files under the size limits.";
const ADDIE_ANONYMOUS_OWNER_COOKIE = 'addie-anonymous-owner';
const ADDIE_ANONYMOUS_OWNER_AUDIENCE = 'addie-web-thread-owner';
const SI_ANONYMOUS_SESSION_AUDIENCE = 'si-session-owner';
const ANONYMOUS_OWNER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CHAT_MESSAGE_CHARS = 4_000;
export const EMPTY_ASSISTANT_RESPONSE_FALLBACK =
  "I hit a response delivery issue before I could finish. Please try again in a moment.";

const logger = createLogger("addie-chat-routes");

let claudeClient: AddieClaudeClient | null = null;
let initialized = false;

function readAnonymousThreadOwner(req: Request): string | null {
  const capability = verifyAnonymousSessionCapability(
    req.cookies?.[ADDIE_ANONYMOUS_OWNER_COOKIE],
    ADDIE_ANONYMOUS_OWNER_AUDIENCE,
  );
  return capability?.sub ?? null;
}

function ensureAnonymousThreadOwner(req: Request, res: Response): string {
  const existing = readAnonymousThreadOwner(req);
  if (existing) return existing;

  const ownerId = crypto.randomUUID();
  const capability = issueAnonymousSessionCapability(
    ADDIE_ANONYMOUS_OWNER_AUDIENCE,
    ownerId,
    ANONYMOUS_OWNER_TTL_MS,
  );
  res.cookie(ADDIE_ANONYMOUS_OWNER_COOKIE, capability, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: ANONYMOUS_OWNER_TTL_MS,
    path: '/api/addie/chat',
  });
  return ownerId;
}

export function canAccessWebThread(
  req: Request,
  thread: Pick<Thread, 'user_type' | 'user_id'>,
): boolean {
  if (thread.user_type === 'workos') {
    return !!req.user?.id && thread.user_id === req.user.id;
  }
  if (thread.user_type === 'anonymous' && thread.user_id) {
    return readAnonymousThreadOwner(req) === thread.user_id;
  }
  // Legacy anonymous rows without an owner capability fail closed.
  return false;
}

const WEB_FEEDBACK_CATEGORIES = new Set([
  'accuracy',
  'completeness',
  'helpfulness',
  'clarity',
  'tone',
  'session',
]);
const WEB_FEEDBACK_TAGS = new Set([
  'wrong_answer',
  'missing_info',
  'too_long',
  'too_short',
  'outdated',
  'off_topic',
]);
const MAX_FEEDBACK_TEXT_LENGTH = 2_000;

function parseOptionalFeedbackText(
  value: unknown,
  fieldName: string,
  maxLength = MAX_FEEDBACK_TEXT_LENGTH,
): { value?: string; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') return { error: `${fieldName} must be a string` };

  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.length > maxLength) {
    return { error: `${fieldName} must be ${maxLength} characters or fewer` };
  }
  return { value: trimmed };
}

/**
 * Anonymous users get directory tools only (fast DB lookups, public data).
 * Knowledge/doc search tools require login — Haiku can't reliably synthesize
 * multi-step research within the anonymous iteration limit.
 */

/**
 * Tools only available to authenticated users.
 * Built once at init and passed as per-request tools for authenticated sessions.
 */
let authenticatedOnlyTools: RequestTools | null = null;

const ANONYMOUS_MAX_ITERATIONS = 5;

// Sources the web client is permitted to assert. Voice / email / unknown are
// set server-side only (tavus.ts, email-conversation-handler.ts, bolt-app.ts).
const VALID_WEB_SOURCES = new Set<'typed' | 'cta_chip'>(['typed', 'cta_chip']);

export function ensureNonEmptyAssistantResponse(
  text: string | null | undefined,
): { text: string; usedFallback: boolean } {
  if (typeof text === 'string' && text.trim().length > 0) {
    return { text, usedFallback: false };
  }
  return { text: EMPTY_ASSISTANT_RESPONSE_FALLBACK, usedFallback: true };
}

/**
 * Merge per-request member tools with cached authenticated-only tools,
 * and select model + iteration limits based on auth status.
 */
export function buildTieredAccess(memberTools: RequestTools, isAuth: boolean, isCertification = false) {
  let requestTools = memberTools;
  if (isAuth && authenticatedOnlyTools) {
    // Per-request member tools (with memberContext) must override cached auth tools
    // (without memberContext) — spread member handlers LAST so they win on duplicates.
    // Deduplicate tools by name so the API doesn't receive duplicate definitions.
    const mergedHandlers = new Map([...authenticatedOnlyTools.handlers, ...memberTools.handlers]);
    const seen = new Set(memberTools.tools.map(t => t.name));
    const dedupedAuthTools = authenticatedOnlyTools.tools.filter(t => !seen.has(t.name));
    requestTools = {
      tools: [...dedupedAuthTools, ...memberTools.tools],
      handlers: mergedHandlers,
    };
  }
  const processOptions = isAuth
    ? (isCertification ? { modelOverride: AddieModelConfig.certification } : {})
    : { modelOverride: AddieModelConfig.anonymousChat, maxIterations: ANONYMOUS_MAX_ITERATIONS };
  const effectiveModel = isAuth
    ? (isCertification ? AddieModelConfig.certification : AddieModelConfig.chat)
    : AddieModelConfig.anonymousChat;
  return { requestTools, processOptions, effectiveModel };
}

/**
 * Initialize the chat client
 *
 * Anonymous users get Haiku with read-only directory tools.
 * Authenticated users get Sonnet with full tools (billing, schema, Slack, etc.).
 */
async function initializeChatClient(): Promise<void> {
  if (initialized) return;

  const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn("Addie Chat: No ANTHROPIC_API_KEY configured");
    return;
  }

  // Client defaults to Sonnet; anonymous requests override to Haiku per-request
  claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);

  // Initialize knowledge search
  await initializeKnowledgeSearch();

  // Register directory tools globally — available to all users (anonymous and authenticated).
  // These are fast DB lookups over public data (members, agents, publishers).
  const directoryHandlers = createDirectoryToolHandlers();
  for (const tool of DIRECTORY_TOOLS) {
    const handler = directoryHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Register search_members globally so anonymous users get the rich card UI.
  // The handler uses memberContext only for analytics attribution (null-safe).
  const anonMemberHandlers = createMemberToolHandlers(null);
  const searchMembersTool = MEMBER_TOOLS.find(t => t.name === 'search_members');
  const searchMembersHandler = anonMemberHandlers.get('search_members');
  if (searchMembersTool && searchMembersHandler) {
    claudeClient.registerTool(searchMembersTool, searchMembersHandler);
  }

  // Two handler maps: anonymous-scoped (for global registration — restricts
  // user-submitted resources and strips Addie-generated notes) and full
  // (for the authenticated-only set). The split happens at handler-creation
  // time because handler closures don't carry per-call scope.
  const anonymousKnowledgeHandlers = createKnowledgeToolHandlers({
    anonymous: true,
    slackAccess: { kind: 'public-only' },
  });
  const authedKnowledgeHandlers = createKnowledgeToolHandlers({
    slackAccess: { kind: 'public-only' },
  });

  // Register anonymous-safe knowledge tools globally — search_docs, get_doc,
  // search_repos, search_resources, get_recent_news. All read-only over public
  // content. Without these the anonymous chat falls back to in-prompt knowledge
  // and improvises when asked about specific spec mechanics. The MCP chat path
  // already exposes the same set; this aligns the web chat path with it.
  for (const tool of KNOWLEDGE_TOOLS) {
    if (!ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name)) continue;
    const handler = anonymousKnowledgeHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Build authenticated-only tools (cached, reused per request).
  // Includes: full knowledge surface, billing, schema, brand, property.
  const authTools: typeof KNOWLEDGE_TOOLS = [];
  const authHandlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Add ALL knowledge tool handlers to the authenticated set — including the
  // anonymous-safe names. This is the override path: globally-registered
  // anonymous-scoped handlers (set above) are shadowed for authenticated
  // requests because claude-client.processMessage merges per-request handlers
  // LAST (claude-client.ts:594, "last wins"). Result: anonymous gets the
  // restricted handler globally, authenticated users get the full handler
  // via this per-request override.
  for (const tool of KNOWLEDGE_TOOLS) {
    if (isSlackKnowledgeTool(tool)) continue;
    const handler = authedKnowledgeHandlers.get(tool.name);
    if (!handler) continue;
    if (ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name)) {
      // Tool definition is already on the global registry; only the handler
      // needs to override. Don't push to authTools — that would duplicate
      // the tool in the API request — only set the handler.
      authHandlers.set(tool.name, handler);
    } else {
      authTools.push(tool);
      authHandlers.set(tool.name, handler);
    }
  }

  // Billing tools (for membership signup assistance)
  const billingHandlers = createBillingToolHandlers();
  for (const tool of BILLING_TOOLS) {
    const handler = billingHandlers.get(tool.name);
    if (handler) {
      authTools.push(tool);
      authHandlers.set(tool.name, handler);
    }
  }

  // Schema tools (validate JSON, get schemas, list schemas)
  const schemaHandlers = createSchemaToolHandlers();
  for (const tool of SCHEMA_TOOLS) {
    const handler = schemaHandlers.get(tool.name);
    if (handler) {
      authTools.push(tool);
      authHandlers.set(tool.name, handler);
    }
  }

  // Directory tools are registered globally (above) — skip here.

  // Brand tools (research, resolve, save, list brands)
  const brandHandlers = createBrandToolHandlers();
  for (const tool of BRAND_TOOLS) {
    const handler = brandHandlers.get(tool.name);
    if (handler) {
      authTools.push(tool);
      authHandlers.set(tool.name, handler);
    }
  }

  // Property tools (resolve, save, list properties)
  const propertyHandlers = createPropertyToolHandlers();
  for (const tool of PROPERTY_TOOLS) {
    const handler = propertyHandlers.get(tool.name);
    if (handler) {
      authTools.push(tool);
      authHandlers.set(tool.name, handler);
    }
  }

  authenticatedOnlyTools = { tools: authTools, handlers: authHandlers };

  // Note: Member tools are registered per-request with user's actual context
  // This allows user-scoped tools to work correctly for authenticated users

  initialized = true;
  logger.info({
    // Use the registry as the source of truth — globally-registered tool count
    // drifts otherwise (e.g. if more tools graduate to anonymous access).
    anonymousTools: claudeClient.getRegisteredTools().length,
    authenticatedTools: authTools.length,
    anonymousModel: AddieModelConfig.anonymousChat,
    authenticatedModel: AddieModelConfig.chat,
  }, "Addie Chat: Initialized with tiered access");
}

/**
 * Get the initialized chat Claude client.
 * Ensures initialization has run before returning the client.
 */
export async function getChatClaudeClient(): Promise<AddieClaudeClient> {
  if (!initialized) {
    await initializeChatClient();
  }
  if (!claudeClient) {
    throw new Error('Chat Claude client not initialized — missing ANTHROPIC_API_KEY');
  }
  return claudeClient;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  message_id?: string;
  rating?: number | null;
  rating_category?: string | null;
  rating_notes?: string | null;
  feedback_tags?: string[] | null;
  improvement_suggestion?: string | null;
}

/**
 * Create Addie chat routes
 */
// Per-minute rate limiter for chat API
const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 messages per minute per IP
  store: new CachedPostgresStore('chat:'),
  message: { error: "Too many requests", message: "Please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Daily rate limiter for anonymous users only.
// Authenticated users bypass this entirely via the skip option.
// Prevents sustained token-draining attacks from anonymous IPs.
// NOTE: Must run AFTER chatRateLimiter so its RateLimit-* headers win
// (the client reads the daily remaining count, not the per-minute one).
const anonymousDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 50, // 50 messages per day for anonymous users
  store: new CachedPostgresStore('anon-daily:'),
  skip: (req) => !!(req as any).user?.id, // Authenticated users bypass
  keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
  message: {
    error: "Daily limit reached",
    message: "You've reached today's free message limit. Sign in for unlimited access.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Feedback does not invoke the model, so it needs a write-specific ceiling
// rather than sharing chat-message quota.
const feedbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  store: new CachedPostgresStore('chat-feedback:'),
  keyGenerator: (req) => (req as any).user?.id
    ? `user:${(req as any).user.id}`
    : `ip:${ipKeyGenerator(req.ip || '')}`,
  message: { error: 'Too many requests', message: 'Please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

/**
 * Validate conversation ID format (UUID v4)
 */
function isValidConversationId(id: string): boolean {
  return uuidValidate(id);
}

/**
 * Hash IP address for privacy (GDPR compliance)
 */
function hashIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  return crypto.createHash("sha256").update(ip).digest("hex").substring(0, 16);
}

export interface PreparedRequest {
  messageToProcess: string;
  requestContext: string;
  memberContext: MemberContext | null;
  requestTools: RequestTools;
  siRetrievalTimeMs: number | null;
  siAgents: RetrievedSIAgent[];
  hasCertificationContext: boolean;
  hasThreadCertificationContext: boolean;
  certificationModuleContext: { moduleId?: string };
  certificationProgress: certDb.LearnerProgress[];
  threadExternalId: string;
}

export function resolveThreadCertificationProgress(
  progress: Array<Pick<certDb.LearnerProgress, 'module_id' | 'status' | 'addie_thread_id' | 'completed_at'>>,
  threadExternalId: string,
  threadId?: string,
) {
  const matches = progress.filter(item =>
    Boolean(item.addie_thread_id)
    && (item.addie_thread_id === threadExternalId || item.addie_thread_id === threadId),
  );
  return matches.find(item => item.status === 'in_progress') ?? matches[0];
}

export async function resolveCompletionModuleId(
  execution: { tool_name: string; parameters?: Record<string, unknown> } | undefined,
  userId: string | null | undefined,
  threadContextModuleId: string | undefined,
): Promise<string | undefined> {
  const explicitModuleId = execution?.parameters?.module_id;
  if (typeof explicitModuleId === 'string') {
    return explicitModuleId.toUpperCase();
  }

  if (execution?.tool_name !== 'complete_certification_exam' || !userId) {
    return threadContextModuleId;
  }

  const attemptId = execution.parameters?.attempt_id;
  if (typeof attemptId !== 'string') {
    return threadContextModuleId;
  }

  // The exam tool accepts a module ID as a recovery shorthand. Otherwise use
  // the owned attempt as the authoritative source; its module can differ from
  // the thread's previously active teaching context.
  const normalizedAttemptId = attemptId.toUpperCase();
  if (/^[A-Z]{1,2}[0-9]+$/.test(normalizedAttemptId)) {
    return normalizedAttemptId;
  }
  if (!uuidValidate(attemptId)) {
    return threadContextModuleId;
  }

  const attempt = await certDb.getAttemptForUser(attemptId, userId);
  return attempt?.module_id?.toUpperCase() ?? threadContextModuleId;
}

interface SiSessionData {
  session_id: string;
  brand_name: string;
  brand_response: unknown;
  identity_shared: boolean;
  relationship: unknown;
  anonymous_access_token?: string;
}

function withSiAnonymousCapability(session: SiSessionData | null): SiSessionData | null {
  if (!session) return null;
  return {
    ...session,
    anonymous_access_token: issueAnonymousSessionCapability(
      SI_ANONYMOUS_SESSION_AUDIENCE,
      session.session_id,
    ),
  };
}

/**
 * Extract SI session data from tool executions if an SI session was started
 */
function extractSiSessionFromToolExecutions(
  toolExecutions: Array<{ tool_name: string; result?: unknown }> | undefined
): SiSessionData | null {
  if (!toolExecutions) return null;

  for (const exec of toolExecutions) {
    if (exec.tool_name === "connect_to_si_agent" && exec.result) {
      try {
        const result = typeof exec.result === "string" ? JSON.parse(exec.result) : exec.result;
        if (result.success && result.session_id) {
          return {
            session_id: result.session_id,
            brand_name: result.brand_name,
            brand_response: result.brand_response,
            identity_shared: result.identity_shared,
            relationship: result.relationship,
          };
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return null;
}

/**
 * Prepare a request with member context and per-request tools
 * Creates member tools and SI host tools with the user's actual context
 * Also retrieves relevant SI agents for RAG-style context injection
 */
export async function prepareRequestWithMemberTools(
  sanitizedInput: string,
  userId: string | undefined,
  threadExternalId: string,
  isAuthenticated: boolean,
  threadId?: string,
  selectedOrganizationId?: string | null,
): Promise<PreparedRequest> {
  const messageToProcess = sanitizedInput;
  let memberContext: MemberContext | null = null;
  let siRetrievalTimeMs: number | null = null;

  // Run member context fetch and SI retrieval in parallel
  const [memberContextResult, siRetrievalResult] = await Promise.all([
    // Get member context
    (async () => {
      try {
        if (userId) {
          return await getWebMemberContext(userId, selectedOrganizationId);
        }
        return null;
      } catch (error) {
        logger.warn({ error, userId }, "Addie Chat: Failed to get member context");
        return null;
      }
    })(),
    // Retrieve relevant SI agents
    siRetriever.retrieve(sanitizedInput),
  ]);

  memberContext = memberContextResult;
  siRetrievalTimeMs = siRetrievalResult.retrieval_time_ms;

  // Build per-request context for system prompt (member info, SI agents)
  const contextSections: string[] = [];

  if (memberContext) {
    const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
    if (memberContextText) {
      contextSections.push(memberContextText);
      logger.debug(
        { userId, hasContext: true, orgName: memberContext.organization?.name },
        "Addie Chat: Added member context"
      );
    }
  } else {
    const anonymousContext = { is_mapped: false, is_member: false, slack_linked: false };
    const memberContextText = formatMemberContextForPrompt(anonymousContext, 'web');
    if (memberContextText) {
      contextSections.push(memberContextText);
      logger.debug("Addie Chat: Added anonymous web context");
    }
  }

  // Include SI agent context if relevant agents were found
  if (siRetrievalResult.agents.length > 0) {
    const siContext = siRetriever.formatContext(siRetrievalResult.agents);
    contextSections.push(siContext);
    logger.debug(
      {
        agentCount: siRetrievalResult.agents.length,
        topAgents: siRetrievalResult.agents.map((a) => a.display_name),
        retrievalTimeMs: siRetrievalResult.retrieval_time_ms,
      },
      "Addie Chat: Injected SI agent context"
    );
  }

  // Add certification module state so Addie remembers active modules
  // even when conversation history is trimmed
  let hasCertificationContext = false;
  let hasThreadCertificationContext = false;
  let certificationModuleId: string | undefined;
  let certificationProgress: certDb.LearnerProgress[] = [];
  if (memberContext?.workos_user?.workos_user_id) {
    try {
      const progress = await certDb.getProgress(memberContext.workos_user.workos_user_id);
      certificationProgress = progress;
      const inProgress = progress.filter(p => p.status === 'in_progress');
      const threadProgress = resolveThreadCertificationProgress(progress, threadExternalId, threadId);
      const recentlyCompleted = threadProgress?.status === 'completed'
        && threadProgress.completed_at
        && Date.now() - new Date(threadProgress.completed_at).getTime() < 24 * 60 * 60 * 1000;
      certificationModuleId = threadProgress?.status === 'in_progress' || recentlyCompleted
        ? threadProgress.module_id
        : undefined;
      hasThreadCertificationContext = threadProgress?.status === 'in_progress';
      const certContext = await buildCertificationContext(inProgress, memberContext.workos_user.workos_user_id);
      if (certContext) {
        contextSections.push(certContext);
        hasCertificationContext = true;
      }
    } catch (error) {
      logger.warn({ error }, 'Addie Chat: Failed to get certification progress for context');
    }
  }

  const requestContext = contextSections.join('\n\n');
  const trainingModuleContext: { moduleId?: string } = {
    moduleId: certificationModuleId,
  };

  // Anonymous users get no per-request tools (saves tokens and prevents data leakage)
  if (!isAuthenticated) {
    return {
      messageToProcess,
      requestContext,
      memberContext: null,
      requestTools: { tools: [], handlers: new Map() },
      siRetrievalTimeMs,
      siAgents: siRetrievalResult.agents,
      hasCertificationContext: false,
      hasThreadCertificationContext: false,
      certificationModuleContext: trainingModuleContext,
      certificationProgress,
      threadExternalId,
    };
  }

  // Resolve linked Slack identity for tools that need it (DMs, attribution)
  const linkedSlackUserId = memberContext?.slack_user?.slack_user_id;

  // Create per-request tools (same tools as Slack, minus Slack-specific ones)
  // Re-register billing with memberContext so org-scoped operations work (overrides baseline)
  const allTools = [...MEMBER_TOOLS, ...SI_HOST_TOOLS, ...ADCP_TOOLS, ...ESCALATION_TOOLS, ...BILLING_TOOLS, ...IMAGE_TOOLS];
  const combinedHandlers = new Map([
    ...createMemberToolHandlers(memberContext, undefined, trainingModuleContext),
    ...createSiHostToolHandlers(() => memberContext, () => threadExternalId),
    ...createAdcpToolHandlers(memberContext, trainingModuleContext),
    ...createEscalationToolHandlers(memberContext, linkedSlackUserId, threadId),
    ...createBillingToolHandlers(memberContext),
    ...createImageToolHandlers(linkedSlackUserId, threadExternalId),
  ]);

  // Slack history is always request-scoped. A linked Slack identity may see
  // its allowed private channels; an authenticated-but-unlinked web user gets
  // an explicit public-only scope.
  const slackKnowledge = createSlackKnowledgeRequestTools(
    linkedSlackUserId
      ? { kind: 'slack-user', slackUserId: linkedSlackUserId }
      : { kind: 'public-only' },
  );
  allTools.push(...slackKnowledge.tools);
  for (const [name, handler] of slackKnowledge.handlers) {
    combinedHandlers.set(name, handler);
  }

  // Certification tools (for authenticated users)
  if (userId) {
    allTools.push(...CERTIFICATION_TOOLS);
    for (const [name, handler] of createCertificationToolHandlers(memberContext, {
      threadId: threadExternalId,
      trainingModuleContext,
    })) {
      combinedHandlers.set(name, handler);
    }
  }

  // Auth graders — RFC 9421 signing + OAuth handshake diagnosis. Authenticated
  // users only on the web path; signing grades spawn a child Node process and
  // both tools make outbound HTTP probes, so we keep them gated behind a
  // signed-in identity. (The Slack path in bolt-app.ts is always authenticated.)
  if (userId) {
    allTools.push(...AUTH_GRADER_TOOLS);
    for (const [name, handler] of createAuthGraderToolHandlers(userId)) {
      combinedHandlers.set(name, handler);
    }
  }

  // Permission-gated tools (for authenticated users)
  if (userId) {
    const workingGroupDb = new WorkingGroupDatabase();
    const [userIsAdmin, ledGroups] = await Promise.all([
      isWebUserAAOAdmin(userId),
      workingGroupDb.getCommitteesLedByUser(userId),
    ]);

    if (userIsAdmin) {
      allTools.push(...ADMIN_TOOLS);
      for (const [name, handler] of createAdminToolHandlers(memberContext)) {
        combinedHandlers.set(name, handler);
      }
    }

    // Event tools: readonly for all users; management tools for admins and committee leaders
    const eventHandlers = createEventToolHandlers(memberContext, undefined, userIsAdmin);
    allTools.push(...EVENT_READONLY_TOOLS);
    for (const tool of EVENT_READONLY_TOOLS) {
      const handler = eventHandlers.get(tool.name);
      if (handler) combinedHandlers.set(tool.name, handler);
    }

    const eventEligibleLedGroups = ledGroups.filter(group =>
      EVENT_CREATOR_COMMITTEE_TYPES.has(group.committee_type)
    );
    if (userIsAdmin || eventEligibleLedGroups.length > 0) {
      allTools.push(...EVENT_ADMIN_TOOLS);
      for (const tool of EVENT_ADMIN_TOOLS) {
        const handler = eventHandlers.get(tool.name);
        if (handler) combinedHandlers.set(tool.name, handler);
      }
    }

    // Meeting scheduling: admin or committee leader
    if (userIsAdmin || ledGroups.length > 0) {
      allTools.push(...MEETING_TOOLS);
      for (const [name, handler] of createMeetingToolHandlers(memberContext)) {
        combinedHandlers.set(name, handler);
      }
    }

    // Collaboration tools (DMs between members — needs Slack identity for sending)
    allTools.push(...COLLABORATION_TOOLS);
    for (const [name, handler] of createCollaborationToolHandlers(memberContext, linkedSlackUserId)) {
      combinedHandlers.set(name, handler);
    }

    // Committee leader tools (uses memberContext.workos_user for identity, Slack ID for fallback)
    allTools.push(...COMMITTEE_LEADER_TOOLS);
    for (const [name, handler] of createCommitteeLeaderToolHandlers(memberContext, linkedSlackUserId)) {
      combinedHandlers.set(name, handler);
    }
  }

  // Moltbook tools (for all users, if configured)
  if (process.env.MOLTBOOK_API_KEY) {
    allTools.push(...MOLTBOOK_TOOLS);
    for (const [name, handler] of Object.entries(createMoltbookToolHandlers())) {
      combinedHandlers.set(name, handler);
    }
  }

  const requestTools: RequestTools = {
    tools: allTools,
    handlers: combinedHandlers,
  };

  return {
    messageToProcess,
    requestContext,
    memberContext,
    requestTools,
    siRetrievalTimeMs,
    siAgents: siRetrievalResult.agents,
    hasCertificationContext,
    hasThreadCertificationContext,
    certificationModuleContext: trainingModuleContext,
    certificationProgress,
    threadExternalId,
  };
}

// CORS configuration for native apps (Tauri desktop, mobile)
const chatCorsOptions: cors.CorsOptions = {
  origin: [
    // Production domains
    'https://agenticadvertising.org',
    'https://www.agenticadvertising.org',
    // Tauri app origins
    'tauri://localhost',
    'https://tauri.localhost',
    // Local development (only in non-production)
    ...(process.env.NODE_ENV !== 'production' ? [/^http:\/\/localhost:\d+$/] : []),
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Conversation-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
};

export function createAddieChatRouter(options?: {
  chatClient?: Pick<AddieClaudeClient, 'processMessage' | 'processMessageStream'>;
}): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();
  const injectedChatClient = options?.chatClient;

  // Enable CORS for all API routes (for native app support)
  apiRouter.use(cors(chatCorsOptions));

  // Initialize client after server starts (deferred to avoid blocking startup with sync I/O)
  if (!injectedChatClient) {
    setTimeout(() => {
      initializeChatClient().catch((err) => {
        logger.error({ err }, "Failed to initialize Addie chat client");
      });
    }, 5000);
  }

  // =========================================================================
  // PAGE ROUTES (mounted at /chat)
  // =========================================================================

  // GET / - Serve the chat page (mounted at /chat, so this serves /chat)
  pageRouter.get("/", optionalAuth, (req, res) => {
    // Video call iframe needs camera, microphone, and autoplay permissions
    res.setHeader("Permissions-Policy", "camera=*, microphone=*, autoplay=*");
    serveHtmlWithConfig(req, res, "chat.html").catch((err) => {
      logger.error({ err }, "Error serving chat page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // API ROUTES (mounted at /api/addie/chat)
  // =========================================================================

  // POST /api/addie/chat - Send a message and get a response
  // optionalAuth runs first so rate limiters can check auth status
  apiRouter.post("/", optionalAuth, chatRateLimiter, anonymousDailyLimiter, async (req, res) => {
    const startTime = Date.now();
    const threadService = getThreadService();
    const activeChatClient = injectedChatClient ?? claudeClient;

    try {
      if ((!initialized && !injectedChatClient) || !activeChatClient) {
        return res.status(503).json({
          error: "Service unavailable",
          message: "Addie is not configured. Please set ANTHROPIC_API_KEY.",
        });
      }

      const { message, conversation_id, user_name, message_source: rawMessageSource, attachments: rawAttachments, organization_id } = req.body;
      const attachments = validateChatAttachments(rawAttachments);

      if (typeof message !== "string" || (!message.trim() && attachments.length === 0)) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > MAX_CHAT_MESSAGE_CHARS) {
        return res.status(413).json({ error: `Message exceeds ${MAX_CHAT_MESSAGE_CHARS} characters` });
      }
      const attachmentSummary = summarizeAttachmentsForMessage(attachments);
      const messageForStorage = message.trim()
        ? `${message.trim()}${attachmentSummary ? `\n\n${attachmentSummary}` : ''}`
        : attachmentSummary || "[Uploaded attachment]";

      // Sanitize input
      const inputValidation = sanitizeInput(messageForStorage);
      if (inputValidation.flagged) {
        logger.warn({ reason: inputValidation.reason }, "Addie Chat: Input flagged");
      }

      // Heuristic click telemetry: if the incoming message text matches a
      // known suggested-prompt verbatim, record a click against that rule.
      const matchedRuleId = matchRuleIdFromMessage(message.trim());
      if (matchedRuleId && req.user?.id) {
        void recordPromptClicked(req.user.id, matchedRuleId);
      }

      // Accept message_source from client (chip click vs typed); fall back to
      // heuristic detection so old clients without the field still tag correctly.
      const messageSource: 'typed' | 'cta_chip' =
        typeof rawMessageSource === 'string' && VALID_WEB_SOURCES.has(rawMessageSource as 'typed' | 'cta_chip')
          ? rawMessageSource as 'typed' | 'cta_chip'
          : matchedRuleId ? 'cta_chip' : 'typed';

      // Get or create thread using unified service
      // For web chat, the external_id is the conversation_id (UUID)
      // If no conversation_id provided, we'll generate a new one via the thread
      const impersonator = req.user?.impersonator;
      const userId = req.user?.id || null;
      // `user_name` from req.body is attacker-controlled on the anonymous web
      // path. Only honor it for authenticated requests; for everyone else
      // fall back to the WorkOS first name (auth) or undefined (anon).
      // sanitizeSpeakerName then strips brackets/control chars and caps
      // length so no name we accept can break out of the `[name] text`
      // prompt envelope downstream.
      const displayName = sanitizeSpeakerName(
        req.user ? (user_name || req.user.firstName) : null
      ) ?? null;

      // Build web-specific context
      const webContext: ThreadContext = {
        user_agent: req.get("user-agent"),
        ip_hash: hashIp(req.ip),
        referrer: req.get("referer"),
      };

      let thread;
      let externalId = conversation_id;

      if (!externalId) {
        // Create new thread - generate a new UUID as external_id
        externalId = crypto.randomUUID();
        const anonymousOwnerId = userId ? undefined : ensureAnonymousThreadOwner(req, res);
        thread = await threadService.getOrCreateThread({
          channel: 'web',
          external_id: externalId,
          user_type: userId ? 'workos' : 'anonymous',
          user_id: userId || anonymousOwnerId,
          user_display_name: displayName || undefined,
          context: webContext,
          impersonator_user_id: impersonator?.email,
          impersonation_reason: impersonator?.reason || undefined,
        });

        // Log impersonated conversation creation
        if (impersonator) {
          logger.info(
            { threadId: thread.thread_id, userId, impersonatorEmail: impersonator.email, reason: impersonator.reason },
            "Addie Chat: Created impersonated thread"
          );
        }
      } else {
        // Validate conversation ID format
        if (!isValidConversationId(externalId)) {
          return res.status(400).json({ error: "Invalid conversation ID format" });
        }
        // Get existing thread
        thread = await threadService.getThreadByExternalId('web', externalId);
        if (!thread || !canAccessWebThread(req, thread)) {
          return res.status(404).json({ error: "Conversation not found" });
        }
        if (req.user?.id && thread.user_type === 'anonymous') {
          const anonymousOwnerId = readAnonymousThreadOwner(req);
          thread = anonymousOwnerId
            ? await threadService.claimAnonymousThread(
                thread.thread_id, anonymousOwnerId, req.user.id, req.user.firstName ?? undefined,
              )
            : null;
          if (!thread) return res.status(404).json({ error: "Conversation not found" });
        }
      }

      // Get conversation history for context
      const threadMessages = await threadService.getThreadMessages(thread.thread_id, { limit: 100 });

      // Save user message
      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: messageForStorage,
        content_sanitized: inputValidation.sanitized,
        flagged: inputValidation.flagged,
        flag_reason: inputValidation.reason,
        user_id: userId || undefined,
        user_display_name: displayName || undefined,
        message_source: messageSource,
      });

      // Record inbound message in the relationship system
      if (userId) {
        try {
          const personId = await relationshipDb.resolvePersonId({ workos_user_id: userId });
          await relationshipDb.recordPersonMessage(personId, 'web');
          await relationshipDb.deriveSentiment(personId);
          await personEvents.recordEvent(personId, 'message_received', {
            channel: 'web',
            data: personEvents.buildMessageReceivedData(inputValidation.sanitized, 'web_chat'),
          });
        } catch {
          // Not all web users have person_relationships records — that's OK
        }
      }

      // Build context from history, passing tool calls as structured
      // data so they are reconstructed as proper tool_use/tool_result API blocks.
      // Token-aware trimming in processMessage handles length; no hard slice here.
      const contextMessages = threadMessages
        .filter((m) =>
          (m.role === 'user' || m.role === 'assistant')
          && m.delivery_status !== 'interrupted',
        )
        .map((m) => ({
          user: m.role === 'assistant' ? 'Addie' : (m.user_display_name || 'User'),
          text: m.content,
          toolCalls: m.tool_calls ?? undefined,
        }));

      // Build tiered access: anonymous gets Haiku + restricted tools,
      // authenticated gets Sonnet + full tools
      const isAuth = !!req.user;

      // Prepare message with member context and per-request tools
      const {
        messageToProcess,
        requestContext,
        requestTools: memberTools,
        hasThreadCertificationContext,
      } = await prepareRequestWithMemberTools(
        inputValidation.sanitized,
        req.user?.id,
        externalId,
        isAuth,
        thread.thread_id,
        typeof organization_id === 'string' ? organization_id : null
      );
      const { requestTools, processOptions, effectiveModel } = buildTieredAccess(
        memberTools,
        isAuth,
        hasThreadCertificationContext,
      );

      // Cost-cap scope (#2790 / #2945 f/u). Authenticated callers key
      // off the WorkOS user ID and resolve their tier from
      // AAO team/admin + subscription status — AAO team users are
      // uncapped, paying members land on member_paid ($25/day), free
      // accounts on member_free ($5). Anonymous
      // callers key off a hashed IP; the client-generated
      // `externalId` alone was a bypass vector (an attacker could
      // rotate it to get a fresh budget per request). The per-IP 50
      // msg/day limiter above bounds rotation within a single host.
      const authedScope = req.user?.id
        ? { userId: req.user.id, tier: await resolveUserTierFromDb(req.user.id) }
        : null;

      // Process with Claude
      let response;
      try {
        response = await activeChatClient.processMessage(messageToProcess, contextMessages, requestTools, undefined, {
          ...processOptions,
          requestContext,
          threadId: thread.thread_id,
          userDisplayName: displayName || undefined,
          currentSpeakerName: displayName || undefined,
          inputAttachments: attachments,
          costScope: authedScope
            ? authedScope
            : { userId: `anon:${hashIp(req.ip)}`, tier: 'anonymous' as const },
        });
      } catch (error) {
        // Provide user-friendly error message based on error type
        let errorMessage: string;
        if (error instanceof Error && error.message.includes('prompt is too long')) {
          logger.warn({ error }, "Addie Chat: Conversation exceeded context limit");
          errorMessage = "This conversation is too long for me to process. Please start a new conversation and I'll be happy to help!";
        } else {
          logger.error({ error }, "Addie Chat: Error processing message");
          errorMessage = isRetriesExhaustedError(error)
            ? `${error.reason}. Please try again in a moment.`
            : "I'm sorry, I encountered an error. Please try again.";
        }

        response = {
          text: errorMessage,
          tools_used: [],
          tool_executions: [],
          flagged: true,
          flag_reason: `Error: ${error instanceof Error ? error.message : "Unknown"}`,
        };
      }

      const normalizedResponse = ensureNonEmptyAssistantResponse(response.text);
      if (normalizedResponse.usedFallback) {
        logger.warn(
          {
            threadId: thread.thread_id,
            toolsUsed: response.tools_used,
            toolExecutions: response.tool_executions?.length ?? 0,
          },
          "Addie Chat: Empty assistant response replaced with fallback"
        );
        response.text = normalizedResponse.text;
        response.flagged = true;
        response.flag_reason = response.flag_reason || 'Empty assistant response';
      }

      // Validate output
      const outputValidation = validateOutput(normalizedResponse.text);

      const latencyMs = Date.now() - startTime;

      // Save assistant response with full execution details
      const assistantMessage = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: outputValidation.sanitized,
        tools_used: response.tools_used.length > 0 ? response.tools_used : undefined,
        tool_calls: response.tool_executions.length > 0
          ? response.tool_executions.map((exec) => ({
              name: exec.tool_name,
              input: exec.parameters,
              result: exec.result,
              duration_ms: exec.duration_ms,
            }))
          : undefined,
        model: effectiveModel,
        latency_ms: latencyMs,
        tokens_input: response.usage?.input_tokens,
        tokens_output: response.usage?.output_tokens,
        flagged: outputValidation.flagged || response.flagged,
        flag_reason: outputValidation.reason || response.flag_reason,
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
      });

      // Check for SI session started (from connect_to_si_agent tool)
      const siSession = withSiAnonymousCapability(
        extractSiSessionFromToolExecutions(response.tool_executions),
      );

      res.json({
        response: outputValidation.sanitized,
        conversation_id: externalId, // Return external_id as conversation_id for API compatibility
        message_id: assistantMessage.message_id, // Now returns UUID instead of integer
        tools_used: response.tools_used,
        tool_executions: response.tool_executions,
        timing: response.timing,
        usage: response.usage,
        latency_ms: latencyMs,
        si_session: siSession,
      });
    } catch (error) {
      if (error instanceof ChatAttachmentValidationError) {
        logger.warn({ reason: error.message }, "Addie Chat: Invalid attachment");
        return res.status(error.statusCode).json({
          error: "Invalid attachment",
          message: ATTACHMENT_VALIDATION_CLIENT_MESSAGE,
        });
      }
      logger.error({ err: error }, "Addie Chat: Error handling message");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to process message",
      });
    }
  });

  // GET /api/addie/chat/status - Check if Addie is ready
  // NOTE: This route must come BEFORE /:conversationId to avoid being matched as a conversation ID
  apiRouter.get("/status", (req, res) => {
    res.json({
      ready: (!!injectedChatClient || (initialized && claudeClient !== null)) && isKnowledgeReady(),
      knowledge_ready: isKnowledgeReady(),
    });
  });

  // POST /api/addie/chat/stream - Stream a response using Server-Sent Events
  // NOTE: This route must come BEFORE /:conversationId to avoid being matched as a conversation ID
  apiRouter.post("/stream", optionalAuth, chatRateLimiter, anonymousDailyLimiter, async (req, res) => {
    const startTime = Date.now();
    const threadService = getThreadService();
    const activeChatClient = injectedChatClient ?? claudeClient;

    // Track connection state
    let connectionClosed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let claimedTurn: { threadId: string; clientRequestId: string; leaseId: string } | null = null;
    let terminalResponse: AddieResponse | undefined;

    // Handle client disconnect
    res.on("close", () => {
      connectionClosed = true;
      logger.debug("Addie Chat Stream: Client disconnected");
    });

    // Helper to send SSE events (checks if connection is still open)
    const sendEvent = (event: string, data: unknown) => {
      if (connectionClosed) return;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        logger.warn({ err }, "Addie Chat Stream: Failed to write to response");
        connectionClosed = true;
      }
    };

    try {
      if ((!initialized && !injectedChatClient) || !activeChatClient) {
        return res.status(503).json({
          error: "Service unavailable",
          message: "Addie is not configured.",
        });
      }

      const {
        message,
        conversation_id,
        user_name,
        message_source: rawMessageSourceStream,
        attachments: rawAttachmentsStream,
        organization_id,
        client_request_id,
        retry,
      } = req.body;
      const attachments = validateChatAttachments(rawAttachmentsStream);
      const clientRequestId = typeof client_request_id === 'string' ? client_request_id : null;
      const retryRequested = retry === true;

      if (clientRequestId && !uuidValidate(clientRequestId)) {
        return res.status(400).json({ error: 'client_request_id must be a valid UUID' });
      }
      if (retryRequested && !clientRequestId) {
        return res.status(400).json({ error: 'client_request_id is required when retry is true' });
      }

      if (typeof message !== "string" || (!message.trim() && attachments.length === 0)) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > MAX_CHAT_MESSAGE_CHARS) {
        return res.status(413).json({ error: `Message exceeds ${MAX_CHAT_MESSAGE_CHARS} characters` });
      }
      const attachmentSummary = summarizeAttachmentsForMessage(attachments);
      const messageForStorage = message.trim()
        ? `${message.trim()}${attachmentSummary ? `\n\n${attachmentSummary}` : ''}`
        : attachmentSummary || "[Uploaded attachment]";

      // Sanitize input
      const inputValidation = sanitizeInput(messageForStorage);
      if (inputValidation.flagged) {
        logger.warn({ reason: inputValidation.reason }, "Addie Chat Stream: Input flagged");
      }

      // Heuristic click telemetry: if the incoming message text matches a
      // known suggested-prompt verbatim, record a click against that rule.
      const matchedRuleId = matchRuleIdFromMessage(message.trim());
      if (matchedRuleId && req.user?.id) {
        void recordPromptClicked(req.user.id, matchedRuleId);
      }

      const messageSourceStream: 'typed' | 'cta_chip' =
        typeof rawMessageSourceStream === 'string' && VALID_WEB_SOURCES.has(rawMessageSourceStream as 'typed' | 'cta_chip')
          ? rawMessageSourceStream as 'typed' | 'cta_chip'
          : matchedRuleId ? 'cta_chip' : 'typed';

      // Get or create thread
      const impersonator = req.user?.impersonator;
      const userId = req.user?.id || null;
      // `user_name` from req.body is attacker-controlled on the anonymous web
      // path. Only honor it for authenticated requests; for everyone else
      // fall back to the WorkOS first name (auth) or undefined (anon).
      // sanitizeSpeakerName then strips brackets/control chars and caps
      // length so no name we accept can break out of the `[name] text`
      // prompt envelope downstream.
      const displayName = sanitizeSpeakerName(
        req.user ? (user_name || req.user.firstName) : null
      ) ?? null;

      const webContext: ThreadContext = {
        user_agent: req.get("user-agent"),
        ip_hash: hashIp(req.ip),
        referrer: req.get("referer"),
      };

      let thread;
      let externalId = conversation_id;

      if (!externalId) {
        externalId = crypto.randomUUID();
        const anonymousOwnerId = userId ? undefined : ensureAnonymousThreadOwner(req, res);
        thread = await threadService.getOrCreateThread({
          channel: 'web',
          external_id: externalId,
          user_type: userId ? 'workos' : 'anonymous',
          user_id: userId || anonymousOwnerId,
          user_display_name: displayName || undefined,
          context: webContext,
          impersonator_user_id: impersonator?.email,
          impersonation_reason: impersonator?.reason || undefined,
        });
      } else {
        if (!isValidConversationId(externalId)) {
          return res.status(400).json({ error: "Invalid conversation ID format" });
        }
        thread = await threadService.getThreadByExternalId('web', externalId);
        if (!thread || !canAccessWebThread(req, thread)) {
          return res.status(404).json({ error: "Conversation not found" });
        }
        if (req.user?.id && thread.user_type === 'anonymous') {
          const anonymousOwnerId = readAnonymousThreadOwner(req);
          thread = anonymousOwnerId
            ? await threadService.claimAnonymousThread(
                thread.thread_id, anonymousOwnerId, req.user.id, req.user.firstName ?? undefined,
              )
            : null;
          if (!thread) return res.status(404).json({ error: "Conversation not found" });
        }
      }

      const requestMessages = clientRequestId
        ? await threadService.getMessagesByClientRequestId(thread.thread_id, clientRequestId)
        : [];
      const existingUserMessage = requestMessages.find(m => m.role === 'user');
      const completedAssistantMessage = [...requestMessages]
        .reverse()
        .find(m => m.role === 'assistant' && m.delivery_status === 'completed');

      if (existingUserMessage && existingUserMessage.content !== messageForStorage) {
        return res.status(409).json({
          error: 'client_request_id conflict',
          message: 'That retry identifier belongs to a different message. Please send this as a new turn.',
        });
      }
      if (retryRequested && !existingUserMessage) {
        return res.status(409).json({
          error: 'Original turn not found',
          message: 'The original turn is no longer available to retry. Please send it as a new message.',
        });
      }

      // The message uniqueness constraint prevents duplicate storage; this
      // lease prevents duplicate model/tool execution while a turn is active.
      if (!completedAssistantMessage && clientRequestId) {
        const claim = await threadService.claimClientTurn(
          thread.thread_id,
          clientRequestId,
          retryRequested,
        );
        if (claim.state !== 'claimed') {
          const messages = claim.state === 'completed'
            ? await threadService.getMessagesByClientRequestId(thread.thread_id, clientRequestId)
            : [];
          const completed = [...messages].reverse().find(
            m => m.role === 'assistant' && m.delivery_status === 'completed',
          );
          if (completed) {
            return res.status(409).json({
              error: 'turn_already_completed',
              message: 'This reply has already completed. Reload the conversation to view it.',
            });
          }
          return res.status(409).json({
            error: claim.state === 'processing' ? 'turn_in_progress' : 'turn_not_retryable',
            message: claim.state === 'processing'
              ? 'This reply is still being generated. Please wait a moment and reload.'
              : 'Only an interrupted reply can be continued with this retry identifier.',
          });
        }
        claimedTurn = { threadId: thread.thread_id, clientRequestId, leaseId: claim.leaseId! };
      }

      // Do not commit the SSE response until ownership has been checked.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (!connectionClosed) res.write(': keep-alive\n\n');
        const turn = claimedTurn;
        if (turn) {
          void threadService.renewClientTurnLease(
            turn.threadId,
            turn.clientRequestId,
            turn.leaseId,
          ).catch(error => logger.error({ error }, 'Failed to renew chat turn lease'));
        }
      }, 15_000);

      // Send conversation_id immediately so client can track it
      sendEvent("meta", { conversation_id: externalId });

      // A browser may retry after losing the final SSE packet even though the
      // assistant response committed. Replay the authoritative stored result
      // instead of sampling the model or executing tools again.
      if (completedAssistantMessage) {
        const certification = userId && clientRequestId
          ? await getCertificationExperienceForClientRequest(userId, clientRequestId)
          : null;
        sendEvent('text', { text: completedAssistantMessage.content, replayed: true });
        sendEvent('done', {
          conversation_id: externalId,
          message_id: completedAssistantMessage.message_id,
          replayed: true,
          certification,
        });
        res.end();
        return;
      }

      // Get conversation history
      const threadMessages = await threadService.getThreadMessages(thread.thread_id, { limit: 100 });

      // Save user message
      if (!existingUserMessage) {
        await threadService.addMessage({
          thread_id: thread.thread_id,
          role: 'user',
          content: messageForStorage,
          content_sanitized: inputValidation.sanitized,
          flagged: inputValidation.flagged,
          flag_reason: inputValidation.reason,
          user_id: userId || undefined,
          user_display_name: displayName || undefined,
          message_source: messageSourceStream,
          client_request_id: clientRequestId || undefined,
        });
      }

      // Record inbound message in the relationship system
      if (userId && !existingUserMessage) {
        try {
          const personId = await relationshipDb.resolvePersonId({ workos_user_id: userId });
          await relationshipDb.recordPersonMessage(personId, 'web');
          await relationshipDb.deriveSentiment(personId);
          await personEvents.recordEvent(personId, 'message_received', {
            channel: 'web',
            data: personEvents.buildMessageReceivedData(
              inputValidation.sanitized,
              'web_chat_stream'
            ),
          });
        } catch {
          // Not all web users have person_relationships records
        }
      }

      // Build context messages, passing tool calls as structured data
      // Token-aware trimming in processMessageStream handles length; no hard slice here.
      const contextMessages = threadMessages
        .filter((m) =>
          (m.role === 'user' || m.role === 'assistant')
          && (m.delivery_status !== 'interrupted'
            || (retryRequested && m.client_request_id === clientRequestId)),
        )
        .map((m) => ({
          user: m.role === 'assistant' ? 'Addie' : (m.user_display_name || 'User'),
          text: m.content,
          toolCalls: m.tool_calls ?? undefined,
        }));

      // Build tiered access: anonymous gets Haiku + restricted tools,
      // authenticated gets Sonnet + full tools
      const isAuth = !!req.user;

      // Prepare message with member context and per-request tools
      const messageForModel = retryRequested
        ? 'Continue the interrupted reply from the stored tool results. Do not repeat any completed action. Give the learner the result and next step.'
        : inputValidation.sanitized;
      const {
        messageToProcess,
        requestContext,
        requestTools: memberTools,
        siAgents,
        hasThreadCertificationContext: hasThreadCertCtx,
        certificationModuleContext,
        certificationProgress,
      } = await prepareRequestWithMemberTools(
        messageForModel,
        req.user?.id,
        externalId,
        isAuth,
        thread.thread_id,
        typeof organization_id === 'string' ? organization_id : null
      );
      const { requestTools, processOptions, effectiveModel } = buildTieredAccess(memberTools, isAuth, hasThreadCertCtx);
      const preTurnCertification = userId && certificationModuleContext.moduleId
        ? await getCertificationModuleExperience(userId, certificationModuleContext.moduleId)
        : null;
      const completionReserveEligible = hasThreadCertCtx
        && (retryRequested
          || preTurnCertification?.status === 'evidence_complete'
          || preTurnCertification?.checkpoint?.current_phase === 'assessment');
      if (userId && hasThreadCertCtx) {
        await recordCertificationExperienceEvent({
          userId,
          moduleId: certificationModuleContext.moduleId,
          threadId: externalId,
          eventType: 'chat_turn_started',
          clientRequestId,
          metadata: { model: effectiveModel, retry: retryRequested },
        });
        if (retryRequested) {
          await recordCertificationExperienceEvent({
            userId,
            moduleId: certificationModuleContext.moduleId,
            threadId: externalId,
            eventType: 'chat_turn_retry_requested',
            clientRequestId,
            metadata: { model: effectiveModel },
          });
        }
      }

      // Stream the response — certification sessions get more conversation history
      let fullText = '';
      let response: AddieResponse | undefined;
      const toolsUsed: string[] = [];

      // Cost cap — see matching block in the non-streaming path.
      const streamAuthedScope = req.user?.id
        ? { userId: req.user.id, tier: await resolveUserTierFromDb(req.user.id) }
        : null;

      for await (const event of activeChatClient.processMessageStream(messageToProcess, contextMessages, requestTools, {
        ...processOptions,
        ...(completionReserveEligible ? { maxIterations: 3, maxMessages: 12 } : {}),
        requestContext,
        threadId: thread.thread_id,
        userDisplayName: displayName || undefined,
        currentSpeakerName: displayName || undefined,
        inputAttachments: attachments,
        ...(streamAuthedScope
          ? { costScope: {
              ...streamAuthedScope,
              ...(completionReserveEligible ? { certificationReserveUsd: 1 } : {}),
            } }
          : externalId
            ? { costScope: { userId: `anon:${externalId}`, tier: 'anonymous' as const } }
            : {}),
      })) {
        // Deliberately keep consuming after a disconnect. The completed result
        // is persisted and the same client_request_id can replay it on reconnect.

        if (event.type === 'text') {
          fullText += event.text;
          sendEvent("text", { text: event.text });
        } else if (event.type === 'tool_start') {
          toolsUsed.push(event.tool_name);
          sendEvent("tool_start", { tool_name: event.tool_name });
        } else if (event.type === 'tool_end') {
          sendEvent("tool_end", { tool_name: event.tool_name, is_error: event.is_error });
        } else if (event.type === 'retry') {
          sendEvent("retry", {
            attempt: event.attempt,
            maxRetries: event.maxRetries,
            reason: event.reason,
          });
        } else if (event.type === 'stream_error') {
          // Mid-stream upstream failure after partial delivery (#4797). Save a
          // non-displayable audit attempt (including completed tool results),
          // then give the browser an idempotent continuation affordance. The
          // partial prose is deliberately excluded from future history.
          logger.warn(
            { reason: event.reason, deltasBeforeError: event.deltasBeforeError, fullTextLength: fullText.length },
            'Addie Chat Stream: Stream interrupted mid-reply — discarding partial turn'
          );
          const moduleId = certificationModuleContext.moduleId;
          const certification = userId && moduleId
            ? await getCertificationModuleExperience(userId, moduleId)
            : null;
          await threadService.addMessage({
            thread_id: thread.thread_id,
            role: 'assistant',
            content: 'Reply interrupted before completion. The learner can safely retry this turn.',
            tools_used: event.tool_executions.map(execution => execution.tool_name),
            tool_calls: event.tool_executions.map(execution => ({
              name: execution.tool_name,
              input: execution.parameters,
              result: execution.result,
              duration_ms: execution.duration_ms,
              is_error: execution.is_error,
            })),
            model: effectiveModel,
            flagged: true,
            flag_reason: `stream_interrupted: ${event.reason}`,
            client_request_id: clientRequestId || undefined,
            delivery_status: 'interrupted',
            client_turn_lease_id: claimedTurn?.leaseId,
            finalize_client_turn_status: claimedTurn ? 'interrupted' : undefined,
          });
          claimedTurn = null;
          if (userId && moduleId) {
            await recordCertificationExperienceEvent({
              userId,
              moduleId,
              threadId: externalId,
              eventType: 'chat_turn_interrupted',
              clientRequestId,
              metadata: {
                reason: event.reason,
                tools_executed: event.tool_executions.map(execution => execution.tool_name),
                model: effectiveModel,
              },
            });
          }
          sendEvent("stream_error", {
            reason: event.reason,
            deltasBeforeError: event.deltasBeforeError,
            recoverable: true,
            certification,
          });
          res.end();
          return;
        } else if (event.type === 'done') {
          response = event.response;
          terminalResponse = event.response;
        } else if (event.type === 'error') {
          if (claimedTurn) {
            await threadService.addMessage({
              thread_id: claimedTurn.threadId,
              role: 'assistant',
              content: 'Reply interrupted before completion. The learner can safely retry this turn.',
              flagged: true,
              flag_reason: `stream_interrupted: ${event.error}`,
              client_request_id: claimedTurn.clientRequestId,
              delivery_status: 'interrupted',
              client_turn_lease_id: claimedTurn.leaseId,
              finalize_client_turn_status: 'interrupted',
            });
            claimedTurn = null;
          }
          sendEvent("stream_error", { error: event.error, recoverable: true });
          res.end();
          return;
        }
      }

      if (!response) {
        const moduleId = certificationModuleContext.moduleId;
        const certification = userId && moduleId
          ? await getCertificationModuleExperience(userId, moduleId)
          : null;
        await threadService.addMessage({
          thread_id: thread.thread_id,
          role: 'assistant',
          content: 'Reply interrupted before completion. The learner can safely retry this turn.',
          tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
          model: effectiveModel,
          flagged: true,
          flag_reason: 'stream_interrupted: ended_without_done',
          client_request_id: clientRequestId || undefined,
          delivery_status: 'interrupted',
          client_turn_lease_id: claimedTurn?.leaseId,
          finalize_client_turn_status: claimedTurn ? 'interrupted' : undefined,
        });
        claimedTurn = null;
        if (userId && moduleId) {
          await recordCertificationExperienceEvent({
            userId,
            moduleId,
            threadId: externalId,
            eventType: 'chat_turn_interrupted',
            clientRequestId,
            metadata: { reason: 'ended_without_done', model: effectiveModel },
          });
        }
        sendEvent('stream_error', {
          reason: 'Reply ended before completion',
          recoverable: true,
          certification,
        });
        res.end();
        return;
      }

      const finalStreamText = fullText.trim() ? fullText : response?.text;
      const normalizedStream = ensureNonEmptyAssistantResponse(finalStreamText);
      if (normalizedStream.usedFallback) {
        logger.warn(
          {
            threadId: thread.thread_id,
            toolsUsed,
            toolExecutions: response?.tool_executions?.length ?? 0,
          },
          "Addie Chat Stream: Empty assistant response replaced with fallback"
        );
        if (!fullText.trim()) {
          sendEvent("text", { text: normalizedStream.text });
        }
        if (response) {
          response.flagged = true;
          response.flag_reason = response.flag_reason || 'Empty assistant response';
        }
      }
      fullText = normalizedStream.text;

      // Validate output
      const outputValidation = validateOutput(fullText);
      const latencyMs = Date.now() - startTime;

      // Save assistant response - use tool_executions from response which has duration_ms
      const assistantMessage = await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'assistant',
        content: outputValidation.sanitized,
        tools_used: toolsUsed.length > 0 ? toolsUsed : undefined,
        tool_calls: response?.tool_executions && response.tool_executions.length > 0
          ? response.tool_executions.map((exec) => ({
              name: exec.tool_name,
              input: exec.parameters,
              result: exec.result,
              duration_ms: exec.duration_ms,
            }))
          : undefined,
        model: effectiveModel,
        latency_ms: latencyMs,
        tokens_input: response?.usage?.input_tokens,
        tokens_output: response?.usage?.output_tokens,
        flagged: outputValidation.flagged || response?.flagged,
        flag_reason: outputValidation.reason || response?.flag_reason,
        timing: response?.timing ? {
          system_prompt_ms: response.timing.system_prompt_ms,
          total_llm_ms: response.timing.total_llm_ms,
          total_tool_ms: response.timing.total_tool_execution_ms,
          iterations: response.timing.iterations,
        } : undefined,
        tokens_cache_creation: response?.usage?.cache_creation_input_tokens,
        tokens_cache_read: response?.usage?.cache_read_input_tokens,
        active_rule_ids: response?.active_rule_ids,
        config_version_id: response?.config_version_id,
        client_request_id: clientRequestId || undefined,
        delivery_status: 'completed',
        client_turn_lease_id: claimedTurn?.leaseId,
        finalize_client_turn_status: claimedTurn ? 'completed' : undefined,
      });
      claimedTurn = null;

      const completionExecution = response?.tool_executions?.find(execution =>
        execution.tool_name === 'complete_certification_module'
        || execution.tool_name === 'complete_certification_exam');
      const activeModuleId = await resolveCompletionModuleId(
        completionExecution,
        userId,
        certificationModuleContext.moduleId,
      );
      const preCompletionProgress = activeModuleId
        ? certificationProgress.find(item => item.module_id === activeModuleId)
        : undefined;
      const certification = userId && activeModuleId
        ? await getCertificationModuleExperience(userId, activeModuleId)
        : null;
      if (userId && activeModuleId) {
        // A module can begin during this turn, so it was not present in the
        // pre-model member context. Backfill the matching start event once the
        // tool has bound the module to the thread.
        if (!hasThreadCertCtx) {
          await recordCertificationExperienceEvent({
            userId,
            moduleId: activeModuleId,
            threadId: externalId,
            eventType: 'chat_turn_started',
            clientRequestId,
            metadata: { model: effectiveModel, module_started_during_turn: true },
          });
        }
        const capacityBlocked = response?.flag_reason === 'cost_cap_exceeded';
        await recordCertificationExperienceEvent({
          userId,
          moduleId: activeModuleId,
          threadId: externalId,
          eventType: capacityBlocked ? 'capacity_blocked' : 'chat_turn_completed',
          clientRequestId,
          metadata: { model: effectiveModel, latency_ms: latencyMs },
        });
        if (response?.capacity?.certification_reserve_used) {
          await recordCertificationExperienceEvent({
            userId,
            moduleId: activeModuleId,
            threadId: externalId,
            eventType: 'completion_reserve_used',
            clientRequestId,
            metadata: { model: effectiveModel },
          });
        }
        if (certification?.status === 'evidence_complete') {
          await recordCertificationExperienceEvent({
            userId,
            moduleId: activeModuleId,
            threadId: externalId,
            eventType: 'module_evidence_complete',
            clientRequestId,
            metadata: { model: effectiveModel },
          });
        }
        // Tool invocation alone is not success: completion tools return normal
        // explanatory text when a server-side gate rejects the attempt.
        if (completionExecution
            && certification?.status === 'completed'
            && preCompletionProgress?.status !== 'completed'
            && preCompletionProgress?.status !== 'tested_out') {
          const completedAt = new Date().toISOString();
          await recordCertificationExperienceEvent({
            userId,
            moduleId: activeModuleId,
            threadId: externalId,
            eventType: 'module_completed',
            clientRequestId,
            metadata: { completed_at: completedAt, model: effectiveModel },
          });
          if (certification?.credential.state === 'issued') {
            await recordCertificationExperienceEvent({
              userId,
              moduleId: activeModuleId,
              threadId: externalId,
              eventType: 'credential_issued',
              clientRequestId,
              metadata: { module_completed_at: completedAt, model: effectiveModel },
            });
          } else if (certification?.credential.state === 'processing') {
            await recordCertificationExperienceEvent({
              userId,
              moduleId: activeModuleId,
              threadId: externalId,
              eventType: 'credential_processing',
              clientRequestId,
              metadata: { module_completed_at: completedAt, model: effectiveModel },
            });
          } else if (certification?.credential.state === 'action_required') {
            await recordCertificationExperienceEvent({
              userId,
              moduleId: activeModuleId,
              threadId: externalId,
              eventType: 'credential_action_required',
              clientRequestId,
              metadata: { module_completed_at: completedAt, model: effectiveModel },
            });
          }
        }
        if (!completionExecution
            && certification?.credential.state === 'issued'
            && preTurnCertification?.credential.state !== 'issued') {
          await recordCertificationExperienceEvent({
            userId,
            moduleId: activeModuleId,
            threadId: externalId,
            eventType: 'credential_issued',
            clientRequestId,
            metadata: {
              resolved_previous_state: preTurnCertification?.credential.state ?? null,
              model: effectiveModel,
            },
          });
        }
      }

      // Check for SI session started (from connect_to_si_agent tool)
      const siSession = withSiAnonymousCapability(
        extractSiSessionFromToolExecutions(response?.tool_executions),
      );

      // Send done event with final metadata
      // Include available SI agents only if no session was started (for CTA buttons)
      sendEvent("done", {
        conversation_id: externalId,
        message_id: assistantMessage.message_id,
        tools_used: toolsUsed,
        timing: response?.timing,
        usage: response?.usage,
        latency_ms: latencyMs,
        certification,
        si_session: siSession,
        si_agents: !siSession && siAgents.length > 0 ? siAgents.map(a => ({
          slug: a.slug,
          display_name: a.display_name,
          tagline: a.tagline,
        })) : undefined,
      });

      res.end();
    } catch (error) {
      logger.error({ err: error }, "Addie Chat Stream: Error handling message");
      if (claimedTurn) {
        try {
          await threadService.addMessage({
            thread_id: claimedTurn.threadId,
            role: 'assistant',
            content: 'Reply interrupted before completion. The learner can safely retry this turn.',
            tools_used: terminalResponse?.tool_executions?.map(execution => execution.tool_name),
            tool_calls: terminalResponse?.tool_executions?.map(execution => ({
              name: execution.tool_name,
              input: execution.parameters,
              result: execution.result,
              duration_ms: execution.duration_ms,
              is_error: execution.is_error,
            })),
            flagged: true,
            flag_reason: 'stream_interrupted: route_error',
            client_request_id: claimedTurn.clientRequestId,
            delivery_status: 'interrupted',
            client_turn_lease_id: claimedTurn.leaseId,
            finalize_client_turn_status: 'interrupted',
          });
          claimedTurn = null;
        } catch (statusError) {
          logger.error({ statusError }, 'Failed to release interrupted chat turn lease');
        }
      }
      if (!res.headersSent) {
        if (error instanceof ChatAttachmentValidationError) {
          return res.status(error.statusCode).json({ error: ATTACHMENT_VALIDATION_CLIENT_MESSAGE });
        }
        return res.status(500).json({ error: "Internal server error" });
      }
      if (error instanceof ChatAttachmentValidationError) {
        logger.warn({ reason: error.message }, "Addie Chat Stream: Invalid attachment");
        sendEvent("error", { error: ATTACHMENT_VALIDATION_CLIENT_MESSAGE });
      } else {
        sendEvent("stream_error", { error: "Internal server error", recoverable: true });
      }
      res.end();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  // POST /api/addie/chat/:conversationId/feedback - Submit feedback on a message
  apiRouter.post("/:conversationId/feedback", optionalAuth, feedbackRateLimiter, async (req, res) => {
    const threadService = getThreadService();

    try {
      const { conversationId } = req.params;

      // Validate conversation ID format
      if (!isValidConversationId(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation ID format" });
      }

      const {
        message_id,
        rating,
        rating_category,
        feedback_text,
        feedback_tags,
        improvement_suggestion,
      } = req.body;

      // message_id is now a UUID string
      if (!message_id || typeof message_id !== "string" || !uuidValidate(message_id)) {
        return res.status(400).json({ error: "message_id must be a valid UUID" });
      }

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "rating must be an integer between 1 and 5" });
      }

      const parsedCategory = parseOptionalFeedbackText(rating_category, 'rating_category', 32);
      if (parsedCategory.error) return res.status(400).json({ error: parsedCategory.error });
      if (parsedCategory.value && !WEB_FEEDBACK_CATEGORIES.has(parsedCategory.value)) {
        return res.status(400).json({ error: "rating_category is not supported" });
      }

      const parsedFeedbackText = parseOptionalFeedbackText(feedback_text, 'feedback_text');
      if (parsedFeedbackText.error) return res.status(400).json({ error: parsedFeedbackText.error });

      const parsedSuggestion = parseOptionalFeedbackText(improvement_suggestion, 'improvement_suggestion');
      if (parsedSuggestion.error) return res.status(400).json({ error: parsedSuggestion.error });

      let validatedTags: string[] | undefined;
      if (feedback_tags !== undefined && feedback_tags !== null) {
        if (!Array.isArray(feedback_tags) || feedback_tags.length > WEB_FEEDBACK_TAGS.size) {
          return res.status(400).json({ error: "feedback_tags must be an array of supported tags" });
        }
        if (feedback_tags.some((tag) => typeof tag !== 'string' || !WEB_FEEDBACK_TAGS.has(tag))) {
          return res.status(400).json({ error: "feedback_tags contains an unsupported tag" });
        }
        validatedTags = [...new Set(feedback_tags)];
      }

      // A missing and an inaccessible conversation deliberately share a response
      // so the endpoint cannot be used to enumerate conversation capabilities.
      const thread = await threadService.getThreadByExternalId('web', conversationId);
      if (!thread || !canAccessWebThread(req, thread)) {
        return res.status(404).json({ error: "Feedback target not found" });
      }

      // The service scopes the update to both IDs, preventing a message UUID
      // from another thread from being substituted after this authorization.
      const updated = await threadService.addMessageFeedback(thread.thread_id, message_id, {
        rating,
        rating_category: parsedCategory.value,
        rating_notes: parsedFeedbackText.value,
        feedback_tags: validatedTags,
        improvement_suggestion: parsedSuggestion.value,
        rated_by: req.user?.id || "anonymous",
        rating_source: 'user',
      });

      if (!updated) {
        logger.warn({ conversationId, message_id }, "Addie Chat: Feedback target not found");
        return res.status(404).json({ error: "Feedback target not found" });
      }

      logger.info(
        { conversationId, message_id, rating, rating_category: parsedCategory.value },
        "Addie Chat: Feedback submitted"
      );

      res.json({ success: true, message: "Feedback submitted" });
    } catch (error) {
      logger.error({ err: error }, "Addie Chat: Error submitting feedback");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to submit feedback",
      });
    }
  });

  // GET /api/addie/chat/threads - List user's conversation threads
  // NOTE: This route must come BEFORE /:conversationId to avoid being matched as a conversation ID
  apiRouter.get("/threads", optionalAuth, async (req, res) => {
    const threadService = getThreadService();
    const usersDb = new UsersDatabase();

    try {
      // Require authentication for thread listing
      if (!req.user) {
        return res.status(401).json({
          error: "Authentication required",
          message: "Please log in to view your conversations",
        });
      }

      const parsedLimit = parseInt(req.query.limit as string);
      const limit = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 20, 1), 50);

      // Look up user's linked Slack account
      const user = await usersDb.getUser(req.user.id);
      const slackUserId = user?.primary_slack_user_id || null;

      // Get user's threads across all channels (web + linked Slack)
      const threads = await threadService.getUserCrossChannelThreads(req.user.id, slackUserId, limit);

      // Map to API response format
      const conversations = threads.map((t) => ({
        conversation_id: t.external_id,
        channel: t.channel,
        title: t.title || t.first_user_message?.slice(0, 50) || "New conversation",
        message_count: t.message_count,
        last_message_at: t.last_message_at,
        preview: t.last_assistant_message?.slice(0, 100),
      }));

      res.json({
        conversations,
        total: conversations.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Addie Chat: Error listing threads");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to list conversations",
      });
    }
  });

  // GET /api/addie/chat/:conversationId - Get conversation history
  // Supports ?channel=slack for loading Slack threads
  apiRouter.get("/:conversationId", optionalAuth, async (req, res) => {
    const threadService = getThreadService();
    const usersDb = new UsersDatabase();

    try {
      const { conversationId } = req.params;
      const channel = (req.query.channel as string) || 'web';

      // Validate channel
      if (channel !== 'web' && channel !== 'slack' && channel !== 'video') {
        return res.status(400).json({ error: "Invalid channel" });
      }

      // Validate conversation ID format based on channel
      if (channel === 'web') {
        if (!isValidConversationId(conversationId)) {
          return res.status(400).json({ error: "Invalid conversation ID format" });
        }
      } else if (channel === 'slack') {
        // Slack external_id format: channel_id:thread_ts (e.g., C01234ABC:1234567890.123456)
        const slackIdPattern = /^[A-Z0-9]{9,12}:\d+\.\d{6}$/;
        if (!slackIdPattern.test(conversationId)) {
          return res.status(400).json({ error: "Invalid Slack conversation ID format" });
        }
      } else if (channel === 'video') {
        const videoIdPattern = /^addie-[0-9a-f-]{36}$/;
        if (!videoIdPattern.test(conversationId)) {
          return res.status(400).json({ error: "Invalid video conversation ID format" });
        }
      }

      // Get thread by external_id
      const thread = await threadService.getThreadByExternalId(channel, conversationId);
      if (!thread) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Web threads use the same owner check as message and feedback writes.
      if (channel === 'web') {
        if (!canAccessWebThread(req, thread)) {
          return res.status(404).json({ error: "Conversation not found" });
        }
      } else if (req.user) {
        let authorized = false;

        if (thread.user_type === 'workos' && thread.user_id === req.user.id) {
          authorized = true;
        } else if (thread.user_type === 'slack' && channel === 'slack') {
          // For Slack threads, verify the user's linked Slack account matches
          const user = await usersDb.getUser(req.user.id);
          if (user?.primary_slack_user_id === thread.user_id) {
            authorized = true;
          }
        }

        if (!authorized) {
          return res.status(404).json({ error: "Conversation not found" });
        }
      } else {
        // Anonymous users cannot view threads
        return res.status(401).json({
          error: "Authentication required",
          message: "Please log in to view conversations",
        });
      }

      const limitText = typeof req.query.limit === 'string' ? req.query.limit : '';
      const offsetText = typeof req.query.offset === 'string' ? req.query.offset : '';
      const requestedLimit = /^\d+$/.test(limitText) ? Number(limitText) : NaN;
      const requestedOffset = /^\d+$/.test(offsetText) ? Number(offsetText) : NaN;
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
      const offset = Number.isSafeInteger(requestedOffset) ? Math.min(requestedOffset, 10_000) : 0;

      const [threadMessages, recoverableTurn] = await Promise.all([
        threadService.getThreadMessages(thread.thread_id, { limit, offset }),
        channel === 'web' ? threadService.getRecoverableClientTurn(thread.thread_id) : Promise.resolve(null),
      ]);
      const messages: ConversationMessage[] = threadMessages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.delivery_status !== 'interrupted')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          message_id: m.message_id,
          rating: m.rating,
          rating_category: m.rating_category,
          rating_notes: m.rating_notes,
          feedback_tags: m.feedback_tags,
          improvement_suggestion: m.improvement_suggestion,
        }));

      res.json({
        conversation_id: conversationId,
        channel,
        user_name: thread.user_display_name,
        message_count: thread.message_count,
        limit,
        offset,
        messages,
        recoverable_turn: recoverableTurn ? {
          client_request_id: recoverableTurn.client_request_id,
          message: recoverableTurn.content,
          message_source: recoverableTurn.message_source ?? 'typed',
        } : null,
        read_only: channel === 'slack' || channel === 'video',
      });
    } catch (error) {
      logger.error({ err: error }, "Addie Chat: Error fetching conversation");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch conversation",
      });
    }
  });

  return { pageRouter, apiRouter };
}
