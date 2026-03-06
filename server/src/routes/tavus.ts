import { Router, type Request } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../logger.js";
import { AddieClaudeClient } from "../addie/claude-client.js";
import {
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from "../addie/mcp/knowledge-search.js";
import { ANONYMOUS_SAFE_KNOWLEDGE_TOOLS } from "../mcp/chat-tool.js";
import { AddieModelConfig } from "../config/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("tavus-routes");

let claudeClient: AddieClaudeClient | null = null;
let initialized = false;

async function initializeTavusClient(): Promise<void> {
  if (initialized) return;

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
      if (handler) {
        claudeClient.registerTool(tool, handler);
      }
    }
  }

  initialized = true;
  logger.info("Tavus: Initialized Claude client with knowledge tools");
}

function validateLlmSecret(req: Request): boolean {
  const secret = process.env.TAVUS_LLM_SECRET;
  if (!secret) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;

  return authHeader.slice(7) === secret;
}

/**
 * Build conversation context from OpenAI-format message history.
 * Skips system messages — Addie uses her own DB-sourced system prompt.
 */
function buildThreadContext(
  messages: Array<{ role: string; content: string }>
): { currentMessage: string; threadContext: Array<{ user: string; text: string }> } | null {
  const chatMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  const lastUserIdx = chatMessages.reduceRight((found, m, i) =>
    found === -1 && m.role === "user" ? i : found, -1
  );

  if (lastUserIdx === -1) return null;

  const currentMessage = chatMessages[lastUserIdx].content;
  const history = chatMessages.slice(0, lastUserIdx);

  const threadContext = history.slice(-10).map((m) => ({
    user: m.role === "user" ? "User" : "Addie",
    text: m.content,
  }));

  return { currentMessage, threadContext };
}

export function createTavusRouter() {
  // Page router: serves GET /video
  const pageRouter = Router();
  pageRouter.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "../../public/video.html"));
  });

  // API router: POST /api/addie/video/session
  const apiRouter = Router();

  apiRouter.post("/session", async (_req, res) => {
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
          conversation_name: `addie-${Date.now()}`,
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

  llmRouter.post("/chat/completions", async (req, res) => {
    if (!validateLlmSecret(req)) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }

    await initializeTavusClient();

    if (!claudeClient) {
      return res.status(503).json({
        error: { message: "LLM not available" },
      });
    }

    const { messages } = req.body as {
      messages?: Array<{ role: string; content: string }>;
    };

    if (!messages?.length) {
      return res.status(400).json({ error: { message: "No messages provided" } });
    }

    const parsed = buildThreadContext(messages);
    if (!parsed) {
      return res.status(400).json({ error: { message: "No user message found" } });
    }

    const { currentMessage, threadContext } = parsed;
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 28)}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        model: "addie",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      res.write(`data: ${chunk}\n\n`);
    };

    sendChunk({ role: "assistant", content: "" });

    try {
      for await (const event of claudeClient.processMessageStream(
        currentMessage,
        threadContext
      )) {
        if (event.type === "text") {
          sendChunk({ content: event.text });
        } else if (event.type === "error") {
          logger.error({ error: event.error }, "Tavus: Addie stream error");
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, "Tavus: Streaming error");
    }

    sendChunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return { pageRouter, apiRouter, llmRouter };
}
