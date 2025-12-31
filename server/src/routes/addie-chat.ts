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
import { getPool } from "../db/client.js";
import { AddieClaudeClient } from "../addie/claude-client.js";
import {
  sanitizeInput,
  validateOutput,
  generateInteractionId,
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

  const model = process.env.ADDIE_ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  claudeClient = new AddieClaudeClient(apiKey, model);

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

  initialized = true;
  logger.info("Addie Chat: Initialized");
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Create a new conversation in the database
 */
async function createConversation(
  userId: string | null,
  userName: string | null,
  metadata?: Record<string, unknown>
): Promise<string> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO addie_conversations (user_id, user_name, channel, metadata)
     VALUES ($1, $2, 'web', $3)
     RETURNING conversation_id`,
    [userId, userName, JSON.stringify(metadata || {})]
  );
  return result.rows[0].conversation_id;
}

/**
 * Get conversation by ID
 */
async function getConversation(conversationId: string): Promise<{
  id: number;
  conversation_id: string;
  user_id: string | null;
  user_name: string | null;
  message_count: number;
} | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, conversation_id, user_id, user_name, message_count
     FROM addie_conversations
     WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows[0] || null;
}

/**
 * Get conversation messages
 */
async function getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT role, content
     FROM addie_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );
  return result.rows.map((row) => ({
    role: row.role as "user" | "assistant",
    content: row.content,
  }));
}

/**
 * Save a message to the conversation
 * Returns the message ID for feedback reference
 */
async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  options?: {
    toolUse?: unknown[];
    toolResults?: unknown[];
    tokensInput?: number;
    tokensOutput?: number;
    model?: string;
    latencyMs?: number;
  }
): Promise<number> {
  const pool = getPool();

  // Insert message and return ID
  const result = await pool.query(
    `INSERT INTO addie_messages (conversation_id, role, content, tool_use, tool_results, tokens_input, tokens_output, model, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      conversationId,
      role,
      content,
      options?.toolUse ? JSON.stringify(options.toolUse) : null,
      options?.toolResults ? JSON.stringify(options.toolResults) : null,
      options?.tokensInput || null,
      options?.tokensOutput || null,
      options?.model || null,
      options?.latencyMs || null,
    ]
  );

  // Update conversation
  await pool.query(
    `UPDATE addie_conversations
     SET message_count = message_count + 1,
         last_message_at = NOW()
     WHERE conversation_id = $1`,
    [conversationId]
  );

  return result.rows[0].id;
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

  // Chat page
  pageRouter.get("/", (req, res) => {
    const chatPath =
      process.env.NODE_ENV === "production"
        ? path.join(__dirname, "../../server/public/chat.html")
        : path.join(__dirname, "../../public/chat.html");
    res.sendFile(chatPath);
  });

  // =========================================================================
  // API ROUTES (mounted at /api/addie/chat)
  // =========================================================================

  // POST /api/addie/chat - Send a message and get a response
  apiRouter.post("/", chatRateLimiter, optionalAuth, async (req, res) => {
    const startTime = Date.now();

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

      // Get or create conversation
      let conversationId = conversation_id;
      if (!conversationId) {
        // Create new conversation
        const userId = req.user?.id || null;
        const displayName = user_name || req.user?.firstName || null;
        conversationId = await createConversation(userId, displayName, {
          user_agent: req.get("user-agent"),
          ip_hash: hashIp(req.ip), // Store hashed IP for privacy
        });
      } else {
        // Validate conversation ID format
        if (!isValidConversationId(conversationId)) {
          return res.status(400).json({ error: "Invalid conversation ID format" });
        }
        // Verify conversation exists
        const conversation = await getConversation(conversationId);
        if (!conversation) {
          return res.status(404).json({ error: "Conversation not found" });
        }
      }

      // Get conversation history for context
      const history = await getConversationMessages(conversationId);

      // Save user message
      await saveMessage(conversationId, "user", message);

      // Build context from history (last N messages)
      const contextMessages = history.slice(-10).map((m) => ({
        user: m.role === "user" ? "User" : "Addie",
        text: m.content,
      }));

      // Process with Claude
      let response;
      try {
        response = await claudeClient.processMessage(inputValidation.sanitized, contextMessages);
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
      const messageId = await saveMessage(conversationId, "assistant", outputValidation.sanitized, {
        toolUse: response.tools_used.length > 0 ? response.tools_used : undefined,
        toolResults: response.tool_executions.length > 0 ? response.tool_executions : undefined,
        model: process.env.ADDIE_ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        latencyMs,
      });

      res.json({
        response: outputValidation.sanitized,
        conversation_id: conversationId,
        message_id: messageId,  // Include for feedback reference
        tools_used: response.tools_used,
        tool_executions: response.tool_executions,
        timing: response.timing,
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

  // POST /api/addie/chat/:conversationId/feedback - Submit feedback on a message
  apiRouter.post("/:conversationId/feedback", optionalAuth, async (req, res) => {
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

      if (!message_id || typeof message_id !== "number") {
        return res.status(400).json({ error: "message_id is required" });
      }

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "rating must be between 1 and 5" });
      }

      const pool = getPool();

      // Verify message exists and belongs to conversation
      const messageCheck = await pool.query(
        `SELECT id FROM addie_messages
         WHERE id = $1 AND conversation_id = $2`,
        [message_id, conversationId]
      );

      if (messageCheck.rows.length === 0) {
        return res.status(404).json({ error: "Message not found" });
      }

      // Update message with feedback
      await pool.query(
        `UPDATE addie_messages
         SET rating = $1,
             rating_category = $2,
             feedback_text = $3,
             feedback_tags = $4,
             improvement_suggestion = $5,
             rated_by = $6,
             rated_at = NOW()
         WHERE id = $7`,
        [
          rating,
          rating_category || null,
          feedback_text || null,
          feedback_tags ? JSON.stringify(feedback_tags) : null,
          improvement_suggestion || null,
          req.user?.id || "anonymous",
          message_id,
        ]
      );

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
    try {
      const { conversationId } = req.params;

      // Validate conversation ID format
      if (!isValidConversationId(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation ID format" });
      }

      const conversation = await getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const messages = await getConversationMessages(conversationId);

      res.json({
        conversation_id: conversationId,
        user_name: conversation.user_name,
        message_count: conversation.message_count,
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
