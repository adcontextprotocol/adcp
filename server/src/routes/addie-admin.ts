/**
 * Addie Admin routes module
 *
 * Admin routes for managing Addie's knowledge base and viewing interactions.
 */

import { Router } from "express";
import { validate as uuidValidate } from "uuid";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { AddieDatabase } from "../db/addie-db.js";
import { query } from "../db/client.js";
import { loadRules, loadResponseStyle } from "../addie/rules/index.js";

import {
  getThreadService,
  type ThreadChannel,
} from "../addie/thread-service.js";
import Anthropic from "@anthropic-ai/sdk";
import { ModelConfig } from "../config/models.js";
import { AddieRouter, type RoutingContext } from "../addie/router.js";
import { sanitizeInput } from "../addie/security.js";
import { runSlackHistoryBackfill } from "../addie/jobs/slack-history-backfill.js";
import { getWorkos } from "../auth/workos-client.js";
import {
  resolveSlackUserDisplayName,
  resolveSlackUserDisplayNames,
  sendDirectMessage,
} from "../slack/client.js";
import {
  listEscalations,
  countEscalations,
  getEscalation,
  updateEscalationStatus,
  getEscalationStats,
  setEscalationGithubIssue,
  buildResolutionNotificationMessage,
  type EscalationStatus,
  type EscalationCategory,
} from "../db/escalation-db.js";
import {
  listSuggestions,
  getSuggestion,
  recordDecision,
  releaseDecision,
  getSuggestionStats,
  type SuggestionConfidence,
} from "../db/escalation-triage-db.js";
import { runEscalationTriageJob } from "../addie/jobs/escalation-triage.js";
import { fileGitHubIssue } from "../addie/jobs/github-filer.js";
import * as imageDb from "../db/addie-image-db.js";
import {
  listInsights,
  getInsightByWeek,
} from "../db/conversation-insights-db.js";
import { runConversationInsightsJob } from "../addie/jobs/conversation-insights.js";

const logger = createLogger("addie-admin-routes");
const addieDb = new AddieDatabase();

// Lazy-initialized router (needs API key from env)
let addieRouter: AddieRouter | null = null;
function getAddieRouter(): AddieRouter {
  if (!addieRouter) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }
    addieRouter = new AddieRouter(apiKey);
  }
  return addieRouter;
}

/**
 * Helper to parse and validate a numeric ID parameter
 */
