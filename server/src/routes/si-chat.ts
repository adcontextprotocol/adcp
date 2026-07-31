/**
 * SI (Sponsored Intelligence) Chat API Routes
 *
 * Provides direct API access to SI sessions for the chat modal.
 * Bypasses Addie relay for a more direct brand conversation experience.
 */

import { Router, type Request } from "express";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createLogger } from "../logger.js";
import { optionalAuth } from "../middleware/auth.js";
import { siDb, type SiSession } from "../db/si-db.js";
import { siAgentService } from "../addie/services/si-agent-service.js";
import { query } from "../db/client.js";
import { resolveBrandFromJson } from "../db/brand-db.js";
import { sanitizeInput } from "../addie/security.js";
import { UsersDatabase } from "../db/users-db.js";
import { PostgresStore } from "../middleware/pg-rate-limit-store.js";
import {
  verifyAnonymousSessionCapability,
} from "./helpers/anonymous-session-capability.js";

const logger = createLogger("si-chat-routes");
const SI_ANONYMOUS_SESSION_AUDIENCE = 'si-session-owner';
const SI_ANONYMOUS_CAPABILITY_HEADER = 'X-SI-Session-Capability';
const SI_MESSAGE_MAX_CHARS = 4_000;
const SI_ACTION_RESPONSE_MAX_BYTES = 16 * 1024;
const SI_ACTION_RESPONSE_MAX_DEPTH = 6;
const SI_HISTORY_DEFAULT_LIMIT = 50;
const SI_HISTORY_MAX_LIMIT = 100;
const SI_HISTORY_MAX_OFFSET = 10_000;
const SI_TERMINATION_REASONS = new Set([
  'user_exit',
  'handoff_transaction',
  'handoff_complete',
  'session_timeout',
]);
const usersDb = new UsersDatabase();

const siModelRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new PostgresStore('si-model:'),
  keyGenerator: (req: Request) => req.user?.id
    ? `user:${req.user.id}`
    : `ip:${ipKeyGenerator(req.ip || 'unknown')}`,
  validate: { keyGeneratorIpFallback: false },
  handler: (_req, res) => res.status(429).json({
    error: 'Too many requests',
    message: 'Too many Sponsored Intelligence messages. Please try again shortly.',
  }),
});

// CORS configuration for native apps
const siCorsOptions: cors.CorsOptions = {
  origin: [
    /^tauri:\/\//,
    /^capacitor:\/\//,
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^https?:\/\/.*\.ngrok.*$/,
  ],
  credentials: true,
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", SI_ANONYMOUS_CAPABILITY_HEADER],
};

/**
 * Get brand profile info for the modal header
 */
async function getBrandProfile(memberProfileId: string): Promise<{
  id: string;
  display_name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  brand_color: string | null;
} | null> {
  const result = await query(
    `SELECT mp.id, mp.display_name, mp.slug, mp.tagline, mp.description,
            hb.brand_manifest AS brand_json
     FROM member_profiles mp
     LEFT JOIN organization_domains primary_od
       ON primary_od.workos_organization_id = mp.workos_organization_id
      AND primary_od.is_primary = true
     LEFT JOIN brands hb ON hb.domain = primary_od.domain
     WHERE mp.id = $1`,
    [memberProfileId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const bj = (row.brand_json as Record<string, unknown> | null) ?? {};
  const resolved = resolveBrandFromJson(row.slug, bj, false);
  return {
    id: row.id,
    display_name: row.display_name,
    slug: row.slug,
    tagline: row.tagline,
    description: row.description,
    logo_url: resolved.logo_url ?? null,
    brand_color: resolved.brand_color ?? null,
  };
}

/**
 * Verify user has access to an SI session
 * Sessions can be accessed by:
 * - The user who created it (matched by email or a linked Slack identity)
 * - Anonymous sessions presenting the signed, session-bound capability
 */
export function verifySessionAccess(
  session: SiSession,
  identity: {
    userEmail?: string;
    linkedSlackId?: string | null;
    anonymousCapability?: string;
  },
): boolean {
  if (session.user_email || session.user_slack_id) {
    const emailMatches = !!session.user_email && !!identity.userEmail &&
      session.user_email.trim().toLowerCase() === identity.userEmail.trim().toLowerCase();
    const slackMatches = !!session.user_slack_id && !!identity.linkedSlackId &&
      session.user_slack_id === identity.linkedSlackId;
    return emailMatches || slackMatches;
  }
  if (session.user_anonymous_id) {
    return !!verifyAnonymousSessionCapability(
      identity.anonymousCapability,
      SI_ANONYMOUS_SESSION_AUDIENCE,
      session.session_id,
    );
  }
  return false;
}

interface SiActionResponse {
  action: string;
  element_id?: string;
  payload?: Record<string, unknown>;
}

type SiMessageValidation =
  | { ok: true; message?: string; actionResponse?: SiActionResponse }
  | { ok: false; status: 400 | 413; error: string };

function exceedsDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (depth > SI_ACTION_RESPONSE_MAX_DEPTH) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => exceedsDepth(child, depth + 1));
}

