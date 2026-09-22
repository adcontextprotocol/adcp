import { responseProviderId, responseProviderModel } from '../addie/response-provider-policy.js';
import { responseClient } from '../addie/response-client.js';
import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createLogger } from "../logger.js";
import { AddieClaudeClient, type AddieResponse, type RequestTools, type StreamEvent } from "../addie/claude-client.js";
import {
  type AddieRouter,
  type ExecutionPlan,
  type RoutingContext,
} from "../addie/router.js";
import {
  createProductionRouter,
  LUNA_VOICE_ROUTER_PRIMARY_DEADLINE_MS,
} from "../addie/router-runtime.js";
import { selectBoundedRoutedToolSets } from "../addie/slack-tool-selection.js";
import { sanitizeSpeakerName } from "../addie/prompts.js";
import {
  checkCostCap,
  resolveUserTierFromDb,
} from "../addie/claude-cost-tracker.js";
import {
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
  createSlackKnowledgeRequestTools,
  isSlackKnowledgeTool,
} from "../addie/mcp/knowledge-search.js";
import {
  DIRECTORY_TOOLS,
  createDirectoryToolHandlers,
} from "../addie/mcp/directory-tools.js";
import {
  BRAND_TOOLS,
  createBrandToolHandlers,
} from "../addie/mcp/brand-tools.js";
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from "../addie/mcp/member-tools.js";
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from "../addie/mcp/billing-tools.js";
import {
  ESCALATION_TOOLS,
  createEscalationToolHandlers,
} from "../addie/mcp/escalation-tools.js";
import {
  ADCP_TOOLS,
  createAdcpToolHandlers,
} from "../addie/mcp/adcp-tools.js";
import {
  ADMIN_TOOLS,
  createAdminToolHandlers,
} from "../addie/mcp/admin-tools.js";
import { isAuthenticatedUserAAOAdmin, AAOAdminLookupUnavailableError, type AAOAdminPrincipal } from "../addie/admin-status-lookup.js";
import { captureVoiceAuthorization, deriveVoiceCallbackTurnId, issueVoiceCallbackBinding, isVoiceSessionOwner, persistVoiceCallbackBinding, resolveVoiceCallback, resolveVoiceAuthorization, VoiceAuthorizationUnavailableError } from "../addie/voice-authorization.js";
import { respondToAdminAuthorizationError } from "../auth/admin-authorization-response.js";
import {
  EVENT_READONLY_TOOLS,
  EVENT_ADMIN_TOOLS,
  createEventToolHandlers,
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
  SI_HOST_TOOLS,
  createSiHostToolHandlers,
} from "../addie/mcp/si-host-tools.js";
import {
  SCHEMA_TOOLS,
  createSchemaToolHandlers,
} from "../addie/mcp/schema-tools.js";
import {
  PROPERTY_TOOLS,
  createPropertyToolHandlers,
} from "../addie/mcp/property-tools.js";
import { AddieModelConfig } from "../config/models.js";
import { CachedPostgresStore } from "../middleware/pg-rate-limit-store.js";
import { sanitizeInput } from "../addie/security.js";
import { getThreadService, type ThreadService } from "../addie/thread-service.js";
import {
  blockCheckpointedToolReplays,
  buildToolResultCheckpoint,
  reserveToolIntentCheckpoint,
  type StoredToolCall,
} from "../addie/stream-tool-checkpoints.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  getWebMemberContext,
  formatMemberContextForPrompt,
  type MemberContext,
} from "../addie/member-context.js";
import { buildAuthoritativeTemporalContext } from "../addie/temporal-context.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";
import {
  boundedTrimmedTavusSetting,
  buildTavusConversationalContext,
  buildTavusThreadContext,
  buildTavusVoiceUserMessage,
  createTavusSessionGuidance,
  extractTavusText,
  readTavusSessionGuidance,
  sanitizeTavusDisplayName,
  TAVUS_SESSION_GUIDANCE_POLICY,
  TAVUS_SETTING_LIMITS,
  type TavusRawMessage,
} from "../services/tavus-conversational-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("tavus-routes");

let claudeClient: AddieClaudeClient | null = null;
let tavusRouter: TavusVoiceRouter | null = null;
let initPromise: Promise<void> | null = null;

type TavusVoiceRouter = Pick<AddieRouter, 'quickMatch' | 'route'>;
type TavusVoiceClient = Pick<AddieClaudeClient, 'processMessageStream'>
  & Partial<Pick<AddieClaudeClient, 'getRegisteredTools' | 'forkForGeminiDirect'>>;

