import crypto from "crypto";
import { Router, type Request } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createLogger } from "../logger.js";
import { AddieClaudeClient } from "../addie/claude-client.js";
import {
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from "../addie/mcp/knowledge-search.js";
import { ANONYMOUS_SAFE_KNOWLEDGE_TOOLS } from "../mcp/chat-tool.js";
import { AddieModelConfig } from "../config/models.js";
import { PostgresStore } from "../middleware/pg-rate-limit-store.js";
import { sanitizeInput } from "../addie/security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("tavus-routes");

let claudeClient: AddieClaudeClient | null = null;
let initPromise: Promise<void> | null = null;

async function initializeTavusClient(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn("Tavus: No ANTHROPIC_API_KEY configured");
      return;
    }
    claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.chat);
    await initializeKnowledgeSearch();
    const knowledgeHandlers = createKnowledgeToolHandlers();
    for (const tool of KNOWLEDGE_TOOLS) {
      if (ANONYMOUS_SAFE_KNOWLEDGE_TOOLS.has(tool.name)) {
        const handler = knowledgeHandlers.get(tool.name);
        if (handler) claudeClient.registerTool(tool, handler);
      }
    }
    logger.info("Tavus: Initialized Claude client with knowledge tools");
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

type RawMessage = { role: string; content: unknown };

/**
 * Extract text from an OpenAI content field (string or content-part array).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof (b as Record<string, unknown>)?.text === "string"
      )
      .map((b) => b.text)
      .join(" ");
  }
  return String(content);
}

/**
 * Build conversation context from OpenAI-format message history.
 * Skips system messages — Addie uses her own DB-sourced system prompt.
 */
function buildThreadContext(
  messages: RawMessage[]
): { currentMessage: string; threadContext: Array<{ user: string; text: string }> } | null {
  const chatMessages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: extractText(m.content) }));

  let lastUserIdx = -1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return null;

  const currentMessage = chatMessages[lastUserIdx].content;
  const history = chatMessages.slice(0, lastUserIdx);

  const threadContext = history.slice(-10).map((m) => ({
    user: m.role === "user" ? "User" : "Addie",
    text: m.content,
  }));

  return { currentMessage, threadContext };
}

// Rate limiters use ipKeyGenerator to handle Fly.io proxy headers correctly.

const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  store: new PostgresStore("tavus-llm:"),
  keyGenerator: (req) => ipKeyGenerator(req.ip || ""),
  message: { error: { message: "Too many requests" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit — each session call creates billable Tavus infrastructure.
const sessionRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  store: new PostgresStore("tavus-session:"),
  keyGenerator: (req) => ipKeyGenerator(req.ip || ""),
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

export function createTavusRouter() {
  // Page router: serves GET /video
  const pageRouter = Router();
  pageRouter.get("/", (_req, res) => {
    // Daily.co iframe needs camera, microphone, and autoplay permissions
    res.setHeader("Permissions-Policy", "camera=*, microphone=*, autoplay=*");
    res.sendFile(path.join(__dirname, "../../public/video.html"));
  });

  // API router: POST /api/addie/video/session
  const apiRouter = Router();

  apiRouter.post("/session", sessionRateLimiter, async (_req, res) => {
    const tavusApiKey = process.env.TAVUS_API_KEY;
    const personaId = process.env.TAVUS_PERSONA_ID;

    if (!tavusApiKey || !personaId) {
      return res.status(503).json({ error: "Video chat not configured" });
    }

    try {
      const response = await fetch("https://tavusapi.com/v2/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": tavusApiKey,
        },
        body: JSON.stringify({
          persona_id: personaId,
          conversation_name: `addie-${uuidv4()}`,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, error: errorText },
          "Tavus: Failed to create conversation"
        );
        return res.status(502).json({ error: "Failed to create video session" });
      }

      const data = (await response.json()) as { conversation_url: string };
      return res.json({ conversation_url: data.conversation_url });
    } catch (err) {
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

    await initializeTavusClient();

    if (!claudeClient) {
      return res.status(503).json({ error: { message: "LLM not available" } });
    }

    const { messages } = req.body as { messages?: RawMessage[] };

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: "No messages provided" } });
    }

    if (!messages.every((m) => typeof m.role === "string" && m.content !== undefined)) {
      return res.status(400).json({ error: { message: "Invalid messages format" } });
    }

    const parsed = buildThreadContext(messages);
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

    const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
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

    let streamError = false;
    try {
      for await (const event of claudeClient.processMessageStream(currentMessage, threadContext)) {
        if (event.type === "text") {
          sendChunk({ content: event.text });
        } else if (event.type === "error") {
          logger.error({ error: event.error }, "Tavus: Addie stream error");
          streamError = true;
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, "Tavus: Streaming error");
      streamError = true;
    }

    if (!streamError) {
      sendChunk({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return { pageRouter, apiRouter, llmRouter };
}