export function validateSiMessageInput(body: unknown): SiMessageValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Request body must be an object' };
  }
  const input = body as Record<string, unknown>;
  const rawMessage = input.message;
  const rawActionResponse = input.action_response;

  if (rawMessage !== undefined && typeof rawMessage !== 'string') {
    return { ok: false, status: 400, error: 'Message must be a string' };
  }
  if (typeof rawMessage === 'string' && rawMessage.length > SI_MESSAGE_MAX_CHARS) {
    return { ok: false, status: 413, error: `Message exceeds ${SI_MESSAGE_MAX_CHARS} characters` };
  }
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : undefined;

  let actionResponse: SiActionResponse | undefined;
  if (rawActionResponse !== undefined) {
    if (!rawActionResponse || typeof rawActionResponse !== 'object' || Array.isArray(rawActionResponse)) {
      return { ok: false, status: 400, error: 'action_response must be an object' };
    }
    const actionInput = rawActionResponse as Record<string, unknown>;
    if (
      typeof actionInput.action !== 'string' ||
      actionInput.action.trim().length === 0 ||
      actionInput.action.length > 128
    ) {
      return { ok: false, status: 400, error: 'action_response.action must be a non-empty string' };
    }
    if (actionInput.element_id !== undefined && typeof actionInput.element_id !== 'string') {
      return { ok: false, status: 400, error: 'action_response.element_id must be a string' };
    }
    if (
      actionInput.payload !== undefined &&
      (!actionInput.payload || typeof actionInput.payload !== 'object' || Array.isArray(actionInput.payload))
    ) {
      return { ok: false, status: 400, error: 'action_response.payload must be an object' };
    }
    if (exceedsDepth(rawActionResponse, 1)) {
      return {
        ok: false,
        status: 400,
        error: `action_response exceeds maximum depth ${SI_ACTION_RESPONSE_MAX_DEPTH}`,
      };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(rawActionResponse);
    } catch {
      return { ok: false, status: 400, error: 'action_response must be JSON serializable' };
    }
    if (Buffer.byteLength(serialized, 'utf8') > SI_ACTION_RESPONSE_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `action_response exceeds ${SI_ACTION_RESPONSE_MAX_BYTES} bytes`,
      };
    }
    actionResponse = {
      action: actionInput.action.trim(),
      ...(typeof actionInput.element_id === 'string' && { element_id: actionInput.element_id }),
      ...(actionInput.payload && { payload: actionInput.payload as Record<string, unknown> }),
    };
  }

  if (!message && !actionResponse) {
    return { ok: false, status: 400, error: 'Message or action_response required' };
  }
  return { ok: true, ...(message && { message }), ...(actionResponse && { actionResponse }) };
}

export function parseSiHistoryPagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const parsedLimit = typeof query.limit === 'string' && /^\d+$/.test(query.limit)
    ? Number(query.limit)
    : NaN;
  const parsedOffset = typeof query.offset === 'string' && /^\d+$/.test(query.offset)
    ? Number(query.offset)
    : NaN;
  return {
    limit: Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), SI_HISTORY_MAX_LIMIT)
      : SI_HISTORY_DEFAULT_LIMIT,
    offset: Number.isSafeInteger(parsedOffset) ? Math.min(parsedOffset, SI_HISTORY_MAX_OFFSET) : 0,
  };
}

/**
 * Create SI chat routes
 */