function parseNumericId(id: string): number | null {
  const parsed = parseInt(id, 10);
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

/**
 * Extract a stable label for who triggered an admin-triage decision. Prefers
 * the session email; falls back to a self-describing string so the audit
 * trail can't be confused with a user literally named "admin".
 */
function resolveReviewerLabel(req: unknown): string {
  const user = (req as { user?: { email?: string } }).user;
  return user?.email ?? 'triage-admin-fallback';
}

function isValidUuid(id: string): boolean {
  return uuidValidate(id);
}

/**
 * Parse a query string limit and clamp to [1, max].
 */
function clampLimit(raw: unknown, defaultVal: number, max = 200): number {
  const parsed = raw ? parseInt(raw as string, 10) : NaN;
  return isNaN(parsed) ? defaultVal : Math.min(Math.max(parsed, 1), max);
}

/**
 * Parse a query string offset and clamp to [0, max].
 */
function clampOffset(raw: unknown, max = 1_000_000): number {
  const parsed = raw ? parseInt(raw as string, 10) : NaN;
  return isNaN(parsed) ? 0 : Math.min(Math.max(parsed, 0), max);
}

/**
 * Create Addie admin routes
 * Returns separate routers for page routes (/admin/addie/*) and API routes (/api/admin/addie/*)
 */
export function createAddieAdminRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin/addie)
  // =========================================================================

  // Main Addie dashboard
  pageRouter.get("/", requireAuth, requireAdmin, (req, res) => {
    serveHtmlWithConfig(req, res, "admin-addie.html").catch((err) => {
      logger.error({ err }, "Error serving Addie admin page");
      res.status(500).send("Internal server error");
    });
  });

  // =========================================================================
  // KNOWLEDGE MANAGEMENT API (mounted at /api/admin/addie/knowledge)
  // =========================================================================

  // GET /api/admin/addie/knowledge - List all knowledge documents
  apiRouter.get("/knowledge", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { category, active_only, source_type, status, limit, offset } = req.query;

      const { rows: documents, total } = await addieDb.listKnowledge({
        category: category as string | undefined,
        sourceType: source_type as string | undefined,
        fetchStatus: status as string | undefined,
        activeOnly: active_only !== "false",
        limit: clampLimit(limit, 100, 500),
        offset: clampOffset(offset),
      });

      res.json({
        documents,
        total,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching knowledge documents");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch knowledge documents",
      });
    }
  });

  // GET /api/admin/addie/knowledge/categories - Get category list with counts
  apiRouter.get("/knowledge/categories", requireAuth, requireAdmin, async (req, res) => {
    try {
      const categories = await addieDb.getKnowledgeCategories();
      res.json({ categories });
    } catch (error) {
      logger.error({ err: error }, "Error fetching knowledge categories");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch knowledge categories",
      });
    }
  });

  // GET /api/admin/addie/knowledge/search - Search knowledge documents
  apiRouter.get("/knowledge/search", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { q, category, limit } = req.query;

      if (!q || typeof q !== "string") {
        return res.status(400).json({ error: "Search query (q) is required" });
      }

      const results = await addieDb.searchKnowledge(q, {
        category: category as string | undefined,
        limit: clampLimit(limit, 10, 100),
      });

      res.json({
        results,
        query: q,
        total: results.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error searching knowledge");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to search knowledge",
      });
    }
  });

  // GET /api/admin/addie/knowledge/:id - Get a specific knowledge document
  apiRouter.get("/knowledge/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid document ID" });
      }

      const document = await addieDb.getKnowledgeById(numericId);

      if (!document) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }

      res.json(document);
    } catch (error) {
      logger.error({ err: error }, "Error fetching knowledge document");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch knowledge document",
      });
    }
  });

  // POST /api/admin/addie/knowledge - Create a new knowledge document
  apiRouter.post("/knowledge", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { title, category, content, source_url } = req.body;

      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "Title is required" });
      }
      if (!category || typeof category !== "string") {
        return res.status(400).json({ error: "Category is required" });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Content is required" });
      }

      const document = await addieDb.createKnowledge({
        title,
        category,
        content,
        source_url,
        created_by: req.user?.id || "admin",
      });

      logger.info({ documentId: document.id, title }, "Created knowledge document");
      res.status(201).json(document);
    } catch (error) {
      logger.error({ err: error }, "Error creating knowledge document");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create knowledge document",
      });
    }
  });

  // PUT /api/admin/addie/knowledge/:id - Update a knowledge document
  apiRouter.put("/knowledge/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid document ID" });
      }
      const { title, category, content, source_url } = req.body;

      const document = await addieDb.updateKnowledge(numericId, {
        title,
        category,
        content,
        source_url,
      });

      if (!document) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }

      logger.info({ documentId: document.id }, "Updated knowledge document");
      res.json(document);
    } catch (error) {
      logger.error({ err: error }, "Error updating knowledge document");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to update knowledge document",
      });
    }
  });

  // PUT /api/admin/addie/knowledge/:id/active - Toggle active status
  apiRouter.put("/knowledge/:id/active", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid document ID" });
      }
      const { is_active } = req.body;

      if (typeof is_active !== "boolean") {
        return res.status(400).json({ error: "is_active (boolean) is required" });
      }

      const document = await addieDb.setKnowledgeActive(numericId, is_active);

      if (!document) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }

      logger.info({ documentId: document.id, isActive: is_active }, "Toggled knowledge document active status");
      res.json(document);
    } catch (error) {
      logger.error({ err: error }, "Error toggling knowledge active status");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to toggle knowledge active status",
      });
    }
  });

  // DELETE /api/admin/addie/knowledge/:id - Delete a knowledge document
  apiRouter.delete("/knowledge/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid document ID" });
      }
      const deleted = await addieDb.deleteKnowledge(numericId);

      if (!deleted) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }

      logger.info({ documentId: numericId }, "Deleted knowledge document");
      res.json({ success: true, id: numericId });
    } catch (error) {
      logger.error({ err: error }, "Error deleting knowledge document");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to delete knowledge document",
      });
    }
  });

  // =========================================================================
  // INTERACTION LOGGING API (mounted at /api/admin/addie/interactions)
  // =========================================================================

  // GET /api/admin/addie/interactions - List interactions (audit log)
  apiRouter.get("/interactions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { flagged_only, unreviewed_only, user_id, limit, offset } = req.query;

      const interactions = await addieDb.getInteractions({
        flaggedOnly: flagged_only === "true",
        unreviewedOnly: unreviewed_only === "true",
        userId: user_id as string | undefined,
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
      });

      res.json({
        interactions,
        total: interactions.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching interactions");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch interactions",
      });
    }
  });

  // GET /api/admin/addie/interactions/stats - Get interaction statistics
  apiRouter.get("/interactions/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { days } = req.query;

      const stats = await addieDb.getInteractionStats({
        days: days ? parseInt(days as string, 10) : 30,
      });

      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching interaction stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch interaction statistics",
      });
    }
  });

  // PUT /api/admin/addie/interactions/:id/review - Mark an interaction as reviewed
  apiRouter.put("/interactions/:id/review", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      await addieDb.markInteractionReviewed(id, req.user?.id || "admin");

      logger.info({ interactionId: id }, "Marked interaction as reviewed");
      res.json({ success: true, id });
    } catch (error) {
      logger.error({ err: error }, "Error marking interaction as reviewed");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to mark interaction as reviewed",
      });
    }
  });

  // =========================================================================
  // UNIFIED THREADS API (mounted at /api/admin/addie/threads)
  // This is the new unified model that replaces both interactions and conversations
  // =========================================================================

  // GET /api/admin/addie/threads - List all threads (unified view across channels)
  apiRouter.get("/threads", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const {
        channel, flagged_only, unreviewed_only, has_user_feedback,
        min_messages, user_id, since, limit, offset,
        search, tool, user_search
      } = req.query;

      const threads = await threadService.listThreads({
        channel: channel as ThreadChannel | undefined,
        flagged_only: flagged_only === "true",
        unreviewed_only: unreviewed_only === "true",
        has_user_feedback: has_user_feedback === "true",
        min_messages: min_messages ? parseInt(min_messages as string, 10) : undefined,
        user_id: user_id as string | undefined,
        since: since ? new Date(since as string) : undefined,
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
        // Search filters (with length limits to prevent performance issues)
        search_text: typeof search === 'string' && search.length <= 500 ? search : undefined,
        tool_name: typeof tool === 'string' && tool.length <= 100 ? tool : undefined,
        user_search: typeof user_search === 'string' && user_search.length <= 200 ? user_search : undefined,
      });

      res.json({
        threads,
        total: threads.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching threads");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch threads",
      });
    }
  });

  // GET /api/admin/addie/threads/stats - Get unified thread statistics
  apiRouter.get("/threads/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { timeframe } = req.query;

      // Validate timeframe parameter
      const validTimeframes = ['24h', '7d', '30d', 'all'] as const;
      const tf = validTimeframes.includes(timeframe as typeof validTimeframes[number])
        ? (timeframe as '24h' | '7d' | '30d' | 'all')
        : 'all';

      const stats = await threadService.getStats(tf);
      const channelStats = await threadService.getChannelStats(tf);

      res.json({
        ...stats,
        by_channel: channelStats,
        timeframe: tf,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching thread stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch thread statistics",
      });
    }
  });

  // GET /api/admin/addie/threads/performance - Get tool performance metrics
  // NOTE: Must be defined BEFORE /threads/:id to avoid matching "performance" as an ID
  // Accepts days param (can be fractional, e.g., 0.125 for 3 hours)
  apiRouter.get("/threads/performance", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { days } = req.query;
      const daysNum = days ? parseFloat(days as string) : 7;

      // Validate days parameter
      if (isNaN(daysNum) || daysNum <= 0 || daysNum > 365) {
        return res.status(400).json({
          error: "Invalid parameter",
          message: "days must be a number between 0 and 365",
        });
      }

      // Convert days to hours for the service (supports fractional days)
      const hours = Math.round(daysNum * 24);

      const performance = await threadService.getPerformanceMetrics(hours);
      res.json(performance);
    } catch (error) {
      logger.error({ err: error }, "Error fetching performance metrics");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch performance metrics",
      });
    }
  });

  // GET /api/admin/addie/threads/tools - Get list of available tool names for filtering
  // NOTE: Must be defined BEFORE /threads/:id to avoid matching "tools" as an ID
  apiRouter.get("/threads/tools", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const tools = await threadService.getAvailableTools();
      res.json({ tools });
    } catch (error) {
      logger.error({ err: error }, "Error fetching available tools");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch available tools",
      });
    }
  });

  // GET /api/admin/addie/threads/:id - Get a single thread with messages
  apiRouter.get("/threads/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "Invalid thread ID" });
      }

      const thread = await threadService.getThreadWithMessages(id);

      if (!thread) {
        return res.status(404).json({ error: "Thread not found" });
      }

      // Collect all Slack user IDs that need resolution
      const userIdsToResolve: string[] = [];
      const slackMentionRegex = /<@(U[A-Z0-9]+)>/g;

      // Add thread owner
      if (thread.user_id && thread.channel === "slack") {
        userIdsToResolve.push(thread.user_id);
      }

      // Extract from all message content
      for (const msg of thread.messages) {
        if (msg.content) {
          let match;
          while ((match = slackMentionRegex.exec(msg.content)) !== null) {
            userIdsToResolve.push(match[1]);
          }
        }
      }

      // Resolve all user names with concurrency limiting
      const userNames = await resolveSlackUserDisplayNames(userIdsToResolve);

      // Get display name for thread owner (may already be resolved above)
      let displayName: string | null = thread.user_display_name;
      if (!displayName && thread.user_id && thread.channel === "slack") {
        displayName = userNames[thread.user_id] ?? null;
      }

      res.json({
        ...thread,
        user_display_name: displayName || thread.user_display_name,
        user_names: userNames,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching thread");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch thread",
      });
    }
  });

  // PUT /api/admin/addie/threads/:id/review - Mark a thread as reviewed
  apiRouter.put("/threads/:id/review", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { id } = req.params;
      const { notes } = req.body;

      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "Invalid thread ID" });
      }

      await threadService.reviewThread(id, req.user?.id || "admin", notes);

      logger.info({ threadId: id }, "Marked thread as reviewed");
      res.json({ success: true, thread_id: id });
    } catch (error) {
      logger.error({ err: error }, "Error marking thread as reviewed");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to mark thread as reviewed",
      });
    }
  });

  // PUT /api/admin/addie/threads/:id/flag - Flag a thread
  apiRouter.put("/threads/:id/flag", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { id } = req.params;
      const { reason } = req.body;

      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "Invalid thread ID" });
      }

      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Flag reason is required" });
      }

      await threadService.flagThread(id, reason);

      logger.info({ threadId: id, reason }, "Flagged thread");
      res.json({ success: true, thread_id: id });
    } catch (error) {
      logger.error({ err: error }, "Error flagging thread");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to flag thread",
      });
    }
  });

  // PUT /api/admin/addie/threads/:id/unflag - Unflag a thread
  apiRouter.put("/threads/:id/unflag", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { id } = req.params;

      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "Invalid thread ID" });
      }

      await threadService.unflagThread(id);

      logger.info({ threadId: id }, "Unflagged thread");
      res.json({ success: true, thread_id: id });
    } catch (error) {
      logger.error({ err: error }, "Error unflagging thread");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to unflag thread",
      });
    }
  });

  // PUT /api/admin/addie/threads/messages/:messageId/feedback - Add feedback to a message
  apiRouter.put("/threads/messages/:messageId/feedback", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { messageId } = req.params;
      const { rating, rating_category, rating_notes, feedback_tags, improvement_suggestion } = req.body;

      if (!isValidUuid(messageId)) {
        return res.status(400).json({ error: "Invalid message ID" });
      }

      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 5" });
      }

      const updated = await threadService.addMessageFeedback(messageId, {
        rating,
        rating_category,
        rating_notes,
        feedback_tags,
        improvement_suggestion,
        rated_by: req.user?.id || "admin",
        rating_source: 'admin',
      });

      if (!updated) {
        logger.warn({ messageId }, "No message found to add feedback to");
        return res.status(404).json({ error: "Message not found" });
      }

      // Also mark the thread as reviewed when admin provides feedback
      const threadResult = await query<{ thread_id: string }>(
        `SELECT thread_id FROM addie_thread_messages WHERE message_id = $1`,
        [messageId]
      );
      if (threadResult.rows[0]) {
        try {
          await threadService.reviewThread(
            threadResult.rows[0].thread_id,
            req.user?.id || "admin",
            rating_notes || undefined
          );
        } catch (reviewError) {
          // Log but don't fail - feedback was saved successfully
          logger.warn({ err: reviewError, threadId: threadResult.rows[0].thread_id }, "Failed to mark thread as reviewed after feedback");
        }
      }

      logger.info({ messageId, rating, ratingSource: 'admin' }, "Added feedback to message");
      res.json({ success: true, message_id: messageId });
    } catch (error) {
      logger.error({ err: error }, "Error adding message feedback");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to add message feedback",
      });
    }
  });

  // PUT /api/admin/addie/threads/messages/:messageId/outcome - Set outcome on a message
  apiRouter.put("/threads/messages/:messageId/outcome", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { messageId } = req.params;
      const { outcome, user_sentiment, intent_category } = req.body;

      if (!isValidUuid(messageId)) {
        return res.status(400).json({ error: "Invalid message ID" });
      }

      const validOutcomes = ["resolved", "partially_resolved", "unresolved", "escalated", "unknown"];
      if (!outcome || !validOutcomes.includes(outcome)) {
        return res.status(400).json({ error: `Outcome must be one of: ${validOutcomes.join(", ")}` });
      }

      await threadService.setMessageOutcome(messageId, outcome, user_sentiment, intent_category);

      logger.info({ messageId, outcome }, "Set message outcome");
      res.json({ success: true, message_id: messageId });
    } catch (error) {
      logger.error({ err: error }, "Error setting message outcome");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to set message outcome",
      });
    }
  });

  // PUT /api/admin/addie/threads/messages/:messageId/flag - Flag a message
  apiRouter.put("/threads/messages/:messageId/flag", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { messageId } = req.params;
      const { reason } = req.body;

      if (!isValidUuid(messageId)) {
        return res.status(400).json({ error: "Invalid message ID" });
      }

      if (!reason || typeof reason !== "string") {
        return res.status(400).json({ error: "Flag reason is required" });
      }

      await threadService.flagMessage(messageId, reason);

      logger.info({ messageId, reason }, "Flagged message");
      res.json({ success: true, message_id: messageId });
    } catch (error) {
      logger.error({ err: error }, "Error flagging message");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to flag message",
      });
    }
  });

  // POST /api/admin/addie/threads/:id/diagnose - Get Claude's analysis of a thread
  apiRouter.post("/threads/:id/diagnose", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Verify API key is configured
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.warn("ANTHROPIC_API_KEY not configured for diagnosis endpoint");
        return res.status(500).json({
          error: "Configuration error",
          message: "Claude API not configured",
        });
      }

      const threadService = getThreadService();
      const { id } = req.params;
      const { feedback } = req.body;

      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "Invalid thread ID" });
      }

      // Sanitize feedback input - limit length and escape special chars
      const sanitizedFeedback = feedback
        ? String(feedback).substring(0, 1000).replace(/["\n\r]/g, ' ').trim()
        : '';

      // Get thread with messages
      const thread = await threadService.getThreadWithMessages(id);
      if (!thread) {
        return res.status(404).json({ error: "Thread not found" });
      }

      // Build context for Claude analysis
      const messagesContext = thread.messages.map(m => {
        const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Addie' : m.role;
        let content = `[${roleLabel}]: ${m.content}`;
        if (m.tools_used && m.tools_used.length > 0) {
          content += `\n  Tools used: ${m.tools_used.join(', ')}`;
        }
        if (m.latency_ms) {
          content += `\n  Latency: ${m.latency_ms}ms`;
        }
        if (m.rating) {
          content += `\n  Rating: ${m.rating}/5`;
          if (m.rating_notes) {
            content += ` - "${m.rating_notes}"`;
          }
        }
        return content;
      }).join('\n\n');

      // Call Claude for diagnosis
      const client = new Anthropic({ apiKey });

      const diagnosisPrompt = `You are analyzing an Addie conversation to help improve our AI assistant. Addie is an AI assistant for the AgenticAdvertising.org community that helps with questions about AdCP (Advertising Context Protocol) and agentic advertising.

Here is the conversation:
---
${messagesContext}
---

${sanitizedFeedback ? `Admin provided this optional context: ${sanitizedFeedback}` : ''}

Please analyze this conversation and provide:

1. **Response Quality Assessment** (1-2 sentences)
   - Was the response accurate, helpful, and appropriately detailed?

2. **What Worked Well** (bullet points)
   - Specific strengths of the response

3. **What Could Be Improved** (bullet points)
   - Specific issues or gaps
   - Missed opportunities

4. **Suggested Rule Changes** (if any)
   - Specific behavior rules that could prevent issues like this
   - Format as actionable prompts/instructions

5. **Training Data Quality**
   - Is this a good example for training? Why or why not?
   - What label would you give it? (excellent, good, needs_improvement, poor)

Be specific and actionable. Focus on patterns that could help improve Addie's behavior.`;

      const response = await client.messages.create({
        model: ModelConfig.primary,
        max_tokens: 1500,
        messages: [{ role: 'user', content: diagnosisPrompt }],
      });

      const analysis = response.content[0].type === 'text' ? response.content[0].text : '';

      logger.info({ threadId: id }, "Generated Claude diagnosis for thread");
      res.json({
        thread_id: id,
        analysis,
        tokens_used: response.usage.input_tokens + response.usage.output_tokens,
      });
    } catch (error) {
      // Handle Claude API specific errors
      if (error instanceof Anthropic.APIError) {
        logger.error({ err: error, status: error.status }, "Claude API error in diagnosis");
        if (error.status === 429) {
          return res.status(429).json({
            error: "Rate limited",
            message: "Too many requests, please try again later",
          });
        }
      }
      logger.error({ err: error }, "Error generating thread diagnosis");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to generate diagnosis",
      });
    }
  });

  // GET /api/admin/addie/feedback/summary - Get aggregated feedback stats for dashboard
  apiRouter.get("/feedback/summary", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { days = '30' } = req.query;
      // Validate and clamp days to reasonable range (1-365)
      const daysInt = Math.min(Math.max(parseInt(days as string, 10) || 30, 1), 365);

      // Get summary stats
      const summaryResult = await query<{
        total_responses: string;
        rated_responses: string;
        avg_rating: string | null;
        positive_count: string;
        negative_count: string;
        avg_latency_ms: string | null;
        flagged_count: string;
      }>(`
        SELECT
          COUNT(*) as total_responses,
          COUNT(*) FILTER (WHERE rating IS NOT NULL) as rated_responses,
          ROUND(AVG(rating), 2) as avg_rating,
          COUNT(*) FILTER (WHERE rating >= 4) as positive_count,
          COUNT(*) FILTER (WHERE rating <= 2) as negative_count,
          ROUND(AVG(latency_ms), 0) as avg_latency_ms,
          COUNT(*) FILTER (WHERE flagged) as flagged_count
        FROM addie_thread_messages
        WHERE role = 'assistant'
          AND created_at > NOW() - make_interval(days => $1)
      `, [daysInt]);

      // Get feedback tags distribution
      const tagsResult = await query<{ tag: string; count: string }>(`
        SELECT tag, COUNT(*) as count
        FROM addie_thread_messages,
             LATERAL jsonb_array_elements_text(COALESCE(feedback_tags, '[]'::jsonb)) as tag
        WHERE role = 'assistant'
          AND created_at > NOW() - make_interval(days => $1)
        GROUP BY tag
        ORDER BY count DESC
      `, [daysInt]);

      // Get daily trend
      const trendResult = await query<{
        date: string;
        total: string;
        rated: string;
        avg_rating: string | null;
      }>(`
        SELECT
          DATE_TRUNC('day', created_at)::date as date,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE rating IS NOT NULL) as rated,
          ROUND(AVG(rating), 2) as avg_rating
        FROM addie_thread_messages
        WHERE role = 'assistant'
          AND created_at > NOW() - make_interval(days => $1)
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY date DESC
        LIMIT 30
      `, [daysInt]);

      // Get low-rated threads for review
      const lowRatedResult = await query<{
        thread_id: string;
        channel: string;
        rating: number;
        rating_notes: string | null;
        content: string;
        created_at: Date;
      }>(`
        SELECT
          m.thread_id,
          t.channel,
          m.rating,
          m.rating_notes,
          LEFT(m.content, 200) as content,
          m.created_at
        FROM addie_thread_messages m
        JOIN addie_threads t ON m.thread_id = t.thread_id
        WHERE m.role = 'assistant'
          AND m.rating IS NOT NULL
          AND m.rating <= 2
          AND m.created_at > NOW() - make_interval(days => $1)
        ORDER BY m.created_at DESC
        LIMIT 10
      `, [daysInt]);

      res.json({
        summary: summaryResult.rows[0],
        tags: tagsResult.rows,
        trend: trendResult.rows,
        low_rated: lowRatedResult.rows,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching feedback summary");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch feedback summary",
      });
    }
  });

  // =========================================================================
  // WEB CONVERSATIONS API (mounted at /api/admin/addie/conversations)
  // DEPRECATED: Use /api/admin/addie/threads instead
  // =========================================================================

  // GET /api/admin/addie/conversations - List all web conversations
  apiRouter.get("/conversations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit, offset } = req.query;

      const conversations = await addieDb.getWebConversations({
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
      });

      res.json({
        conversations,
        total: conversations.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching web conversations");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch web conversations",
      });
    }
  });

  // GET /api/admin/addie/conversations/stats - Get conversation statistics
  // NOTE: Must be defined BEFORE /conversations/:id to avoid matching "stats" as an ID
  apiRouter.get("/conversations/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await addieDb.getWebConversationStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching conversation stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch conversation statistics",
      });
    }
  });

  // GET /api/admin/addie/conversations/:id - Get a single conversation with messages
  apiRouter.get("/conversations/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      const conversation = await addieDb.getWebConversationWithMessages(id);

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      res.json(conversation);
    } catch (error) {
      logger.error({ err: error }, "Error fetching conversation");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch conversation",
      });
    }
  });

  // =========================================================================
  // LISTING BACKLOG API
  // =========================================================================

  // GET /api/admin/addie/listings/unpublished-backlog
  // Orgs with an active membership whose directory listing is missing or not
  // public. Use for cleanup of the pre-autopublish backlog.
  apiRouter.get("/listings/unpublished-backlog", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit, offset } = req.query;
      const lim = clampLimit(limit, 25);
      const off = clampOffset(offset);

      const rowsResult = await query<{
        workos_organization_id: string;
        name: string;
        subscription_status: string;
        subscription_current_period_end: Date | null;
        membership_tier: string | null;
        profile_id: string | null;
        slug: string | null;
        display_name: string | null;
      }>(
        `SELECT
           o.workos_organization_id,
           o.name,
           o.subscription_status,
           o.subscription_current_period_end,
           o.membership_tier,
           mp.id AS profile_id,
           mp.slug,
           mp.display_name
         FROM organizations o
         LEFT JOIN member_profiles mp
           ON mp.workos_organization_id = o.workos_organization_id
         WHERE o.subscription_status IN ('active', 'trialing', 'past_due')
           AND (mp.id IS NULL OR mp.is_public = FALSE)
         ORDER BY o.subscription_current_period_end DESC NULLS LAST,
                  o.name ASC
         LIMIT $1 OFFSET $2`,
        [lim, off],
      );

      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM organizations o
         LEFT JOIN member_profiles mp
           ON mp.workos_organization_id = o.workos_organization_id
         WHERE o.subscription_status IN ('active', 'trialing', 'past_due')
           AND (mp.id IS NULL OR mp.is_public = FALSE)`,
      );

      res.json({
        backlog: rowsResult.rows.map(row => ({
          ...row,
          has_profile: row.profile_id !== null,
        })),
        page: { limit: lim, offset: off },
        total: Number(countResult.rows[0]?.total ?? 0),
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching unpublished-listing backlog");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch unpublished listing backlog",
      });
    }
  });

  // =========================================================================
  // CONFIG VERSION API (mounted at /api/admin/addie/config)
  // =========================================================================

  // GET /api/admin/addie/config/current - Get current config version info
  apiRouter.get("/config/current", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const configVersion = await addieDb.getCurrentConfigVersion();
      res.json({ config_version: configVersion });
    } catch (error) {
      logger.error({ err: error }, "Error fetching current config version");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch config version",
      });
    }
  });

  // GET /api/admin/addie/config/history - Get config version history
  apiRouter.get("/config/history", requireAuth, requireAdmin, async (req, res) => {
    try {
      const history = await addieDb.getConfigVersionHistory(clampLimit(req.query.limit, 20, 100));
      res.json({ versions: history });
    } catch (error) {
      logger.error({ err: error }, "Error fetching config version history");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch config history",
      });
    }
  });

  // =========================================================================
  // SYSTEM PROMPT API
  // =========================================================================

  // GET /api/admin/addie/system-prompt - Get the compiled system prompt (from MD files)
  apiRouter.get("/system-prompt", requireAuth, requireAdmin, (_req, res) => {
    try {
      // Same shape as claude-client.ts assembly minus the tool reference,
      // which is autogenerated and lives in code rather than rule files.
      const systemPrompt = `${loadRules()}\n\n---\n\n${loadResponseStyle()}`;
      res.json({ system_prompt: systemPrompt });
    } catch (error) {
      logger.error({ err: error }, "Error building system prompt");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to build system prompt",
      });
    }
  });

  // =========================================================================
  // INTERACTIONS RATING API (mounted at /api/admin/addie/interactions)
  // =========================================================================

  // PUT /api/admin/addie/interactions/:id/rate - Rate an interaction
  apiRouter.put("/interactions/:id/rate", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { rating, notes, outcome, user_sentiment, intent_category } = req.body;

      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 5" });
      }

      await addieDb.rateInteraction(id, rating, req.user?.id || "admin", {
        notes,
        outcome,
        user_sentiment,
        intent_category,
      });

      logger.info({ interactionId: id, rating }, "Rated interaction");
      res.json({ success: true, id, rating });
    } catch (error) {
      logger.error({ err: error }, "Error rating interaction");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to rate interaction",
      });
    }
  });

  // =========================================================================
  // CURATED RESOURCES API (mounted at /api/admin/addie/resources)
  // =========================================================================

  // GET /api/admin/addie/resources - List curated resources
  apiRouter.get("/resources", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status, limit, offset } = req.query;

      const resources = await addieDb.listCuratedResources({
        status: status as string | undefined,
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
      });

      res.json({
        resources,
        total: resources.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching curated resources");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch curated resources",
      });
    }
  });

  // GET /api/admin/addie/resources/stats - Get curated resource statistics
  apiRouter.get("/resources/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await addieDb.getCuratedResourceStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching resource stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch resource statistics",
      });
    }
  });

  // GET /api/admin/addie/resources/:id - Get a specific resource
  apiRouter.get("/resources/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid resource ID" });
      }

      const resource = await addieDb.getKnowledgeById(numericId);

      if (!resource) {
        return res.status(404).json({ error: "Resource not found" });
      }

      res.json(resource);
    } catch (error) {
      logger.error({ err: error }, "Error fetching resource");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch resource",
      });
    }
  });

  // PUT /api/admin/addie/resources/:id - Update resource (mainly for editing addie_notes)
  apiRouter.put("/resources/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid resource ID" });
      }

      const { addie_notes, quality_score, relevance_tags } = req.body;

      const resource = await addieDb.updateCuratedResource(numericId, {
        addie_notes,
        quality_score,
        relevance_tags,
      });

      if (!resource) {
        return res.status(404).json({ error: "Resource not found" });
      }

      logger.info({ resourceId: numericId }, "Updated curated resource");
      res.json(resource);
    } catch (error) {
      logger.error({ err: error }, "Error updating resource");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to update resource",
      });
    }
  });

  // POST /api/admin/addie/resources/:id/refetch - Re-fetch and regenerate analysis
  apiRouter.post("/resources/:id/refetch", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid resource ID" });
      }

      // Reset status to pending so it gets picked up by the content curator
      await addieDb.resetResourceForRefetch(numericId);

      logger.info({ resourceId: numericId }, "Queued resource for refetch");
      res.json({ success: true, message: "Resource queued for refetch" });
    } catch (error) {
      logger.error({ err: error }, "Error queuing resource for refetch");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to queue resource for refetch",
      });
    }
  });

  // DELETE /api/admin/addie/resources/:id - Delete a resource
  apiRouter.delete("/resources/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid resource ID" });
      }

      const deleted = await addieDb.deleteKnowledge(numericId);

      if (!deleted) {
        return res.status(404).json({ error: "Resource not found" });
      }

      logger.info({ resourceId: numericId }, "Deleted curated resource");
      res.json({ success: true, id: numericId });
    } catch (error) {
      logger.error({ err: error }, "Error deleting resource");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to delete resource",
      });
    }
  });


  // =========================================================================
  // HOME PREVIEW API (for debugging/testing Addie Home for any user)
  // =========================================================================

  // GET /api/admin/addie/home/preview - Preview Addie Home for any user
  apiRouter.get("/home/preview", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { user_id, email, slack_user_id, format } = req.query;

      if (!user_id && !email && !slack_user_id) {
        return res.status(400).json({
          error: "One of user_id (WorkOS), email, or slack_user_id is required",
        });
      }

      // Validate input parameters
      if (slack_user_id && (typeof slack_user_id !== "string" || !/^U[A-Z0-9]+$/i.test(slack_user_id))) {
        return res.status(400).json({ error: "Invalid slack_user_id format" });
      }
      if (user_id && (typeof user_id !== "string" || user_id.length > 100)) {
        return res.status(400).json({ error: "Invalid user_id format" });
      }
      if (email && (typeof email !== "string" || !email.includes("@") || email.length > 254)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      // Dynamic import to avoid circular dependencies
      const { getWebHomeContent, renderHomeHTML, ADDIE_HOME_CSS } = await import("../addie/home/index.js");
      const { getHomeContent } = await import("../addie/home/index.js");

      let content;
      let targetUserId: string | undefined;

      if (slack_user_id) {
        // Use Slack-based home content
        content = await getHomeContent(slack_user_id as string, { forceRefresh: true });
        targetUserId = slack_user_id as string;
      } else {
        // Look up WorkOS user by ID or email
        const workos = getWorkos();

        let workosUserId: string;

        if (user_id) {
          workosUserId = user_id as string;
        } else if (email) {
          // Look up user by email
          const users = await workos.userManagement.listUsers({
            email: email as string,
          });

          if (users.data.length === 0) {
            return res.status(404).json({
              error: "User not found",
              email: email,
            });
          }

          workosUserId = users.data[0].id;
        } else {
          return res.status(400).json({ error: "Invalid request" });
        }

        targetUserId = workosUserId;
        content = await getWebHomeContent(workosUserId);
      }

      // Return based on format
      if (format === "html") {
        const html = renderHomeHTML(content);
        res.json({
          user_id: targetUserId,
          html,
          css: ADDIE_HOME_CSS,
          content, // Also include raw content for debugging
        });
      } else {
        res.json({
          user_id: targetUserId,
          content,
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Error previewing Addie Home");
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // =========================================================================
  // ROUTER TEST API (for testing router decisions without Slack)
  // =========================================================================

  /**
   * POST /api/admin/addie/test-router - Test the Haiku router with a simulated message
   *
   * This endpoint simulates a Slack channel message to test the router decision logic
   * and verify router_decision metadata is being logged correctly.
   *
   * Body: { message: string, source?: 'channel' | 'dm' | 'mention', isThread?: boolean }
   */
  apiRouter.post("/test-router", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { message, source = 'channel', isThread = false } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: "message is required" });
      }

      const threadService = getThreadService();

      // Build routing context (simulating a channel message)
      const routingCtx: RoutingContext = {
        message,
        source: source as 'channel' | 'dm' | 'mention',
        isThread,
        memberContext: null, // Anonymous test user
      };

      const router = getAddieRouter();

      // Try quick match first
      let plan = router.quickMatch(routingCtx);

      // If no quick match, use the full LLM router
      if (!plan) {
        plan = await router.route(routingCtx);
      }

      // Build router decision metadata (same structure as bolt-app.ts)
      const routerDecision = {
        action: plan.action,
        reason: plan.reason,
        decision_method: plan.decision_method,
        latency_ms: plan.latency_ms,
        tokens_input: plan.tokens_input,
        tokens_output: plan.tokens_output,
        model: plan.model,
        ...(plan.action === 'respond' ? { tool_sets: plan.tool_sets } : {}),
      };

      // Create a test thread and log the message with router decision
      const testExternalId = `test-router:${Date.now()}`;
      const thread = await threadService.getOrCreateThread({
        channel: 'slack',
        external_id: testExternalId,
        user_type: 'slack',
        user_id: 'test-user',
        context: {
          channel_id: 'test-channel',
          message_type: 'test_router_simulation',
        },
      });

      // Sanitize input
      const inputValidation = sanitizeInput(message);

      // Log the user message with router decision
      await threadService.addMessage({
        thread_id: thread.thread_id,
        role: 'user',
        content: message,
        content_sanitized: inputValidation.sanitized,
        flagged: inputValidation.flagged,
        flag_reason: inputValidation.reason || undefined,
        router_decision: routerDecision,
        message_source: 'unknown',
      });

      logger.info({
        action: plan.action,
        decision_method: plan.decision_method,
        latency_ms: plan.latency_ms
      }, "Test router: Decision logged");

      res.json({
        success: true,
        thread_id: thread.thread_id,
        router_decision: routerDecision,
        execution_plan: plan,
      });
    } catch (error) {
      logger.error({ err: error }, "Error testing router");
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // =========================================================================
  // SLACK HISTORY BACKFILL API (mounted at /api/admin/addie/backfill)
  // =========================================================================

  // POST /api/admin/addie/backfill/slack - Trigger Slack history backfill
  apiRouter.post("/backfill/slack", requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        days_back,
        max_messages_per_channel,
        channel_ids,
        include_private_channels,
        exclude_channel_names,
        include_thread_replies,
      } = req.body;

      // Validate days_back
      const daysBack = days_back ? parseInt(String(days_back), 10) : 90;
      if (isNaN(daysBack) || daysBack < 1 || daysBack > 365) {
        res.status(400).json({ error: "days_back must be between 1 and 365" });
        return;
      }

      // Validate max_messages_per_channel
      const maxMessagesPerChannel = max_messages_per_channel ? parseInt(String(max_messages_per_channel), 10) : 1000;
      if (isNaN(maxMessagesPerChannel) || maxMessagesPerChannel < 1 || maxMessagesPerChannel > 10000) {
        res.status(400).json({ error: "max_messages_per_channel must be between 1 and 10000" });
        return;
      }

      // Validate channel_ids format if provided
      if (channel_ids !== undefined) {
        if (!Array.isArray(channel_ids)) {
          res.status(400).json({ error: "channel_ids must be an array" });
          return;
        }
        for (const id of channel_ids) {
          if (typeof id !== 'string' || !/^C[A-Z0-9]+$/i.test(id)) {
            res.status(400).json({ error: `Invalid channel ID format: ${id}` });
            return;
          }
        }
      }

      // Validate exclude_channel_names if provided
      if (exclude_channel_names !== undefined) {
        if (!Array.isArray(exclude_channel_names) || !exclude_channel_names.every(n => typeof n === 'string')) {
          res.status(400).json({ error: "exclude_channel_names must be an array of strings" });
          return;
        }
      }

      logger.info({
        daysBack,
        maxMessagesPerChannel,
        channelIds: channel_ids,
        includePrivateChannels: include_private_channels,
        excludeChannelNames: exclude_channel_names,
        includeThreadReplies: include_thread_replies,
      }, "Starting Slack history backfill");

      // Run backfill (this may take a while for large workspaces)
      const result = await runSlackHistoryBackfill({
        daysBack,
        maxMessagesPerChannel,
        channelIds: channel_ids,
        includePrivateChannels: include_private_channels ?? false,
        excludeChannelNames: exclude_channel_names,
        includeThreadReplies: include_thread_replies ?? true,
      });

      logger.info({
        channelsProcessed: result.channelsProcessed,
        messagesIndexed: result.messagesIndexed,
        threadRepliesIndexed: result.threadRepliesIndexed,
      }, "Slack history backfill complete");

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      logger.error({ err: error }, "Error running Slack history backfill");
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // GET /api/admin/addie/backfill/slack/status - Get current Slack index status
  apiRouter.get("/backfill/slack/status", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get count of indexed messages
      const totalCount = await addieDb.getSlackMessageCount();

      // Get channel breakdown
      const channelResult = await query<{ slack_channel_name: string; count: string }>(
        `SELECT slack_channel_name, COUNT(*)::text as count
         FROM addie_knowledge
         WHERE source_type = 'slack' AND is_active = TRUE
         GROUP BY slack_channel_name
         ORDER BY COUNT(*) DESC`
      );

      // Get date range
      const dateResult = await query<{ oldest: string; newest: string }>(
        `SELECT
           MIN(created_at)::text as oldest,
           MAX(created_at)::text as newest
         FROM addie_knowledge
         WHERE source_type = 'slack'`
      );

      res.json({
        success: true,
        status: {
          totalMessages: totalCount,
          channels: channelResult.rows.map(r => ({
            name: r.slack_channel_name,
            count: parseInt(r.count, 10),
          })),
          oldestIndexed: dateResult.rows[0]?.oldest || null,
          newestIndexed: dateResult.rows[0]?.newest || null,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error getting Slack index status");
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // =========================================================================
  // [Insight synthesis section removed — structured insights replaced by conversation history]
  // =========================================================================



  // =========================================================================
  // ESCALATION MANAGEMENT API (mounted at /api/admin/addie/escalations)
  // =========================================================================

  // GET /api/admin/addie/escalations - List escalations with optional filters
  apiRouter.get("/escalations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status, category, limit, offset } = req.query;

      const filters = {
        status: status as EscalationStatus | undefined,
        category: category as EscalationCategory | undefined,
      };
      const parsedLimit = clampLimit(limit, 50);
      const parsedOffset = clampOffset(offset);

      const [escalations, totalCount, stats] = await Promise.all([
        listEscalations({
          ...filters,
          limit: parsedLimit,
          offset: parsedOffset,
        }),
        countEscalations(filters),
        getEscalationStats(),
      ]);

      res.json({
        escalations,
        stats,
        total: totalCount,
        limit: parsedLimit,
        offset: parsedOffset,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching escalations");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch escalations",
      });
    }
  });

  // =========================================================================
  // ESCALATION TRIAGE SUGGESTIONS API
  // Registered BEFORE /escalations/:id so literal paths like
  // /escalations/suggestions and /escalations/suggestions/run match
  // this group instead of the `:id` wildcard.
  // =========================================================================

  // GET /api/admin/addie/escalations/suggestions - List triage suggestions.
  // `pending_only` defaults to true; pass ?pending_only=false to include reviewed rows.
  apiRouter.get("/escalations/suggestions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { confidence, bucket, pending_only, limit, offset } = req.query;
      const [suggestions, stats] = await Promise.all([
        listSuggestions({
          confidence: confidence as SuggestionConfidence | undefined,
          bucket: bucket as string | undefined,
          pending_only: pending_only !== 'false',
          limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
          offset: typeof offset === 'string' ? parseInt(offset, 10) : undefined,
        }),
        getSuggestionStats(),
      ]);

      // Enrich each suggestion with the escalation snapshot so the admin UI
      // can render summary + reporter without a second fetch.
      const enriched = await Promise.all(
        suggestions.map(async (s) => ({
          ...s,
          escalation: await getEscalation(s.escalation_id),
        })),
      );

      res.json({ suggestions: enriched, stats });
    } catch (error) {
      logger.error({ err: error }, "Error listing triage suggestions");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/addie/escalations/suggestions/run - Trigger an on-demand triage run.
  apiRouter.post("/escalations/suggestions/run", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { minAgeDays, limit, staleOpsDays } = req.body ?? {};
      // Clamp caller-supplied knobs to protect the outbound probe budget.
      const clampedMinAge = typeof minAgeDays === 'number'
        ? Math.max(0, Math.min(minAgeDays, 365))
        : undefined;
      const clampedLimit = typeof limit === 'number'
        ? Math.max(1, Math.min(limit, 100))
        : undefined;
      const clampedStale = typeof staleOpsDays === 'number'
        ? Math.max(1, Math.min(staleOpsDays, 365))
        : undefined;

      const result = await runEscalationTriageJob({
        minAgeDays: clampedMinAge,
        limit: clampedLimit,
        staleOpsDays: clampedStale,
      });
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error }, "Error running on-demand triage");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/addie/escalations/suggestions/:id/accept
  // Applies the suggested status to the escalation and marks the suggestion accepted.
  apiRouter.post(
    "/escalations/suggestions/:id/accept",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const id = parseNumericId(req.params.id);
        if (!id) return res.status(400).json({ error: "Bad request", message: "Invalid ID" });

        const suggestion = await getSuggestion(id);
        if (!suggestion) return res.status(404).json({ error: "Not found" });
        if (suggestion.decision) {
          return res.status(409).json({ error: "Already reviewed", decision: suggestion.decision });
        }

        const reviewer = resolveReviewerLabel(req);

        if (suggestion.suggested_status === 'keep_open') {
          // Nothing to apply — record decision as accepted but don't mutate the escalation.
          const updated = await recordDecision(id, 'accepted', reviewer);
          return res.json({ success: true, suggestion: updated });
        }

        if (suggestion.suggested_status === 'file_as_issue') {
          const draft = suggestion.proposed_github_issue;
          if (!draft) {
            return res.status(400).json({
              error: "Bad request",
              message: "file_as_issue suggestion missing proposed_github_issue draft",
            });
          }

          // Reserve the suggestion atomically before calling GitHub, so
          // two concurrent clicks can't both file an issue. If GitHub
          // fails, release the reservation so a retry can claim it.
          const claimed = await recordDecision(id, 'accepted', reviewer, req.body?.notes);
          if (!claimed) {
            return res.status(409).json({ error: "Already reviewed" });
          }

          const filed = await fileGitHubIssue({
            title: draft.title,
            body: draft.body,
            repo: draft.repo,
            labels: draft.labels,
          });
          if (!filed) {
            await releaseDecision(id, reviewer);
            return res.status(502).json({
              error: "GitHub API",
              message: "Failed to file issue — escalation left open. Retry later.",
            });
          }

          const updatedEsc = await setEscalationGithubIssue(
            suggestion.escalation_id,
            filed.url,
            filed.number,
            filed.repo,
          );
          const notes = `Filed as ${filed.url} via triage suggestion #${id}.`;
          const resolvedEsc = await updateEscalationStatus(
            suggestion.escalation_id,
            'resolved',
            reviewer,
            notes,
          );
          return res.json({
            success: true,
            suggestion: claimed,
            escalation: resolvedEsc ?? updatedEsc,
            issue: filed,
          });
        }

        const notes = `Triage suggestion #${id}: ${suggestion.reasoning}`;
        const updatedEsc = await updateEscalationStatus(
          suggestion.escalation_id,
          suggestion.suggested_status,
          reviewer,
          notes,
        );
        if (!updatedEsc) return res.status(404).json({ error: "Escalation not found" });

        const updatedSug = await recordDecision(id, 'accepted', reviewer, req.body?.notes);
        res.json({ success: true, suggestion: updatedSug, escalation: updatedEsc });
      } catch (error) {
        logger.error({ err: error }, "Error accepting triage suggestion");
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // POST /api/admin/addie/escalations/suggestions/:id/reject
  apiRouter.post(
    "/escalations/suggestions/:id/reject",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const id = parseNumericId(req.params.id);
        if (!id) return res.status(400).json({ error: "Bad request", message: "Invalid ID" });

        const suggestion = await getSuggestion(id);
        if (!suggestion) return res.status(404).json({ error: "Not found" });
        if (suggestion.decision) {
          return res.status(409).json({ error: "Already reviewed", decision: suggestion.decision });
        }

        const reviewer = resolveReviewerLabel(req);
        const updated = await recordDecision(id, 'rejected', reviewer, req.body?.notes);
        res.json({ success: true, suggestion: updated });
      } catch (error) {
        logger.error({ err: error }, "Error rejecting triage suggestion");
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /api/admin/addie/escalations/:id - Get single escalation with thread context
  apiRouter.get("/escalations/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Bad request", message: "Invalid ID" });
      }

      const escalation = await getEscalation(id);
      if (!escalation) {
        return res.status(404).json({ error: "Not found", message: "Escalation not found" });
      }

      // If escalation has a thread, get thread context
      let threadContext = null;
      if (escalation.thread_id) {
        const threadService = getThreadService();
        const thread = await threadService.getThreadWithMessages(escalation.thread_id);
        if (thread) {
          threadContext = {
            thread_id: thread.thread_id,
            channel: thread.channel,
            created_at: thread.created_at,
            messages: thread.messages?.slice(-10), // Last 10 messages
          };
        }
      }

      res.json({
        escalation,
        thread: threadContext,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching escalation");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch escalation",
      });
    }
  });

  // PATCH /api/admin/addie/escalations/:id - Update escalation status
  apiRouter.patch("/escalations/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "Bad request", message: "Invalid ID" });
      }

      const { status, notes, notify_user, notification_message } = req.body;
      if (!status) {
        return res.status(400).json({ error: "Bad request", message: "Status is required" });
      }

      const validStatuses: EscalationStatus[] = [
        'open', 'acknowledged', 'in_progress', 'resolved', 'wont_do', 'expired'
      ];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Bad request", message: "Invalid status" });
      }

      // Get current user from session for resolved_by
      const user = (req as unknown as { user?: { email?: string } }).user;
      const resolvedBy = user?.email || 'admin';

      // Get the escalation first so we have the slack_user_id for notification
      const escalation = await getEscalation(id);
      if (!escalation) {
        return res.status(404).json({ error: "Not found", message: "Escalation not found" });
      }

      const updated = await updateEscalationStatus(id, status, resolvedBy, notes);
      if (!updated) {
        return res.status(404).json({ error: "Not found", message: "Escalation not found" });
      }

      logger.info({ escalationId: id, status, resolvedBy }, "Escalation status updated");

      // Send notification to user if requested
      let notificationSent = false;
      if (notify_user && escalation.slack_user_id) {
        const isResolved = status === 'resolved' || status === 'wont_do';
        if (isResolved) {
          const messageText = buildResolutionNotificationMessage(
            escalation,
            status as 'resolved' | 'wont_do',
            notification_message
          );

          const dmResult = await sendDirectMessage(escalation.slack_user_id, {
            text: messageText,
          });

          if (dmResult.ok) {
            notificationSent = true;
            logger.info(
              { escalationId: id, slackUserId: escalation.slack_user_id },
              "Sent escalation resolution notification to user"
            );
          } else {
            logger.warn(
              { escalationId: id, slackUserId: escalation.slack_user_id, error: dmResult.error },
              "Failed to send escalation resolution notification"
            );
          }
        }
      }

      res.json({
        success: true,
        escalation: updated,
        notification_sent: notificationSent,
      });
    } catch (error) {
      logger.error({ err: error }, "Error updating escalation");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to update escalation",
      });
    }
  });

  // =========================================================================
  // IMAGE LIBRARY API (mounted at /api/admin/addie/images)
  // =========================================================================

  // GET /api/admin/addie/images/stats - Dashboard stats
  apiRouter.get("/images/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await imageDb.getSearchStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching image stats");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/addie/images - List all images
  apiRouter.get("/images", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { category, approved, limit, offset } = req.query;
      const images = await imageDb.listImages({
        category: category as string | undefined,
        approved: approved !== undefined ? approved === "true" : undefined,
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
      });
      res.json({ images });
    } catch (error) {
      logger.error({ err: error }, "Error fetching images");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/addie/images - Create a new image
  apiRouter.post("/images", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { filename, alt_text, topics, category, characters, description, image_url, approved } = req.body;
      if (!filename || !alt_text || !image_url) {
        return res.status(400).json({ error: "filename, alt_text, and image_url are required" });
      }
      const image = await imageDb.createImage({
        filename,
        alt_text,
        topics: topics || [],
        category: category || "walkthrough",
        characters,
        description,
        image_url,
        approved,
      });
      res.status(201).json(image);
    } catch (error) {
      logger.error({ err: error }, "Error creating image");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/admin/addie/images/:id - Update an image
  apiRouter.put("/images/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid image ID" });
      }
      const image = await imageDb.updateImage(numericId, req.body);
      if (!image) {
        return res.status(404).json({ error: "Image not found" });
      }
      res.json(image);
    } catch (error) {
      logger.error({ err: error }, "Error updating image");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/admin/addie/images/:id - Delete an image
  apiRouter.delete("/images/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid image ID" });
      }
      const deleted = await imageDb.deleteImage(numericId);
      if (!deleted) {
        return res.status(404).json({ error: "Image not found" });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, "Error deleting image");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/addie/images/searches - List search events
  apiRouter.get("/images/searches", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit, offset, zero_results_only } = req.query;
      const searches = await imageDb.listSearches({
        limit: clampLimit(limit, 50),
        offset: clampOffset(offset),
        zeroResultsOnly: zero_results_only === "true",
      });
      res.json({ searches });
    } catch (error) {
      logger.error({ err: error }, "Error fetching image searches");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/addie/images/misses - Top zero-result queries
  apiRouter.get("/images/misses", requireAuth, requireAdmin, async (req, res) => {
    try {
      const misses = await imageDb.getTopMisses(clampLimit(req.query.limit, 20, 100));
      res.json({ misses });
    } catch (error) {
      logger.error({ err: error }, "Error fetching image misses");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================================
  // CONVERSATION INSIGHTS
  // =========================================================================

  // GET /api/admin/addie/conversation-insights - List past insights
  apiRouter.get("/conversation-insights", requireAuth, requireAdmin, async (req, res) => {
    try {
      const insights = await listInsights(clampLimit(req.query.limit, 12, 52));
      res.json({ insights });
    } catch (error) {
      logger.error({ err: error }, "Error fetching conversation insights");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/addie/conversation-insights/:weekStart - Get specific week
  apiRouter.get("/conversation-insights/:weekStart", requireAuth, requireAdmin, async (req, res) => {
    try {
      const weekStart = req.params.weekStart;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        return res.status(400).json({ error: "weekStart must be in YYYY-MM-DD format" });
      }
      const insight = await getInsightByWeek(weekStart);
      if (!insight) {
        return res.status(404).json({ error: "No insights found for this week" });
      }
      res.json(insight);
    } catch (error) {
      logger.error({ err: error }, "Error fetching conversation insight");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/addie/conversation-insights/run - Manually trigger
  apiRouter.post("/conversation-insights/run", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await runConversationInsightsJob({ force: true });
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, "Error running conversation insights");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return { pageRouter, apiRouter };
}
