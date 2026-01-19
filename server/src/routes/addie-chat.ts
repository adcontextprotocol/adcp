/**
 * Addie Chat routes module
 *
 * Public chat API for web-based chat with Addie.
 * Stores conversation history for training purposes.
 */

import { Router } from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validate as uuidValidate } from "uuid";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { createLogger } from "../logger.js";
import { optionalAuth } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { AddieClaudeClient, type RequestTools } from "../addie/claude-client.js";
import {
  sanitizeInput,
  validateOutput,
} from "../addie/security.js";
import {
  initializeKnowledgeSearch,
  isKnowledgeReady,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from "../addie/mcp/knowledge-search.js";
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from "../addie/mcp/billing-tools.js";
import {
  MEMBER_TOOLS,
  createMemberToolHandlers,
} from "../addie/mcp/member-tools.js";
import {
  SI_HOST_TOOLS,
  createSiHostToolHandlers,
} from "../addie/mcp/si-host-tools.js";
import { AddieModelConfig } from "../config/models.js";
import {
  getWebMemberContext,
  formatMemberContextForPrompt,
  type MemberContext,
} from "../addie/member-context.js";
import {
  getThreadService,
  type ThreadContext,
} from "../addie/thread-service.js";
import { UsersDatabase } from "../db/users-db.js";
import { isRetriesExhaustedError } from "../utils/anthropic-retry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("addie-chat-routes");

let claudeClient: AddieClaudeClient | null = null;
let initialized = false;

/**
 * Initialize the chat client
 */
async function initializeChatClient(): Promise<void> {
  if (initialized) return;

  const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn("Addie Chat: No ANTHROPIC_API_KEY configured");
    return;
  }

  claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);

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

  // Register billing tools (for membership signup assistance)
  const billingHandlers = createBillingToolHandlers();
  for (const tool of BILLING_TOOLS) {
    const handler = billingHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  // Note: Member tools are registered per-request with user's actual context
  // This allows user-scoped tools to work correctly for authenticated users

  initialized = true;
  logger.info("Addie Chat: Initialized");
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
// Rate limiter for chat API - prevents abuse and API cost attacks
const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 messages per minute per IP
  message: { error: "Too many requests", message: "Please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
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

interface PreparedRequest {
  messageToProcess: string;
  memberContext: MemberContext | null;
  requestTools: RequestTools;
}

interface SiSessionData {
  session_id: string;
  brand_name: string;
  brand_response: unknown;
  identity_shared: boolean;
  relationship: unknown;
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
 */
async function prepareRequestWithMemberTools(
  sanitizedInput: string,
  userId: string | undefined,
  threadExternalId: string
): Promise<PreparedRequest> {
  let messageToProcess = sanitizedInput;
  let memberContext: MemberContext | null = null;

  try {
    if (userId) {
      memberContext = await getWebMemberContext(userId);
      const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
      if (memberContextText) {
        messageToProcess = `${memberContextText}\n---\n\n${sanitizedInput}`;
        logger.debug(
          { userId, hasContext: true, orgName: memberContext.organization?.name },
          "Addie Chat: Added member context to message"
        );
      }
    } else {
      const anonymousContext = { is_mapped: false, is_member: false, slack_linked: false };
      const memberContextText = formatMemberContextForPrompt(anonymousContext, 'web');
      if (memberContextText) {
        messageToProcess = `${memberContextText}\n---\n\n${sanitizedInput}`;
        logger.debug("Addie Chat: Added anonymous web context to message");
      }
    }
  } catch (error) {
    logger.warn({ error, userId }, "Addie Chat: Failed to get member context");
  }

  // Create per-request member tools
  const memberHandlers = createMemberToolHandlers(memberContext);

  // Create per-request SI host tools with thread context
  const siHostHandlers = createSiHostToolHandlers(
    () => memberContext,
    () => threadExternalId
  );

  // Combine all per-request tools
  const combinedHandlers = new Map([...memberHandlers, ...siHostHandlers]);
  const requestTools: RequestTools = {
    tools: [...MEMBER_TOOLS, ...SI_HOST_TOOLS],
    handlers: combinedHandlers,
  };

  return { messageToProcess, memberContext, requestTools };
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
  exposedHeaders: ['X-Conversation-Id'],
};

export function createAddieChatRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // Enable CORS for all API routes (for native app support)
  apiRouter.use(cors(chatCorsOptions));

  // Initialize client on startup
  initializeChatClient().catch((err) => {
    logger.error({ err }, "Failed to initialize Addie chat client");
  });

  // =========================================================================
  // PAGE ROUTES (mounted at /chat)
  // =========================================================================

  // GET / - Serve the chat page (mounted at /chat, so this serves /chat)
  pageRouter.get("/", optionalAuth, (req, res) => {
    serveHtmlWithConfig(req, res, "chat.html").catch((err) => {
      logger.error({ err }, "Error serving chat page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // API ROUTES (mounted at /api/addie/chat)
  // =========================================================================

  // POST /api/addie/chat - Send a message and get a response
  apiRouter.post("/", chatRateLimiter, optionalAuth, async (req, res) => {
    const startTime = Date.now();
    const threadService = getThreadService();

    try {
      if (!initialized || !claudeClient) {
        return res.status(503).json({
          error: "Service unavailable",
          message: "Addie is not configured. Please set ANTHROPIC_API_KEY.",
        });
      }

      const { message, conversation_id, user_name } = req.body;

      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message is required" });
      }

      // Sanitize input
      const inputValidation = sanitizeInput(message);
      if (inputValidation.flagged) {
        logger.warn({ reason: inputValidation.reason }, "Addie Chat: Input flagged");
      }

      // Get or create thread using unified service
      // For web chat, the external_id is the conversation_id (UUID)
      // If no conversation_id provided, we'll generate a new one via the thread
      const impersonator = req.user?.impersonator;
      const userId = req.user?.id || null;
      const displayName = user_name || req.user?.firstName || null;

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
        thread = await threadService.getOrCreateThread({
          channel: 'web',
          external_id: externalId,
          user_type: userId ? 'workos' : 'anonymous',
          user_id: userId || undefined,
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
        if (!thread) {
          return res.status(404).json({ error: "Conversation not found" });
        }
      }

      // Get conversation history for context
      const messages = await threadService.getThreadMessages(thread.thread_id);
      const history: ConversationMessage[] = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Save user message
      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: message,
        content_sanitized: inputValidation.sanitized,
        flagged: inputValidation.flagged,
        flag_reason: inputValidation.reason,
      });

      // Build context from history (last N messages)
      const contextMessages = history.slice(-10).map((m) => ({
        user: m.role === "user" ? "User" : "Addie",
        text: m.content,
      }));

      // Prepare message with member context and per-request tools
      const { messageToProcess, requestTools } = await prepareRequestWithMemberTools(
        inputValidation.sanitized,
        req.user?.id,
        externalId
      );

      // Process with Claude
      let response;
      try {
        response = await claudeClient.processMessage(messageToProcess, contextMessages, requestTools);
      } catch (error) {
        logger.error({ error }, "Addie Chat: Error processing message");

        // Provide user-friendly error message based on error type
        const errorMessage = isRetriesExhaustedError(error)
          ? `${error.reason}. Please try again in a moment.`
          : "I'm sorry, I encountered an error. Please try again.";

        response = {
          text: errorMessage,
          tools_used: [],
          tool_executions: [],
          flagged: true,
          flag_reason: `Error: ${error instanceof Error ? error.message : "Unknown"}`,
        };
      }

      // Validate output
      const outputValidation = validateOutput(response.text);

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
        model: AddieModelConfig.chat,
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
      const siSession = extractSiSessionFromToolExecutions(response.tool_executions);

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
      ready: initialized && claudeClient !== null && isKnowledgeReady(),
      knowledge_ready: isKnowledgeReady(),
    });
  });

  // POST /api/addie/chat/stream - Stream a response using Server-Sent Events
  // NOTE: This route must come BEFORE /:conversationId to avoid being matched as a conversation ID
  apiRouter.post("/stream", chatRateLimiter, optionalAuth, async (req, res) => {
    const startTime = Date.now();
    const threadService = getThreadService();

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    // Track connection state
    let connectionClosed = false;

    // Handle client disconnect
    req.on("close", () => {
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
      if (!initialized || !claudeClient) {
        sendEvent("error", { error: "Service unavailable", message: "Addie is not configured." });
        res.end();
        return;
      }

      const { message, conversation_id, user_name } = req.body;

      if (!message || typeof message !== "string") {
        sendEvent("error", { error: "Message is required" });
        res.end();
        return;
      }

      // Sanitize input
      const inputValidation = sanitizeInput(message);
      if (inputValidation.flagged) {
        logger.warn({ reason: inputValidation.reason }, "Addie Chat Stream: Input flagged");
      }

      // Get or create thread
      const impersonator = req.user?.impersonator;
      const userId = req.user?.id || null;
      const displayName = user_name || req.user?.firstName || null;

      const webContext: ThreadContext = {
        user_agent: req.get("user-agent"),
        ip_hash: hashIp(req.ip),
        referrer: req.get("referer"),
      };

      let thread;
      let externalId = conversation_id;

      if (!externalId) {
        externalId = crypto.randomUUID();
        thread = await threadService.getOrCreateThread({
          channel: 'web',
          external_id: externalId,
          user_type: userId ? 'workos' : 'anonymous',
          user_id: userId || undefined,
          user_display_name: displayName || undefined,
          context: webContext,
          impersonator_user_id: impersonator?.email,
          impersonation_reason: impersonator?.reason || undefined,
        });
      } else {
        if (!isValidConversationId(externalId)) {
          sendEvent("error", { error: "Invalid conversation ID format" });
          res.end();
          return;
        }
        thread = await threadService.getThreadByExternalId('web', externalId);
        if (!thread) {
          sendEvent("error", { error: "Conversation not found" });
          res.end();
          return;
        }
      }

      // Send conversation_id immediately so client can track it
      sendEvent("meta", { conversation_id: externalId });

      // Get conversation history
      const messages = await threadService.getThreadMessages(thread.thread_id);
      const history: ConversationMessage[] = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Save user message
      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: message,
        content_sanitized: inputValidation.sanitized,
        flagged: inputValidation.flagged,
        flag_reason: inputValidation.reason,
      });

      // Build context messages
      const contextMessages = history.slice(-10).map((m) => ({
        user: m.role === "user" ? "User" : "Addie",
        text: m.content,
      }));

      // Prepare message with member context and per-request tools
      const { messageToProcess, requestTools } = await prepareRequestWithMemberTools(
        inputValidation.sanitized,
        req.user?.id,
        externalId
      );

      // Stream the response
      let fullText = '';
      let response;
      const toolsUsed: string[] = [];

      for await (const event of claudeClient.processMessageStream(messageToProcess, contextMessages, requestTools)) {
        // Break early if client disconnected (still save partial response below)
        if (connectionClosed) {
          logger.info("Addie Chat Stream: Breaking loop due to client disconnect");
          break;
        }

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
        } else if (event.type === 'done') {
          response = event.response;
        } else if (event.type === 'error') {
          sendEvent("error", { error: event.error });
          res.end();
          return;
        }
      }

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
        model: AddieModelConfig.chat,
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
      });

      // Check for SI session started (from connect_to_si_agent tool)
      const siSession = extractSiSessionFromToolExecutions(response?.tool_executions);

      // Send done event with final metadata
      sendEvent("done", {
        conversation_id: externalId,
        message_id: assistantMessage.message_id,
        tools_used: toolsUsed,
        timing: response?.timing,
        usage: response?.usage,
        latency_ms: latencyMs,
        si_session: siSession,
      });

      res.end();
    } catch (error) {
      logger.error({ err: error }, "Addie Chat Stream: Error handling message");
      sendEvent("error", { error: "Internal server error" });
      res.end();
    }
  });

  // POST /api/addie/chat/:conversationId/feedback - Submit feedback on a message
  apiRouter.post("/:conversationId/feedback", optionalAuth, async (req, res) => {
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
      if (!message_id || typeof message_id !== "string") {
        return res.status(400).json({ error: "message_id is required" });
      }

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "rating must be between 1 and 5" });
      }

      // Verify thread exists for this conversation
      const thread = await threadService.getThreadByExternalId('web', conversationId);
      if (!thread) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Add feedback to message using unified service
      const updated = await threadService.addMessageFeedback(message_id, {
        rating,
        rating_category: rating_category || undefined,
        rating_notes: feedback_text || undefined,
        feedback_tags: feedback_tags || undefined,
        improvement_suggestion: improvement_suggestion || undefined,
        rated_by: req.user?.id || "anonymous",
        rating_source: 'user',
      });

      if (!updated) {
        logger.warn({ conversationId, message_id }, "Addie Chat: Message not found for feedback");
        return res.status(404).json({ error: "Message not found" });
      }

      logger.info(
        { conversationId, message_id, rating, rating_category },
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
      if (channel !== 'web' && channel !== 'slack') {
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
      }

      // Get thread by external_id
      const thread = await threadService.getThreadByExternalId(channel, conversationId);
      if (!thread) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Verify ownership - users can only view their own threads
      if (req.user) {
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
          return res.status(403).json({ error: "Access denied" });
        }
      } else {
        // Anonymous users cannot view threads
        return res.status(401).json({
          error: "Authentication required",
          message: "Please log in to view conversations",
        });
      }

      // Get messages
      const threadMessages = await threadService.getThreadMessages(thread.thread_id);
      const messages: ConversationMessage[] = threadMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
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
        messages,
        read_only: channel === 'slack', // Slack threads are read-only in web UI
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