async function initializeTavusClient(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn("Tavus: No ANTHROPIC_API_KEY configured");
      return;
    }
    claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.voice);
    tavusRouter = createProductionRouter(
      process.env.OPENAI_API_KEY?.trim(),
      undefined,
      LUNA_VOICE_ROUTER_PRIMARY_DEADLINE_MS,
    ).router;
    await initializeKnowledgeSearch();
    const knowledgeHandlers = createKnowledgeToolHandlers({
      slackAccess: { kind: 'public-only' },
    });
    for (const tool of KNOWLEDGE_TOOLS.filter((tool) => !isSlackKnowledgeTool(tool))) {
      const handler = knowledgeHandlers.get(tool.name);
      if (handler) claudeClient.registerTool(tool, handler);
    }
    const directoryHandlers = createDirectoryToolHandlers();
    for (const tool of DIRECTORY_TOOLS) {
      const handler = directoryHandlers.get(tool.name);
      if (handler) claudeClient.registerTool(tool, handler);
    }
    const brandHandlers = createBrandToolHandlers();
    for (const tool of BRAND_TOOLS) {
      const handler = brandHandlers.get(tool.name);
      if (handler) claudeClient.registerTool(tool, handler);
    }
    logger.info("Tavus: Initialized Claude client (baseline: knowledge + directory + brand; per-request: full user-scoped tools)");
  })().catch((err) => {
    // Clear so the next request can retry after a transient init failure
    logger.error({ err }, "Tavus: Initialization failed, will retry on next request");
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * Validates the Bearer token sent by Tavus's LLM layer.
 * Fails closed — if TAVUS_LLM_SECRET is not configured, all requests are rejected.
 * Uses HMAC comparison to avoid timing attacks regardless of token length.
 */
function validateLlmSecret(req: Request): boolean {
  const secret = process.env.TAVUS_LLM_SECRET;
  if (!secret) {
    logger.warn("Tavus: TAVUS_LLM_SECRET not configured — rejecting LLM request");
    return false;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  const key = Buffer.from("tavus-token-comparison");
  const expected = crypto.createHmac("sha256", key).update(secret).digest();
  const actual = crypto.createHmac("sha256", key).update(token).digest();
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Build user-scoped tools for a voice call, matching the web chat tool set.
 * This gives voice Addie the same capabilities as chat Addie.
 */
export async function buildVoiceRequestTools(
  userId: string,
  threadId: string,
  adminPrincipal: AAOAdminPrincipal,
): Promise<{
  requestTools: RequestTools;
  requestContext: string;
  memberContext: MemberContext | null;
  isAAOAdmin: boolean;
}> {
  let memberContext: MemberContext | null = null;
  try {
    memberContext = await getWebMemberContext(userId, undefined, adminPrincipal);
  } catch (error) {
    if (error instanceof AAOAdminLookupUnavailableError) throw error;
    logger.warn({ error, userId }, "Tavus: Failed to get member context");
  }

  // Format member context for system prompt
  const contextSections: string[] = [buildAuthoritativeTemporalContext(memberContext)];
  if (memberContext) {
    const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
    if (memberContextText) contextSections.push(memberContextText);
  }

  // Resolve linked Slack identity early — needed by escalation, collaboration, and committee tools
  const linkedSlackUserId = memberContext?.slack_user?.slack_user_id;

  // Build per-request tools (mirrors addie-chat.ts prepareRequestWithMemberTools)
  const allTools = [...MEMBER_TOOLS, ...SI_HOST_TOOLS, ...ADCP_TOOLS, ...ESCALATION_TOOLS, ...BILLING_TOOLS];
  const combinedHandlers = new Map([
    ...createMemberToolHandlers(memberContext, undefined, undefined, undefined, adminPrincipal),
    ...createSiHostToolHandlers(() => memberContext, () => threadId),
    ...createAdcpToolHandlers(memberContext),
    ...createEscalationToolHandlers(memberContext, linkedSlackUserId, threadId),
    ...createBillingToolHandlers(memberContext),
  ]);

  const slackKnowledge = createSlackKnowledgeRequestTools(
    linkedSlackUserId
      ? { kind: 'slack-user', slackUserId: linkedSlackUserId }
      : { kind: 'public-only' },
  );
  allTools.push(...slackKnowledge.tools);
  for (const [name, handler] of slackKnowledge.handlers) {
    combinedHandlers.set(name, handler);
  }

  // Schema tools
  allTools.push(...SCHEMA_TOOLS);
  for (const [name, handler] of createSchemaToolHandlers()) {
    combinedHandlers.set(name, handler);
  }

  // Property tools
  allTools.push(...PROPERTY_TOOLS);
  for (const [name, handler] of createPropertyToolHandlers()) {
    combinedHandlers.set(name, handler);
  }

  // Permission-gated tools
  const workingGroupDb = new WorkingGroupDatabase();
  const [userIsAdmin, ledGroups] = await Promise.all([
    isAuthenticatedUserAAOAdmin(adminPrincipal),
    workingGroupDb.getCommitteesLedByUser(adminPrincipal.authWorkosUserId ?? adminPrincipal.id),
  ]);

  // Event tools: readonly for all users, admin tools for admins only
  const eventHandlers = createEventToolHandlers(memberContext, undefined, userIsAdmin);
  allTools.push(...EVENT_READONLY_TOOLS);
  for (const tool of EVENT_READONLY_TOOLS) {
    const handler = eventHandlers.get(tool.name);
    if (handler) combinedHandlers.set(tool.name, handler);
  }

  if (userIsAdmin) {
    allTools.push(...ADMIN_TOOLS);
    for (const [name, handler] of createAdminToolHandlers(memberContext)) {
      combinedHandlers.set(name, handler);
    }
    allTools.push(...EVENT_ADMIN_TOOLS);
    for (const tool of EVENT_ADMIN_TOOLS) {
      const handler = eventHandlers.get(tool.name);
      if (handler) combinedHandlers.set(tool.name, handler);
    }
  }

  if (userIsAdmin || ledGroups.length > 0) {
    allTools.push(...MEETING_TOOLS);
    for (const [name, handler] of createMeetingToolHandlers(memberContext, undefined, undefined, adminPrincipal)) {
      combinedHandlers.set(name, handler);
    }
  }

  allTools.push(...COLLABORATION_TOOLS);
  for (const [name, handler] of createCollaborationToolHandlers(memberContext, linkedSlackUserId)) {
    combinedHandlers.set(name, handler);
  }

  allTools.push(...COMMITTEE_LEADER_TOOLS);
  for (const [name, handler] of createCommitteeLeaderToolHandlers(memberContext, linkedSlackUserId)) {
    combinedHandlers.set(name, handler);
  }

  if (process.env.MOLTBOOK_API_KEY) {
    allTools.push(...MOLTBOOK_TOOLS);
    for (const [name, handler] of Object.entries(createMoltbookToolHandlers())) {
      combinedHandlers.set(name, handler);
    }
  }

  return {
    requestTools: { tools: allTools, handlers: combinedHandlers },
    requestContext: contextSections.join('\n\n'),
    memberContext,
    isAAOAdmin: userIsAdmin,
  };
}

export interface RoutedTavusVoiceTools {
  requestTools: RequestTools;
  selectedToolSets: string[];
  allowedToolNames: string[];
  unavailableHint: string;
}

/**
 * Select the request-scoped voice capability surface for an authenticated
 * direct response. This owns only provider-neutral routing and exact
 * definition/handler pairing; Tavus delivery, SSE, transcripts, billing, and
 * conversation lifecycle remain at the route boundary.
 */
export async function selectRoutedTavusVoiceTools(input: {
  message: string;
  memberContext: MemberContext | null;
  threadId: string;
  isAAOAdmin: boolean;
  requestTools: RequestTools;
  router: TavusVoiceRouter | null;
  /** Globally registered definitions whose handlers were paired at registration time. */
  globalToolNames?: readonly string[];
  threadMessages?: string[];
}): Promise<RoutedTavusVoiceTools> {
  let plan: ExecutionPlan | null = null;
  const routerAvailable = input.router !== null;

  if (input.router) {
    const routingContext: RoutingContext = {
      message: input.message,
      source: 'dm',
      memberContext: input.memberContext,
      isThread: true,
      isAAOAdmin: input.isAAOAdmin,
      threadMessages: input.threadMessages,
    };
    plan = input.router.quickMatch(routingContext)
      ?? await input.router.route(routingContext);
  }

  const definitions = new Map(input.requestTools.tools.map((tool) => [tool.name, tool]));
  const globalToolNames = new Set(input.globalToolNames ?? []);
  // web_search is provider-managed and deliberately has no custom handler.
  // Global registrations were paired at startup; request-local tools must be
  // paired at this boundary before their schemas can reach the model.
  const isToolAvailable = (name: string) => name === 'web_search'
    || ((definitions.has(name) || globalToolNames.has(name))
      && (input.requestTools.handlers.has(name) || globalToolNames.has(name)));
  const selection = selectBoundedRoutedToolSets({
    plan,
    routerAvailable,
    source: 'dm',
    isAdmin: input.isAAOAdmin,
    isToolAvailable,
  });
  const matchedToolNames = selection.allowedToolNames.filter(isToolAvailable);
  const matched = new Set(matchedToolNames);

  return {
    requestTools: {
      tools: input.requestTools.tools.filter((tool) => matched.has(tool.name)),
      handlers: new Map(
        [...input.requestTools.handlers].filter(([name]) => matched.has(name)),
      ),
    },
    selectedToolSets: selection.selectedToolSets,
    // Keep provider-managed web_search in the client allowlist even though it
    // has no custom handler. The client scopes global tools with this list.
    allowedToolNames: selection.allowedToolNames,
    unavailableHint: selection.unavailableHint,
  };
}

// All LLM requests come from Tavus's infrastructure (same IP),
// so the limit must accommodate multiple concurrent video calls.
const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  store: new CachedPostgresStore("tavus-llm:"),
  keyGenerator: (req) => ipKeyGenerator(req.ip || ""),
  message: { error: { message: "Too many requests" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit — each session call creates billable Tavus infrastructure.
// Keyed by user ID (auth required) with IP fallback.
const sessionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: new CachedPostgresStore("tavus-session:"),
  keyGenerator: (req) => (req as Request & { user?: { id: string } }).user?.id || ipKeyGenerator(req.ip || ""),
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// End-session cap — generous relative to session creation (sessionRateLimiter: 5/min)
// but bounded so a single user cannot hammer the Tavus API key.
const endRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  store: new CachedPostgresStore("tavus-end:"),
  keyGenerator: (req) => (req as Request & { user?: { id: string } }).user?.id || ipKeyGenerator(req.ip || ""),
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

async function admitVoiceCallbackTurn(input: {
  res: Response;
  thread: { thread_id: string; external_id: string; context?: Record<string, unknown> | null };
  messages: readonly TavusRawMessage[];
}): Promise<
  | { state: 'claimed'; threadService: ThreadService; clientRequestId: string; leaseId: string }
  | { state: 'completed'; threadService: ThreadService; clientRequestId: string; content: string }
  | null
> {
  const { res, thread, messages } = input;
  const threadId = thread.thread_id;
  const clientRequestId = deriveVoiceCallbackTurnId({
    threadId,
    externalId: thread.external_id,
    providerConversationId: String(thread.context?.tavus_conversation_id),
    messages,
  });
  const threadService = getThreadService();
  let claim = await threadService.claimClientTurn(threadId, clientRequestId, false).catch((error) => {
    logger.error({ error, threadId }, 'Tavus: Voice turn claim unavailable');
    return null;
  });
  if (!claim) {
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice turn authorization is temporarily unavailable. Please try again.' } });
    return null;
  }
  // The non-retry probe reports both live and expired processing rows as
  // `processing`. The retry SQL reclaims only interrupted or expired rows, so
  // this second atomic probe recovers a crashed worker without stealing a live
  // lease.
  if (claim.state === 'not_retryable' || claim.state === 'processing') {
    claim = await threadService.claimClientTurn(threadId, clientRequestId, true).catch((error) => {
      logger.error({ error, threadId }, 'Tavus: Voice turn retry claim unavailable');
      return null;
    });
    if (!claim) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice turn authorization is temporarily unavailable. Please try again.' } });
      return null;
    }
  }

  if (claim.state === 'claimed') {
    return { state: 'claimed', threadService, clientRequestId, leaseId: claim.leaseId! };
  }
  if (claim.state === 'completed') {
    const completedMessages = await threadService.getMessagesByClientRequestId(threadId, clientRequestId).catch((error) => {
      logger.error({ error, threadId }, 'Tavus: Completed voice turn receipt unavailable');
      return null;
    });
    const completed = completedMessages && [...completedMessages].reverse().find(
      (message) => message.role === 'assistant' && message.delivery_status === 'completed',
    );
    if (!completed) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice turn receipt is temporarily unavailable. Please try again.' } });
      return null;
    }
    return { state: 'completed', threadService, clientRequestId, content: completed.content };
  }

  res.status(409).json({
    error: {
      code: 'voice_turn_in_progress',
      message: 'This voice turn is already being processed. Please retry shortly.',
    },
  });
  return null;
}

function replayCompletedVoiceTurn(res: Response, clientRequestId: string, content: string): void {
  const replayId = `chatcmpl-${clientRequestId.replace(/-/g, '').slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const replayChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    res.write(`data: ${JSON.stringify({
      id: replayId,
      object: 'chat.completion.chunk',
      created,
      model: 'addie',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  };
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Addie-Client-Turn-Id', clientRequestId);
  replayChunk({ role: 'assistant', content: '' });
  replayChunk({ content, replayed: true });
  replayChunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

export function createTavusRouter(options?: {
  /** Deterministic test seam; production uses the initialized voice client. */
  voiceClient?: TavusVoiceClient;
  /** An explicit null exercises the safe router-unavailable fallback. */
  router?: TavusVoiceRouter | null;
  /** Deterministic test seam for a renewal racing a mutation reservation. */
  leaseRenewalScheduler?: (renew: () => Promise<void>) => () => void;
}) {
  // Page router: serves GET /video and GET /video/lab.
  // Both routes go through serveHtmlWithConfig so the global app config and
  // csrf.js (which patches fetch to attach the X-CSRF-Token header) get
  // injected. Without csrf.js, POSTs to /api/addie/video/session are rejected
  // by the CSRF middleware.
  const pageRouter = Router();
  pageRouter.get("/", optionalAuth, async (req, res) => {
    res.setHeader("Permissions-Policy", "camera=*, microphone=*, autoplay=*");
    await serveHtmlWithConfig(req, res, "video.html");
  });

  // Experimental Daily-SDK rendering of the same Tavus session: custom
  // controls, push-to-interrupt, advanced settings panel, pre-call device
  // test. Public so anyone (logged in) can A/B against the iframe path on
  // /video. Session creation itself still requires login + rate-limit.
  pageRouter.get("/lab", optionalAuth, async (req, res) => {
    res.setHeader("Permissions-Policy", "camera=*, microphone=*, autoplay=*");
    await serveHtmlWithConfig(req, res, "video-lab.html");
  });

  // API router: POST /api/addie/video/session, POST /api/addie/video/session/:id/end
  const apiRouter = Router();

  // End an active Tavus conversation. Releases the concurrent-conversation
  // slot immediately so a new session can be created. Auth: must be the
  // user who created the thread (or an AAO admin).
  apiRouter.post("/session/:conversationName/end", optionalAuth, endRateLimiter, async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const tavusApiKey = process.env.TAVUS_API_KEY;
    if (!tavusApiKey) {
      return res.status(503).json({ error: "Video chat not configured" });
    }
    const conversationName = req.params.conversationName;
    if (!/^addie-[0-9a-f-]{36}$/.test(conversationName)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    // Look up the thread we created for this conversation. We use it both
    // to authorize the call (only the thread owner can end) and to recover
    // the Tavus conversation_id from the conversation_url stored in context.
    const threadService = getThreadService();
    const thread = await threadService.getThreadByExternalId('video', conversationName).catch(() => null);

    if (!thread) {
      // No matching thread — could be a stale id or a session created by a
      // different process. Fail closed; admins can clean up via Tavus
      // dashboard / direct API call.
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (!isVoiceSessionOwner(thread.context?.voice_authorization, req.user)) {
      let userIsAdmin: boolean;
      try {
        userIsAdmin = await isAuthenticatedUserAAOAdmin(req.user);
      } catch (error) {
        if (respondToAdminAuthorizationError(error, res)) return;
        throw error;
      }
      if (!userIsAdmin) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    // Revoke callbacks before the external end request. A provider timeout
    // must not let a participant replay the capability after ending locally.
    try {
      await persistVoiceCallbackBinding(thread.thread_id, thread.external_id, null);
    } catch {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'voice_authorization_unavailable' });
    }

    // Tavus identifies conversations by their internal conversation_id, not
    // the conversation_name we sent. We stash that id in thread.context at
    // create time. Fall back to scanning the active list (with the name
    // normalized — Tavus replaces "-" with " ") if context is missing.
    let tavusConversationId: string | null =
      (thread.context as { tavus_conversation_id?: string } | null)?.tavus_conversation_id ?? null;

    if (!tavusConversationId) {
      try {
        const list = await fetch(`https://tavusapi.com/v2/conversations?status=active`, {
          headers: { "x-api-key": tavusApiKey },
        });
        if (list.ok) {
          const data = (await list.json()) as { data?: Array<{ conversation_id: string; conversation_name: string }> };
          const normalized = conversationName.replace(/-/g, " ");
          const match = data.data?.find((c) => c.conversation_name === normalized || c.conversation_name === conversationName);
          if (match) tavusConversationId = match.conversation_id;
        }
      } catch (err) {
        logger.warn({ err, conversationName }, "Tavus end: failed to list active conversations");
      }
    }

    if (!tavusConversationId) {
      // Already ended or not found — treat as success so the client
      // tear-down completes cleanly.
      return res.json({ ended: false, reason: "not_active" });
    }

    try {
      const endRes = await fetch(
        `https://tavusapi.com/v2/conversations/${tavusConversationId}/end`,
        { method: "POST", headers: { "x-api-key": tavusApiKey } }
      );
      if (!endRes.ok) {
        const text = await endRes.text();
        logger.error({ status: endRes.status, error: text, conversationName }, "Tavus end: failed");
        return res.status(502).json({ error: "Tavus end-call failed" });
      }
      logger.info({ conversationName, tavusConversationId }, "Tavus end: conversation released");
      return res.json({ ended: true });
    } catch (err) {
      logger.error({ err, conversationName }, "Tavus end: error");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  apiRouter.post("/session", optionalAuth, sessionRateLimiter, async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Please log in to start a video call." });
    }

    const tavusApiKey = process.env.TAVUS_API_KEY;
    const personaId = process.env.TAVUS_PERSONA_ID;

    if (!tavusApiKey || !personaId) {
      return res.status(503).json({ error: "Video chat not configured" });
    }

    try {
      const conversationName = `addie-${uuidv4()}`;
      const rawDisplayName = [req.user.firstName, req.user.lastName].filter(Boolean).join(" ") || req.user.email;
      const displayName = sanitizeTavusDisplayName(rawDisplayName);

      // Optional per-session overrides from the client. The lab page exposes
      // these via an Advanced Settings panel; the standard /video page sends
      // none of them and gets the defaults below.
      const settings = (req.body ?? {}) as {
        greeting?: string;
        extraContext?: string;
        maxDurationSec?: number;
        greenscreen?: boolean;
        language?: string;
        disableFillers?: boolean;
      };
      const greetingOverride = boundedTrimmedTavusSetting(
        settings.greeting,
        TAVUS_SETTING_LIMITS.greeting,
      );
      const greeting = greetingOverride
        || `Hi ${displayName.split(" ")[0]}, I'm Addie! How can I help you today?`;
      // Clamp duration: Tavus's effective max is 1 hour for most plans.
      const maxDurationSec = typeof settings.maxDurationSec === "number" && Number.isFinite(settings.maxDurationSec)
        ? Math.max(60, Math.min(7200, Math.round(settings.maxDurationSec)))
        : 3600;
      const greenscreen = settings.greenscreen === true;
      // Tavus expects the full language name ("spanish") not an ISO code.
      const language = typeof settings.language === "string" && /^[a-z]{3,20}$/.test(settings.language)
        ? settings.language
        : undefined;
      const disableFillers = settings.disableFillers === true;
      const sessionGuidance = createTavusSessionGuidance(
        settings.extraContext
      );

      // Create a thread to track this video conversation
      const threadService = getThreadService();
      const threadContext: Record<string, unknown> = {
        persona_id: personaId,
        voice_authorization: await captureVoiceAuthorization(req.user),
      };
      if (disableFillers) threadContext.disable_fillers = true;
      if (sessionGuidance) {
        threadContext.video_session_guidance = sessionGuidance;
      }
      const thread = await threadService.getOrCreateThread({
        channel: "video",
        external_id: conversationName,
        user_type: "workos",
        user_id: req.user.id,
        user_display_name: displayName,
        context: threadContext,
      });
      const callback = issueVoiceCallbackBinding(thread.thread_id, conversationName, maxDurationSec);
      await persistVoiceCallbackBinding(thread.thread_id, conversationName, callback.binding);

      // Tavus appends conversational_context to its system message. Keep it
      // strictly server-generated: caller guidance is stored on our thread and
      // later added to the caller's current user turn at user priority.
      const conversationalContext = buildTavusConversationalContext({
        threadId: thread.thread_id,
        displayName,
      }) + `\n[conductor:voice_session=${callback.token}]`;

      const tavusBody: Record<string, unknown> = {
        persona_id: personaId,
        conversation_name: conversationName,
        custom_greeting: greeting,
        conversational_context: conversationalContext,
      };
      const properties: Record<string, unknown> = {};
      if (maxDurationSec) properties.max_call_duration = maxDurationSec;
      if (greenscreen) properties.apply_greenscreen = true;
      if (language) properties.language = language;
      if (Object.keys(properties).length) tavusBody.properties = properties;

      const response = await fetch("https://tavusapi.com/v2/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": tavusApiKey,
        },
        body: JSON.stringify(tavusBody),
      });

      if (!response.ok) {
        logger.error(
          // Provider error bodies may echo the signed session capability.
          { status: response.status },
          "Tavus: Failed to create conversation"
        );
        return res.status(502).json({ error: "Failed to create video session" });
      }

      const data = (await response.json()) as { conversation_url: string; conversation_id: string };
      // Tavus normalizes conversation_name (replaces "-" with " ") so we
      // can't reliably round-trip lookup by name. Stash Tavus's internal
      // conversation_id on the thread so end-call can call /conversations/:id/end
      // directly without scanning the active list. This binding must commit
      // before we release the session to its participant.
      if (typeof data.conversation_id !== 'string' || !data.conversation_id) {
        throw new VoiceAuthorizationUnavailableError();
      }
      try {
        await persistVoiceCallbackBinding(thread.thread_id, conversationName, callback.binding, data.conversation_id);
      } catch (error) {
        // Fail closed and release the billable provider session if its local
        // authorization binding could not be persisted.
        await fetch(`https://tavusapi.com/v2/conversations/${encodeURIComponent(data.conversation_id)}/end`, {
          method: 'POST', headers: { 'x-api-key': tavusApiKey }, signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
        throw new VoiceAuthorizationUnavailableError({ cause: error });
      }
      return res.json({
        conversation_url: data.conversation_url,
        conversation_id: conversationName,
        thread_id: thread.thread_id,
        display_name: displayName,
      });
    } catch (err) {
      if (err instanceof VoiceAuthorizationUnavailableError) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: err.code, message: 'Voice authorization is temporarily unavailable. Please try again.' });
      }
      logger.error({ err }, "Tavus: Error creating conversation");
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // LLM router: POST /api/addie/v1/chat/completions
  // OpenAI-compatible streaming endpoint consumed by the Tavus persona's LLM layer.
  const llmRouter = Router();

  llmRouter.post("/chat/completions", llmRateLimiter, async (req, res) => {
    if (!validateLlmSecret(req)) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }

    if (!options?.voiceClient) {
      await initializeTavusClient();
    }

    const activeVoiceClient = options?.voiceClient ?? claudeClient;
    if (!activeVoiceClient) {
      return res.status(503).json({ error: { message: "LLM not available" } });
    }
    const resolveRouter = (): TavusVoiceRouter | null => Object.hasOwn(options ?? {}, 'router')
      ? options?.router ?? null
      : (options?.voiceClient ? null : tavusRouter);

    const { messages } = req.body as { messages?: TavusRawMessage[] };

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "No messages provided" } });
    }

    if (!messages.every((m) => typeof m.role === "string" && m.content !== undefined)) {
      return res.status(400).json({ error: { message: "Invalid messages format" } });
    }

    // Tavus participants can replace system conversational context. A bare
    // thread id is never authority. Authenticate the server-issued session
    // capability and its current database binding before any scoped work.
    const callbackTokens = [...messages
      .filter((m) => m.role === "system")
      .map((m) => extractTavusText(m.content))
      .join(" ")
      .matchAll(/\[conductor:voice_session=([A-Za-z0-9_.-]{1,1024})\]/g)];
    const callback = await resolveVoiceCallback(
      callbackTokens.length === 1 ? callbackTokens[0][1] : undefined,
      req.body.conversation_id,
    );
    if (callback.status === 'unavailable') {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice authorization is temporarily unavailable. Please try again.' } });
    }
    if (callback.status !== 'verified') {
      return res.status(409).json({ error: { code: 'voice_reauthentication_required', message: 'This video session could not be verified. Please start a new video call.' } });
    }
    const thread = callback.thread;
    const threadId = thread.thread_id;

    const parsed = buildTavusThreadContext(messages);
    if (!parsed) {
      return res.status(400).json({ error: { message: "No user message found" } });
    }

    let { currentMessage, threadContext } = parsed;

    // Sanitize inputs — same protection as the web chat endpoint
    currentMessage = sanitizeInput(currentMessage).sanitized;
    threadContext = threadContext.map((m) => ({
      ...m,
      text: sanitizeInput(m.text).sanitized,
    }));

    const spokenMessage = currentMessage;
    const admittedTurn = await admitVoiceCallbackTurn({ res, thread, messages });
    if (!admittedTurn) return;
    const { threadService, clientRequestId } = admittedTurn;
    let claimedVoiceTurn: { leaseId: string } | null = admittedTurn.state === 'claimed'
      ? { leaseId: admittedTurn.leaseId }
      : null;
    const releaseVoiceTurn = async (reason: string): Promise<void> => {
      const claimed = claimedVoiceTurn;
      if (!claimed) return;
      claimedVoiceTurn = null;
      try {
        await threadService.setClientTurnStatus(
          threadId,
          clientRequestId,
          claimed.leaseId,
          'interrupted',
        );
      } catch (error) {
        logger.error({ error, threadId, reason }, 'Tavus: Failed to release interrupted voice turn');
      }
    };
    const persistInterruptedVoiceTurn = async (reason: string): Promise<void> => {
      const claimed = claimedVoiceTurn;
      if (!claimed) return;
      try {
        await threadService.addMessage({
          thread_id: threadId,
          role: 'assistant',
          content: 'Voice reply interrupted before completion. The provider may safely retry this turn.',
          model: responseProviderModel(),
          model_execution: {
            source: 'local', requested_provider: responseProviderId(), requested_model: responseProviderModel(), reason: 'stream_interrupted',
          },
          flagged: true,
          flag_reason: `stream_interrupted: ${reason}`,
          client_request_id: clientRequestId,
          delivery_status: 'interrupted',
          client_turn_lease_id: claimed.leaseId,
          finalize_client_turn_status: 'interrupted',
        });
        claimedVoiceTurn = null;
      } catch (error) {
        logger.error({ error, threadId, reason }, 'Tavus: Failed to persist interrupted voice turn');
        await releaseVoiceTurn(reason);
      }
    };

    // Look up the thread to get user identity and build user-scoped tools.
    // This gives voice Addie the same capabilities as chat Addie.
    let voiceRequestTools: RequestTools | undefined;
    let routedVoiceTools: RoutedTavusVoiceTools | null = null;
    let pendingVoiceToolSelection: {
      memberContext: MemberContext | null;
      isAAOAdmin: boolean;
      requestTools: RequestTools;
      globalToolNames?: readonly string[];
      forceSafeFallback?: boolean;
    } | null = null;
    let memberRequestContext = "";
    let userDisplayName: string | null = null;
    let voiceUserId: string | null = null;
    let voiceFillersDisabled = false;
    let sessionGuidance = "";
    let authorization: Awaited<ReturnType<typeof resolveVoiceAuthorization>>;
    try {
      authorization = await resolveVoiceAuthorization(thread.context?.voice_authorization);
    } catch (error) {
      logger.error({ error, threadId }, 'Tavus: Credential authorization failed unexpectedly');
      await releaseVoiceTurn('credential_authorization_unavailable');
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice authorization is temporarily unavailable. Please try again.' } });
    }
    if (authorization.status === 'unavailable') {
      await releaseVoiceTurn('credential_authorization_unavailable');
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice authorization is temporarily unavailable. Please try again.' } });
    }
    if (authorization.status === 'stale') {
      logger.info({ threadId, reason: authorization.reason }, 'Voice session requires fresh authentication');
      await releaseVoiceTurn('credential_authorization_stale');
      return res.status(409).json({ error: { code: 'voice_reauthentication_required', message: 'Your sign-in authorization changed. Please sign in again and start a new video call.' } });
    }
    if (admittedTurn.state === 'completed') {
      replayCompletedVoiceTurn(res, clientRequestId, admittedTurn.content);
      return;
    }
    userDisplayName = thread.user_display_name;
    voiceUserId = thread.user_id;
    voiceFillersDisabled = thread.context?.disable_fillers === true;
    sessionGuidance = readTavusSessionGuidance(thread.context?.video_session_guidance);
    try {
      const result = await buildVoiceRequestTools(thread.user_id, threadId, authorization.principal);
      memberRequestContext = result.requestContext;
      try {
        pendingVoiceToolSelection = {
          memberContext: result.memberContext,
          isAAOAdmin: result.isAAOAdmin,
          requestTools: result.requestTools,
          globalToolNames: activeVoiceClient.getRegisteredTools?.(),
        };
      } catch (error) {
        // Global pairing inspection is part of capability assembly. It
        // must never leave the broad registry eligible for dispatch.
        logger.warn({ error, threadId }, 'Tavus: Global tool inspection failed; preparing safe read-only fallback');
        pendingVoiceToolSelection = {
          memberContext: result.memberContext,
          isAAOAdmin: result.isAAOAdmin,
          requestTools: result.requestTools,
          forceSafeFallback: true,
        };
      }
    } catch (err) {
      if (respondToAdminAuthorizationError(err, res)) {
        await releaseVoiceTurn('admin_authorization_unavailable');
        return;
      }
      logger.warn({ err, threadId }, "Tavus: Failed to build user-scoped tools; using safe read-only fallback");
      // A verified video thread still represents an authenticated direct
      // response even when its dynamic capability assembly fails. Never
      // fall through to the mutable global baseline in that case.
      if (voiceUserId) {
        let globalToolNames: readonly string[] | undefined;
        let forceSafeFallback = false;
        try {
          globalToolNames = activeVoiceClient.getRegisteredTools?.();
        } catch (globalToolError) {
          logger.warn({ globalToolError, threadId }, 'Tavus: Could not inspect global tools for safe fallback');
          // Request-scoped assembly and global pairing inspection both
          // failed. Keep a live router out of this uncertain capability
          // state so the authenticated response stays read-only.
          forceSafeFallback = true;
        }
        pendingVoiceToolSelection = {
          memberContext: null,
          isAAOAdmin: false,
          requestTools: { tools: [], handlers: new Map() },
          globalToolNames,
          forceSafeFallback,
        };
      }
    }
    // Capability assembly failures remain bounded to public read-only tools.
    if (!pendingVoiceToolSelection) {
      let globalToolNames: readonly string[] | undefined;
      try {
        globalToolNames = activeVoiceClient.getRegisteredTools?.();
      } catch (error) {
        logger.warn({ error, threadId }, 'Tavus: Could not inspect global tools for unverified-thread fallback');
      }
      pendingVoiceToolSelection = {
        memberContext: null,
        isAAOAdmin: false,
        requestTools: { tools: [], handlers: new Map() },
        globalToolNames,
        forceSafeFallback: true,
      };
    }

    const requestMessages = await threadService.getMessagesByClientRequestId(threadId, clientRequestId).catch(async (error) => {
      logger.error({ error, threadId }, 'Tavus: Voice turn checkpoints unavailable');
      await releaseVoiceTurn('checkpoint_lookup_failed');
      return null;
    });
    if (!requestMessages) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice turn state is temporarily unavailable. Please try again.' } });
    }
    const existingUserMessage = requestMessages.find((message) => message.role === 'user');
    if (existingUserMessage && existingUserMessage.content !== spokenMessage) {
      await releaseVoiceTurn('turn_id_conflict');
      return res.status(409).json({ error: { code: 'voice_turn_conflict', message: 'The voice turn identifier belongs to different input.' } });
    }
    const retryCheckpointToolCalls: StoredToolCall[] = requestMessages
      .filter((message) => message.role === 'assistant' && message.delivery_status === 'interrupted')
      .flatMap((message) => message.tool_calls ?? []);
    const replayPolicy = blockCheckpointedToolReplays(retryCheckpointToolCalls);

    // Log the user message (before voice prefix or guidance is applied)
    const voiceSpeakerName = sanitizeSpeakerName(userDisplayName);
    if (!existingUserMessage) {
      try {
        await threadService.addMessage({
          thread_id: threadId,
          role: "user",
          content: spokenMessage,
          user_id: voiceUserId ?? undefined,
          user_display_name: voiceSpeakerName,
          message_source: 'voice',
          client_request_id: clientRequestId,
        });
      } catch (error) {
        logger.error({ error, threadId }, 'Tavus: Failed to persist voice user turn');
        await releaseVoiceTurn('user_message_persistence_failed');
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: { code: 'voice_authorization_unavailable', message: 'Voice turn persistence is temporarily unavailable. Please try again.' } });
      }
    }

    // Voice instructions and optional caller guidance stay adjacent to the
    // current user turn. Caller text never enters application-owned context.
    currentMessage = buildTavusVoiceUserMessage(
      spokenMessage,
      sessionGuidance ? { version: 1, text: sessionGuidance } : undefined
    );

    const voiceContextLines = [
      "VOICE MODE: This is a live video call. Your response will be spoken aloud.",
    ];
    if (userDisplayName) {
      voiceContextLines.push(`You are speaking with ${userDisplayName}. You already know their name — never ask for it.`);
    }
    if (sessionGuidance) {
      voiceContextLines.push(TAVUS_SESSION_GUIDANCE_POLICY);
    }
    voiceContextLines.push(
      "Match response length to the question — brief for simple questions, fuller for substantive ones.",
      "Never use formatting. Use conversational punctuation (ellipses, em-dashes) for natural pacing.",
      "When using tools, summarize results conversationally — don't read data verbatim.",
    );
    const voiceContext = voiceContextLines.join("\n");

    // Complete provider-neutral admission and routing before opening the SSE
    // response. If routing is unavailable, Tavus must receive an explicit HTTP
    // error rather than a successful stream containing only a filler and DONE.
    let voiceScope: { userId: string; tier: Awaited<ReturnType<typeof resolveUserTierFromDb>> } | null;
    try {
      voiceScope = voiceUserId
        ? { userId: voiceUserId, tier: await resolveUserTierFromDb(voiceUserId) }
        : null;
    } catch (error) {
      logger.error({ error, threadId }, 'Tavus: Voice cost scope unavailable');
      await releaseVoiceTurn('cost_scope_unavailable');
      return res.status(503).json({ error: { message: 'LLM routing temporarily unavailable' } });
    }
    const costScope = voiceScope ?? {
      userId: `tavus:ip:${req.ip ?? 'unknown'}`,
      tier: 'anonymous' as const,
    };
    let requestContext: string;
    try {
      // Do the existing provider-neutral admission read before selecting a
      // live router plan. The client repeats this immediately before model
      // dispatch, which preserves its race-safe final admission boundary.
      // A refused or unavailable admission must never initiate paid routing.
      const costAdmission = await checkCostCap(costScope.userId, costScope.tier, {
        selection: { provider: responseProviderId(), model: responseProviderModel() },
      });
      const routerForTurn = costAdmission.ok ? resolveRouter() : null;

      routedVoiceTools = await selectRoutedTavusVoiceTools({
        message: spokenMessage,
        threadId: threadId!,
        threadMessages: threadContext.slice(-6).map((turn) => `${turn.user}: ${turn.text}`),
        router: pendingVoiceToolSelection.forceSafeFallback ? null : routerForTurn,
        ...pendingVoiceToolSelection,
      });
      voiceRequestTools = routedVoiceTools.requestTools;
      logger.debug(
        {
          userId: voiceUserId,
          toolCount: voiceRequestTools.tools.length,
          selectedToolSets: routedVoiceTools.selectedToolSets,
          costAdmitted: costAdmission.ok,
        },
        'Tavus: Selected bounded voice tools for stream dispatch',
      );

      requestContext = [
        voiceContext,
        memberRequestContext,
        routedVoiceTools?.unavailableHint,
      ].filter(Boolean).join("\n\n");
    } catch (err) {
      logger.error({ err }, 'Tavus: Routing unavailable');
      await releaseVoiceTurn('routing_unavailable');
      return res.status(503).json({
        error: { message: 'LLM routing temporarily unavailable' },
      });
    }

    const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);
    const startTime = Date.now();

    let leaseOwnershipLost = false;
    let activeVoiceIterator: AsyncIterator<StreamEvent> | null = null;
    const markLeaseOwnershipLost = (reason: string, error?: unknown): void => {
      if (leaseOwnershipLost) return;
      leaseOwnershipLost = true;
      logger.error({ error, threadId, reason }, 'Tavus: Voice turn lease ownership lost; aborting stream');
      if (activeVoiceIterator?.return) {
        void activeVoiceIterator.return().catch((returnError) => {
          logger.error({ error: returnError, threadId }, 'Tavus: Failed to stop stream after voice lease loss');
        });
      }
    };
    const proveVoiceTurnLease = async (reason: string): Promise<void> => {
      const claimed = claimedVoiceTurn;
      if (!claimed || leaseOwnershipLost) throw new Error('Voice turn lease is no longer owned');
      let owned: boolean;
      try {
        owned = await threadService.renewClientTurnLease(
          threadId,
          clientRequestId,
          claimed.leaseId,
        );
      } catch (error) {
        markLeaseOwnershipLost(reason, error);
        throw error;
      }
      if (!owned) {
        markLeaseOwnershipLost(reason);
        throw new Error('Voice turn lease ownership check failed');
      }
      // A concurrent renewal probe may have observed lease loss while this
      // successful database call was in flight. Loss is sticky for this worker.
      if (leaseOwnershipLost) throw new Error('Voice turn lease is no longer owned');
    };

    // Refresh immediately before provider work in case authorization/routing
    // consumed most of the original claim lease. Do not open the stream after
    // ownership has moved to a retry worker.
    try {
      await proveVoiceTurnLease('before_model_stream');
    } catch {
      await releaseVoiceTurn('lease_lost_before_model_stream');
      return res.status(409).json({
        error: { code: 'voice_turn_lease_lost', message: 'This voice turn moved to another worker. Please retry shortly.' },
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader('X-Addie-Client-Turn-Id', clientRequestId);

    const inFlightLeaseRenewals = new Set<Promise<void>>();
    let leaseCriticalSection = Promise.resolve();
    const withLeaseCriticalSection = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = leaseCriticalSection;
      let release!: () => void;
      leaseCriticalSection = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    };
    const renewVoiceTurnLease = (): Promise<void> => {
      const renewal = withLeaseCriticalSection(async () => {
        const claimed = claimedVoiceTurn;
        if (!claimed || leaseOwnershipLost) return;
        try {
          const owned = await threadService.renewClientTurnLease(threadId, clientRequestId, claimed.leaseId);
          if (!owned) markLeaseOwnershipLost('periodic_renewal_rejected');
        } catch (error) {
          markLeaseOwnershipLost('periodic_renewal_unavailable', error);
        }
      });
      inFlightLeaseRenewals.add(renewal);
      void renewal.finally(() => inFlightLeaseRenewals.delete(renewal));
      return renewal;
    };
    const drainInFlightLeaseRenewals = async (): Promise<void> => {
      while (inFlightLeaseRenewals.size > 0) {
        await Promise.all(inFlightLeaseRenewals);
      }
    };
    const stopLeaseRenewal = options?.leaseRenewalScheduler
      ? options.leaseRenewalScheduler(renewVoiceTurnLease)
      : (() => {
          const leaseRenewal = setInterval(() => void renewVoiceTurnLease(), 15_000);
          leaseRenewal.unref();
          return () => clearInterval(leaseRenewal);
        })();

    let connectionClosed = false;
    req.on("close", () => {
      connectionClosed = true;
      logger.debug("Tavus: Client disconnected during stream");
    });

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      if (connectionClosed || leaseOwnershipLost) return;
      const chunk = JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: "addie",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      res.write(`data: ${chunk}\n\n`);
    };

    sendChunk({ role: "assistant", content: "" });

    // For substantive questions, send a filler phrase immediately so Addie starts
    // speaking while the model processes. Tavus TTS picks this up with near-zero latency.
    // Neutral conversational fillers — no ritual praise ("great question") which
    // reads as canned across a session. video-lab.html exposes a toggle that sets
    // thread.context.disable_fillers to skip this entirely for users who'd rather
    // hear a half-second of silence than any preamble.
    const questionPattern = /\b(what|how|why|explain|tell me|describe|walk me through|can you|could you)\b/i;
    const isSubstantive = spokenMessage.length > 30 && questionPattern.test(spokenMessage);
    let fullResponse = "";
    if (isSubstantive && !voiceFillersDisabled) {
      const fillers = [
        "So... ",
        "Well... ",
        "Hmm... ",
        "Okay, so... ",
        "Sure... ",
        "Let me think... ",
        "Funny enough... ",
        "Yeah, so... ",
        "Alright... ",
      ];
      const filler = fillers[Math.floor(Math.random() * fillers.length)];
      sendChunk({ content: filler });
      // Filler is streamed to TTS but not included in fullResponse
      // so the stored transcript stays clean.
    }

    let streamError = false;
    let terminalResponse: AddieResponse | undefined;
    try {
      const voiceEvents = responseClient(activeVoiceClient, 'tavus').processMessageStream(
        currentMessage,
        threadContext,
        voiceRequestTools,
        {
          requestContext,
          currentSpeakerName: voiceSpeakerName,
          selectedToolSetNames: routedVoiceTools?.selectedToolSets,
          allowedToolNames: routedVoiceTools?.allowedToolNames,
          clientRequestId,
          ...(replayPolicy ? { toolExecutionPolicy: replayPolicy } : {}),
          costScope,
          reserveSideEffect: async ({ toolName, parameters }) => {
            if (!threadId) throw new Error('A durable conversation thread is required for an external action');
            await withLeaseCriticalSection(async () => {
              // This inline ownership proof extends the exact lease immediately
              // before the durable reservation and handler dispatch boundary.
              await proveVoiceTurnLease(`before_side_effect:${toolName}`);
              await reserveToolIntentCheckpoint(threadService, {
                threadId,
                toolName,
                parameters,
                requestedModel: responseProviderModel(),
                clientRequestId,
              });
              await proveVoiceTurnLease(`after_side_effect_reservation:${toolName}`);
            });
            // Drain every periodic probe which queued before the serialized
            // reservation released. Once this synchronous tail passes, the
            // shared executor runs before a later timer task can interleave.
            await drainInFlightLeaseRenewals();
            if (leaseOwnershipLost) throw new Error('Voice turn lease is no longer owned');
          },
        }
      );
      activeVoiceIterator = voiceEvents[Symbol.asyncIterator]();
      while (true) {
        const next = await activeVoiceIterator.next();
        if (next.done) break;
        const event = next.value;
        if (connectionClosed || leaseOwnershipLost) break;
        if (event.type === "text") {
          fullResponse += event.text;
          sendChunk({ content: event.text });
        } else if (event.type === "stream_error") {
          // Mid-stream upstream failure (#4797). Drop the partial so we
          // don't persist a truncated assistant turn into thread history
          // and confuse the next-turn prompt assembly.
          logger.warn(
            { reason: event.reason, deltasBeforeError: event.deltasBeforeError, partialLength: fullResponse.length },
            "Tavus: Addie stream interrupted mid-reply — discarding partial turn"
          );
          fullResponse = '';
          streamError = true;
          break;
        } else if (event.type === "error") {
          logger.error({ error: event.error }, "Tavus: Addie stream error");
          streamError = true;
          break;
        } else if (event.type === 'tool_end') {
          if (!threadId) {
            logger.error({ toolName: event.tool_name }, 'Tavus: Missing thread for tool outcome checkpoint');
            streamError = true;
            break;
          }
          try {
            await drainInFlightLeaseRenewals();
            if (leaseOwnershipLost) throw new Error('Voice turn lease is no longer owned');
            await withLeaseCriticalSection(async () => {
              await proveVoiceTurnLease(`before_tool_checkpoint:${event.tool_name}`);
              await threadService.addMessage(buildToolResultCheckpoint({
                threadId,
                execution: event.execution,
                requestedModel: responseProviderModel(),
                clientRequestId,
              }));
              await proveVoiceTurnLease(`after_tool_checkpoint:${event.tool_name}`);
            });
            await drainInFlightLeaseRenewals();
            if (leaseOwnershipLost) throw new Error('Voice turn lease is no longer owned');
          } catch (checkpointError) {
            logger.error({ checkpointError, threadId, toolName: event.tool_name }, 'Tavus: Tool outcome checkpoint failed');
            streamError = true;
            break;
          }
        } else if (event.type === "done") {
          terminalResponse = event.response;
        }
      }
    } catch (err) {
      logger.error({ err }, "Tavus: Streaming error");
      streamError = true;
    } finally {
      stopLeaseRenewal();
      await drainInFlightLeaseRenewals();
      activeVoiceIterator = null;
    }

    // The completed assistant row and turn state commit atomically. Until this
    // durable receipt exists, the session capability alone never suppresses a
    // retry; persisted tool checkpoints still block repeated successful work.
    if (threadId && terminalResponse && !streamError && !leaseOwnershipLost) {
      const claimed = claimedVoiceTurn;
      try {
        if (!claimed) throw new Error('Voice turn lease was lost before completion');
        await proveVoiceTurnLease('before_completed_receipt');
        await threadService.addMessage({
          thread_id: threadId,
          role: "assistant",
          content: terminalResponse.text,
          model: responseProviderModel(),
          model_execution: terminalResponse.model_execution,
          latency_ms: Date.now() - startTime,
          client_request_id: clientRequestId,
          delivery_status: 'completed',
          client_turn_lease_id: claimed.leaseId,
          finalize_client_turn_status: 'completed',
        });
        claimedVoiceTurn = null;
      } catch (error) {
        logger.error({ error, threadId }, 'Tavus: Failed to persist completed voice turn');
        streamError = true;
      }
    }

    if ((streamError || !terminalResponse) && !leaseOwnershipLost) {
      await persistInterruptedVoiceTurn(streamError ? 'stream_error' : 'ended_without_done');
    }

    if (!streamError && !leaseOwnershipLost) {
      sendChunk({}, "stop");
    }
    if (!leaseOwnershipLost) res.write("data: [DONE]\n\n");
    res.end();
  });

  return { pageRouter, apiRouter, llmRouter };
}
