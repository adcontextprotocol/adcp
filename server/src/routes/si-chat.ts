/**
 * SI (Sponsored Intelligence) Chat API Routes
 *
 * Provides direct API access to SI sessions for the chat modal.
 * Bypasses Addie relay for a more direct brand conversation experience.
 */

import { Router } from "express";
import cors from "cors";
import { createLogger } from "../logger.js";
import { optionalAuth } from "../middleware/auth.js";
import { siDb, type SiSession } from "../db/si-db.js";
import { siAgentService } from "../addie/services/si-agent-service.js";
import { query } from "../db/client.js";
import { sanitizeInput } from "../addie/security.js";

const logger = createLogger("si-chat-routes");

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
  allowedHeaders: ["Content-Type", "Authorization"],
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
    `SELECT id, display_name, slug, tagline, description, logo_url, brand_color
     FROM member_profiles
     WHERE id = $1`,
    [memberProfileId]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0];
}

/**
 * Verify user has access to an SI session
 * Sessions can be accessed by:
 * - The user who created it (matched by email or slack_id)
 * - Anonymous sessions (user_anonymous_id) - accessible by anyone with the session ID
 */
function verifySessionAccess(session: SiSession, userEmail?: string, userId?: string): boolean {
  // Anonymous sessions can be accessed by anyone with the session ID
  if (session.user_anonymous_id && !session.user_email && !session.user_slack_id) {
    return true;
  }

  // If session has an email, user must be authenticated with matching email
  if (session.user_email) {
    return !!userEmail && session.user_email === userEmail;
  }

  // If no auth required and no email on session, allow access
  // This handles edge cases where session was created without identity
  return true;
}

/**
 * Create SI chat routes
 */
export function createSiChatRoutes() {
  const apiRouter = Router();

  // Apply CORS for cross-origin support
  apiRouter.use(cors(siCorsOptions));

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
        ? await siDb.getSessionsByUser(userEmail, "email")
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

      const session = await siDb.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Verify user has access to this session
      if (!verifySessionAccess(session, req.user?.email, req.user?.id)) {
        return res.status(403).json({ error: "Not authorized to access this session" });
      }

      // Get brand profile for display
      let brand = null;
      if (session.member_profile_id) {
        brand = await getBrandProfile(session.member_profile_id);
      }

      // Get messages if requested (default: yes)
      let messages = null;
      if (includeMessages) {
        const sessionMessages = await siDb.getSessionMessages(sessionId);
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

      const session = await siDb.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Verify user has access to this session
      if (!verifySessionAccess(session, req.user?.email, req.user?.id)) {
        return res.status(403).json({ error: "Not authorized to access this session" });
      }

      const messages = await siDb.getSessionMessages(sessionId);

      res.json({
        session_id: sessionId,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          ui_elements: m.ui_elements,
          created_at: m.created_at,
        })),
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
  apiRouter.post("/sessions/:sessionId/messages", optionalAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { message, action_response } = req.body;

      if (!message && !action_response) {
        return res.status(400).json({ error: "Message or action_response required" });
      }

      const session = await siDb.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Verify user has access to this session
      if (!verifySessionAccess(session, req.user?.email, req.user?.id)) {
        return res.status(403).json({ error: "Not authorized to access this session" });
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
        actionResponse: action_response,
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
  apiRouter.post("/sessions/:sessionId/messages/stream", optionalAuth, async (req, res) => {
    const { sessionId } = req.params;
    const { message, action_response } = req.body;

    if (!message && !action_response) {
      return res.status(400).json({ error: "Message or action_response required" });
    }

    const session = await siDb.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Verify user has access to this session
    if (!verifySessionAccess(session, req.user?.email, req.user?.id)) {
      return res.status(403).json({ error: "Not authorized to access this session" });
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
        actionResponse: action_response,
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
      const reason = (req.body?.reason as string) || "user_exit";

      const session = await siDb.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Verify user has access to this session
      if (!verifySessionAccess(session, req.user?.email, req.user?.id)) {
        return res.status(403).json({ error: "Not authorized to access this session" });
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
