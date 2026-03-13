import crypto from "crypto";
import { Router, type Request } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createLogger } from "../logger.js";
import { AddieClaudeClient, type RequestTools } from "../addie/claude-client.js";
import {
  initializeKnowledgeSearch,
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
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
  isWebUserAAOAdmin,
} from "../addie/mcp/admin-tools.js";
import {
  EVENT_TOOLS,
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
import { PostgresStore } from "../middleware/pg-rate-limit-store.js";
import { sanitizeInput } from "../addie/security.js";
import { getThreadService } from "../addie/thread-service.js";
import { optionalAuth } from "../middleware/auth.js";
import {
  getWebMemberContext,
  formatMemberContextForPrompt,
  type MemberContext,
} from "../addie/member-context.js";
import { WorkingGroupDatabase } from "../db/working-group-db.js";

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
    claudeClient = new AddieClaudeClient(apiKey, AddieModelConfig.voice);
    await initializeKnowledgeSearch();
    const knowledgeHandlers = createKnowledgeToolHandlers();
    for (const tool of KNOWLEDGE_TOOLS) {
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

/**
 * Build user-scoped tools for a voice call, matching the web chat tool set.
 * This gives voice Addie the same capabilities as chat Addie.
 */
async function buildVoiceRequestTools(
  userId: string,
  threadId: string,
): Promise<{ requestTools: RequestTools; requestContext: string; memberContext: MemberContext | null }> {
  let memberContext: MemberContext | null = null;
  try {
    memberContext = await getWebMemberContext(userId);
  } catch (error) {
    logger.warn({ error, userId }, "Tavus: Failed to get member context");
  }

  // Format member context for system prompt
  const contextSections: string[] = [];
  if (memberContext) {
    const memberContextText = formatMemberContextForPrompt(memberContext, 'web');
    if (memberContextText) contextSections.push(memberContextText);
  }

  // Resolve linked Slack identity early — needed by escalation, collaboration, and committee tools
  const linkedSlackUserId = memberContext?.slack_user?.slack_user_id;

  // Build per-request tools (mirrors addie-chat.ts prepareRequestWithMemberTools)
  const allTools = [...MEMBER_TOOLS, ...SI_HOST_TOOLS, ...ADCP_TOOLS, ...ESCALATION_TOOLS, ...BILLING_TOOLS];
  const combinedHandlers = new Map([
    ...createMemberToolHandlers(memberContext),
    ...createSiHostToolHandlers(() => memberContext, () => threadId),
    ...createAdcpToolHandlers(memberContext),
    ...createEscalationToolHandlers(memberContext, linkedSlackUserId),
    ...createBillingToolHandlers(memberContext),
  ]);

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
    isWebUserAAOAdmin(userId),
    workingGroupDb.getCommitteesLedByUser(userId),
  ]);

  if (userIsAdmin) {
    allTools.push(...ADMIN_TOOLS);
    for (const [name, handler] of createAdminToolHandlers(memberContext)) {
      combinedHandlers.set(name, handler);
    }
    allTools.push(...EVENT_TOOLS);
    for (const [name, handler] of createEventToolHandlers(memberContext)) {
      combinedHandlers.set(name, handler);
    }
  }

  if (userIsAdmin || ledGroups.length > 0) {
    allTools.push(...MEETING_TOOLS);
    for (const [name, handler] of createMeetingToolHandlers(memberContext)) {
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
  };
}

// All LLM requests come from Tavus's infrastructure (same IP),
// so the limit must accommodate multiple concurrent video calls.
const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  store: new PostgresStore("tavus-llm:"),
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
  store: new PostgresStore("tavus-session:"),
  keyGenerator: (req) => (req as Request & { user?: { id: string } }).user?.id || ipKeyGenerator(req.ip || ""),
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
      const displayName = rawDisplayName.replace(/[\[\]<>{}]/g, "").slice(0, 100);

      // Create a thread to track this video conversation
      const threadService = getThreadService();
      const thread = await threadService.getOrCreateThread({
        channel: "video",
        external_id: conversationName,
        user_type: "workos",
        user_id: req.user.id,
        user_display_name: displayName,
        context: { persona_id: personaId },
      });

      const response = await fetch("https://tavusapi.com/v2/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": tavusApiKey,
        },
        body: JSON.stringify({
          persona_id: personaId,
          conversation_name: conversationName,
          custom_greeting: `Hi ${displayName.split(" ")[0]}, I'm Addie! How can I help you today?`,
          // Tavus appends this to the system message sent to our LLM endpoint,
          // letting us correlate LLM calls back to the thread.
          conversational_context: `[conductor:thread_id=${thread.thread_id}] The user's name is ${displayName}.`,
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
      return res.json({
        conversation_url: data.conversation_url,
        conversation_id: conversationName,
        thread_id: thread.thread_id,
        display_name: displayName,
      });
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

    // Extract thread_id from the system message injected via conversational_context
    const threadIdMatch = messages
      .filter((m) => m.role === "system")
      .map((m) => extractText(m.content))
      .join(" ")
      .match(/\[conductor:thread_id=([0-9a-f-]{36})\]/);
    const threadId = threadIdMatch?.[1] ?? null;
    if (!threadId) {
      logger.warn("Tavus LLM: No thread_id in system message — transcript will not be logged");
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

    // Look up the thread to get user identity and build user-scoped tools.
    // This gives voice Addie the same capabilities as chat Addie.
    let voiceRequestTools: RequestTools | undefined;
    let memberRequestContext = "";
    let userDisplayName: string | null = null;
    if (threadId) {
      const threadService = getThreadService();
      try {
        const thread = await threadService.getThread(threadId);
        if (thread?.user_id && thread.channel === 'video') {
          userDisplayName = thread.user_display_name;
          const result = await buildVoiceRequestTools(thread.user_id, threadId);
          voiceRequestTools = result.requestTools;
          memberRequestContext = result.requestContext;
          logger.debug(
            { userId: thread.user_id, toolCount: voiceRequestTools.tools.length },
            "Tavus: Built user-scoped tools for voice"
          );
        }
      } catch (err) {
        logger.warn({ err, threadId }, "Tavus: Failed to build user-scoped tools, using baseline");
      }
    }

    // Log the user message (before voice prefix is applied)
    if (threadId) {
      const threadService = getThreadService();
      threadService.addMessage({
        thread_id: threadId,
        role: "user",
        content: currentMessage,
      }).catch((err) => logger.error({ err }, "Tavus: Failed to log user message"));
    }

    // Wrap the user message with voice-mode instructions so they're adjacent
    // to the actual question (closer = stronger influence on the response).
    const voicePrefix =
      "[VOICE CALL — This will be spoken aloud. Keep it SHORT. No lists, no bullets, no markdown, no asterisks. " +
      "Greetings and small talk: one sentence. " +
      "Factual or yes/no questions: one to two sentences. " +
      "Conceptual questions: two to three sentences max — give the essence, not the full explanation. " +
      "Use natural spoken punctuation — pauses, em-dashes, commas — so it sounds " +
      "like a person talking, not reading from a document.]\n\n";
    currentMessage = voicePrefix + currentMessage;

    const voiceContextLines = [
      "VOICE MODE: This is a live video call. Your response will be spoken aloud.",
    ];
    if (userDisplayName) {
      voiceContextLines.push(`You are speaking with ${userDisplayName}. You already know their name — never ask for it.`);
    }
    voiceContextLines.push(
      "Match response length to the question — brief for simple questions, fuller for substantive ones.",
      "Never use formatting. Use conversational punctuation (ellipses, em-dashes) for natural pacing.",
      "When using tools, summarize results conversationally — don't read data verbatim.",
    );
    const voiceContext = voiceContextLines.join("\n");

    // Combine voice instructions with member context
    const requestContext = [voiceContext, memberRequestContext].filter(Boolean).join("\n\n");

    const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 28)}`;
    const created = Math.floor(Date.now() / 1000);
    const startTime = Date.now();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let connectionClosed = false;
    req.on("close", () => {
      connectionClosed = true;
      logger.debug("Tavus: Client disconnected during stream");
    });

    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      if (connectionClosed) return;
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
    const questionPattern = /\b(what|how|why|explain|tell me|describe|walk me through|can you|could you)\b/i;
    const rawMessage = currentMessage.slice(voicePrefix.length);
    const isSubstantive = rawMessage.length > 30 && questionPattern.test(rawMessage);
    let fullResponse = "";
    if (isSubstantive) {
      const fillers = [
        "Good question... ",
        "Great question... ",
        "So... ",
        "That's a great question... ",
      ];
      const filler = fillers[Math.floor(Math.random() * fillers.length)];
      sendChunk({ content: filler });
      // Filler is streamed to TTS but not included in fullResponse
      // so the stored transcript stays clean.
    }

    let streamError = false;
    try {
      for await (const event of claudeClient.processMessageStream(
        currentMessage,
        threadContext,
        voiceRequestTools,
        { requestContext }
      )) {
        if (connectionClosed) break;
        if (event.type === "text") {
          fullResponse += event.text;
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

    // Log the assistant response
    if (threadId && fullResponse) {
      const threadService = getThreadService();
      threadService.addMessage({
        thread_id: threadId,
        role: "assistant",
        content: fullResponse,
        model: AddieModelConfig.voice,
        latency_ms: Date.now() - startTime,
      }).catch((err) => logger.error({ err }, "Tavus: Failed to log assistant message"));
    }

    if (!streamError) {
      sendChunk({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return { pageRouter, apiRouter, llmRouter };
}