export function createSiChatRoutes() {
  const apiRouter = Router();

  // Apply CORS for cross-origin support
  apiRouter.use(cors(siCorsOptions));

  async function loadAccessibleSession(req: Request): Promise<SiSession | null> {
    const sessionId = req.params.sessionId;
    const session = await siDb.getSession(sessionId);
    if (!session) return null;

    let linkedSlackId: string | null = null;
    if (session.user_slack_id && req.user?.id) {
      const user = await usersDb.getUser(req.user.id);
      linkedSlackId = user?.primary_slack_user_id ?? null;
    }

    return verifySessionAccess(session, {
      userEmail: req.user?.email,
      linkedSlackId,
      anonymousCapability: req.get(SI_ANONYMOUS_CAPABILITY_HEADER),
    }) ? session : null;
  }

  /**
   * GET /api/si/sessions/user
   * Get user's SI sessions for history sidebar
   */
  apiRouter.get("/sessions/user", optionalAuth, async (req, res) => {
    try {
      // Get user identifier from auth context
      const userId = req.user?.id;
      const userEmail = req.user?.email;

      if (!userId && !userEmail) {
        return res.json({ sessions: [] });
      }

      // Get sessions for this user (by email or slack_id)
      const userSessions = userEmail
        ? await siDb.getSessionsByUser(userEmail, "email", 100)
        : [];

      const recentSessions = userSessions
        .filter(s => s.status === "active" || s.message_count > 0)
        .slice(0, 20); // Limit to recent 20

      // Enrich with brand profile data
      const enrichedSessions = await Promise.all(
        recentSessions.map(async (s) => {
          let brandColor: string | null = null;
          let brandLogoUrl: string | null = null;

          if (s.member_profile_id) {
            const brand = await getBrandProfile(s.member_profile_id);
            brandColor = brand?.brand_color ?? null;
            brandLogoUrl = brand?.logo_url ?? null;
          }

          return {
            session_id: s.session_id,
            brand_name: s.brand_name,
            status: s.status,
            message_count: s.message_count,
            last_activity_at: s.last_activity_at,
            brand_color: brandColor,
            brand_logo_url: brandLogoUrl,
          };
        })
      );

      res.json({ sessions: enrichedSessions });
    } catch (error) {
      logger.error({ error }, "SI Chat: Error getting user sessions");
      res.status(500).json({ error: "Failed to get sessions" });
    }
  });

  /**
   * GET /api/si/sessions/:sessionId
   * Get session info for the modal header (with optional messages)
   */
  apiRouter.get("/sessions/:sessionId", optionalAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const includeMessages = req.query.messages !== "false";
      const pagination = parseSiHistoryPagination(req.query as Record<string, unknown>);

      const session = await loadAccessibleSession(req);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Get brand profile for display
      let brand = null;
      if (session.member_profile_id) {
        brand = await getBrandProfile(session.member_profile_id);
      }

      // Get messages if requested (default: yes)
      let messages = null;
      if (includeMessages) {
        const sessionMessages = await siDb.getSessionMessages(
          sessionId,
          pagination.limit,
          pagination.offset,
        );
        messages = sessionMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ui_elements: m.ui_elements,
          created_at: m.created_at,
        }));
      }

      res.json({
        session_id: session.session_id,
        brand_name: session.brand_name,
        status: session.status,
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        message_count: session.message_count,
        brand: brand ? {
          id: brand.id,
          name: brand.display_name,
          slug: brand.slug,
          tagline: brand.tagline,
          logo_url: brand.logo_url,
          brand_color: brand.brand_color,
        } : null,
        messages,
        ...(includeMessages && {
          pagination: { ...pagination, returned: messages?.length ?? 0 },
        }),
      });
    } catch (error) {
      logger.error({ error }, "SI Chat: Error getting session");
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  /**
   * GET /api/si/sessions/:sessionId/messages
   * Get conversation history for the session
   */
  apiRouter.get("/sessions/:sessionId/messages", optionalAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const pagination = parseSiHistoryPagination(req.query as Record<string, unknown>);

      const session = await loadAccessibleSession(req);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const messages = await siDb.getSessionMessages(
        sessionId,
        pagination.limit,
        pagination.offset,
      );

      res.json({
        session_id: sessionId,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ui_elements: m.ui_elements,
          created_at: m.created_at,
        })),
        pagination: { ...pagination, returned: messages.length },
      });
    } catch (error) {
      logger.error({ error }, "SI Chat: Error getting messages");
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  /**
   * POST /api/si/sessions/:sessionId/messages
   * Send a message to the SI agent (non-streaming)
   */
  apiRouter.post("/sessions/:sessionId/messages", optionalAuth, siModelRateLimiter, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const validation = validateSiMessageInput(req.body);
      if (!validation.ok) {
        return res.status(validation.status).json({ error: validation.error });
      }
      const { message, actionResponse } = validation;

      const session = await loadAccessibleSession(req);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (session.status !== "active") {
        return res.status(400).json({
          error: "Session is not active",
          status: session.status,
        });
      }

      // Sanitize user message if provided
      let sanitizedMessage = message;
      if (message) {
        const validation = sanitizeInput(message);
        if (validation.flagged) {
          logger.warn({ reason: validation.reason }, "SI Chat: Suspicious input detected");
        }
        sanitizedMessage = validation.sanitized;
      }

      // Send message through SI agent service
      const response = await siAgentService.sendMessage({
        sessionId,
        message: sanitizedMessage,
        actionResponse,
      });

      res.json({
        session_id: sessionId,
        brand_name: session.brand_name,
        response: {
          message: response.message,
          ui_elements: response.ui_elements,
          session_status: response.session_status,
          handoff: response.handoff,
          available_skills: response.available_skills,
        },
      });
    } catch (error) {
      logger.error({ error }, "SI Chat: Error sending message");
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  /**
   * POST /api/si/sessions/:sessionId/messages/stream
   * Send a message to the SI agent with streaming response (SSE)
   */
  apiRouter.post("/sessions/:sessionId/messages/stream", optionalAuth, siModelRateLimiter, async (req, res) => {
    const { sessionId } = req.params;
    const validation = validateSiMessageInput(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.error });
    }
    const { message, actionResponse } = validation;

    const session = await loadAccessibleSession(req);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.status !== "active") {
      return res.status(400).json({
        error: "Session is not active",
        status: session.status,
      });
    }

    // Sanitize user message if provided
    let sanitizedMessage = message;
    if (message) {
      const validation = sanitizeInput(message);
      if (validation.flagged) {
        logger.warn({ reason: validation.reason }, "SI Chat: Suspicious input detected");
      }
      sanitizedMessage = validation.sanitized;
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
    res.flushHeaders();

    try {
      // Stream response
      for await (const event of siAgentService.sendMessageStream({
        sessionId,
        message: sanitizedMessage,
        actionResponse,
      })) {
        if (event.type === "text") {
          res.write(`data: ${JSON.stringify({ type: "text", text: event.text })}\n\n`);
        } else if (event.type === "done") {
          res.write(`data: ${JSON.stringify({
            type: "done",
            session_id: sessionId,
            brand_name: session.brand_name,
            response: {
              message: event.response.message,
              ui_elements: event.response.ui_elements,
              session_status: event.response.session_status,
              handoff: event.response.handoff,
              available_skills: event.response.available_skills,
            },
          })}\n\n`);
        } else if (event.type === "error") {
          res.write(`data: ${JSON.stringify({ type: "error", error: event.error })}\n\n`);
        }
      }
    } catch (error) {
      logger.error({ error }, "SI Chat: Error in streaming response");
      res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to generate response" })}\n\n`);
    } finally {
      res.end();
    }
  });

  /**
   * DELETE /api/si/sessions/:sessionId
   * End an SI session
   */
  apiRouter.delete("/sessions/:sessionId", optionalAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const rawReason = req.body?.reason;
      const reason = rawReason === undefined ? 'user_exit' : rawReason;
      if (typeof reason !== 'string' || !SI_TERMINATION_REASONS.has(reason)) {
        return res.status(400).json({ error: 'Invalid termination reason' });
      }

      const session = await loadAccessibleSession(req);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const result = await siAgentService.terminateSession(sessionId, reason);

      res.json({
        success: true,
        session_id: sessionId,
        brand_name: session.brand_name,
        terminated: result.terminated,
        follow_up: result.follow_up,
      });
    } catch (error) {
      logger.error({ error }, "SI Chat: Error ending session");
      res.status(500).json({ error: "Failed to end session" });
    }
  });

  return { apiRouter };
}
