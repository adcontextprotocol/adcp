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
import { createLogger } from "../logger.js";
import { optionalAuth } from "../middleware/auth.js";
import { AddieClaudeClient } from "../addie/claude-client.js";
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

  // Register member tools with null context (for web chat, user-scoped tools will fail gracefully)
  // This allows tools like draft_github_issue to work without user auth
  const memberHandlers = createMemberToolHandlers(null);
  for (const tool of MEMBER_TOOLS) {
    const handler = memberHandlers.get(tool.name);
    if (handler) {
      claudeClient.registerTool(tool, handler);
    }
  }

  initialized = true;
  logger.info("Addie Chat: Initialized");
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
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

export function createAddieChatRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // Initialize client on startup
  initializeChatClient().catch((err) => {
    logger.error({ err }, "Failed to initialize Addie chat client");
  });

  // =========================================================================
  // PAGE ROUTES (mounted at /chat)
  // =========================================================================

  // Note: The chat page (/chat -> chat.html) is served by the global middleware
  // in http.ts that handles extensionless paths. This middleware injects the
  // user config needed for the navigation bar. No explicit route needed here.

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

      // Build message with member context
      // For web chat, always include channel context (even for anonymous users)
      let messageToProcess = inputValidation.sanitized;
      try {
        if (req.user?.id) {
          // Authenticated user
          const memberContext = await getWebMemberContext(req.user.id);
          const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
          if (memberContextText) {
            messageToProcess = `${memberContextText}\n---\n\n${inputValidation.sanitized}`;
            logger.debug(
              { userId: req.user.id, hasContext: true, orgName: memberContext.organization?.name },
              "Addie Chat: Added member context to message"
            );
          }
        } else {
          // Anonymous user - still provide channel context
          const anonymousContext = { is_mapped: false, is_member: false, slack_linked: false };
          const memberContextText = formatMemberContextForPrompt(anonymousContext, 'web');
          if (memberContextText) {
            messageToProcess = `${memberContextText}\n---\n\n${inputValidation.sanitized}`;
            logger.debug("Addie Chat: Added anonymous web context to message");
          }
        }
      } catch (error) {
        logger.warn({ error, userId: req.user?.id }, "Addie Chat: Failed to get member context");
        // Continue without context - don't fail the request
      }

      // Process with Claude
      let response;
      try {
        response = await claudeClient.processMessage(messageToProcess, contextMessages);
      } catch (error) {
        logger.error({ error }, "Addie Chat: Error processing message");
        response = {
          text: "I'm sorry, I encountered an error. Please try again.",
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
      });

      res.json({
        response: outputValidation.sanitized,
        conversation_id: externalId, // Return external_id as conversation_id for API compatibility
        message_id: assistantMessage.message_id, // Now returns UUID instead of integer
        tools_used: response.tools_used,
        tool_executions: response.tool_executions,
        timing: response.timing,
        usage: response.usage,
        latency_ms: latencyMs,
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

      // Build message with member context
      let messageToProcess = inputValidation.sanitized;
      try {
        if (req.user?.id) {
          const memberContext = await getWebMemberContext(req.user.id);
          const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
          if (memberContextText) {
            messageToProcess = `${memberContextText}\n---\n\n${inputValidation.sanitized}`;
          }
        } else {
          const anonymousContext = { is_mapped: false, is_member: false, slack_linked: false };
          const memberContextText = formatMemberContextForPrompt(anonymousContext, 'web');
          if (memberContextText) {
            messageToProcess = `${memberContextText}\n---\n\n${inputValidation.sanitized}`;
          }
        }
      } catch (error) {
        logger.warn({ error }, "Addie Chat Stream: Failed to get member context");
      }

      // Stream the response
      let fullText = '';
      let response;
      const toolsUsed: string[] = [];

      for await (const event of claudeClient.processMessageStream(messageToProcess, contextMessages)) {
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
      });

      // Send done event with final metadata
      sendEvent("done", {
        conversation_id: externalId,
        message_id: assistantMessage.message_id,
        tools_used: toolsUsed,
        timing: response?.timing,
        usage: response?.usage,
        latency_ms: latencyMs,
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
      await threadService.addMessageFeedback(message_id, {
        rating,
        rating_category: rating_category || undefined,
        rating_notes: feedback_text || undefined,
        feedback_tags: feedback_tags || undefined,
        improvement_suggestion: improvement_suggestion || undefined,
        rated_by: req.user?.id || "anonymous",
      });

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

  // GET /api/addie/chat/:conversationId - Get conversation history
  apiRouter.get("/:conversationId", optionalAuth, async (req, res) => {
    const threadService = getThreadService();

    try {
      const { conversationId } = req.params;

      // Validate conversation ID format
      if (!isValidConversationId(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation ID format" });
      }

      // Get thread by external_id (which is the conversation_id for web)
      const thread = await threadService.getThreadByExternalId('web', conversationId);
      if (!thread) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Get messages
      const threadMessages = await threadService.getThreadMessages(thread.thread_id);
      const messages: ConversationMessage[] = threadMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      res.json({
        conversation_id: conversationId,
        user_name: thread.user_display_name,
        message_count: thread.message_count,
        messages,
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
