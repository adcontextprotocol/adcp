/**
 * Addie Admin routes module
 *
 * Admin routes for managing Addie's knowledge base, viewing interactions,
 * and managing the approval queue.
 */

import { Router } from "express";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { serveHtmlWithConfig } from "../utils/html-config.js";
import { AddieDatabase, type RuleType } from "../db/addie-db.js";
import { query } from "../db/client.js";
import { analyzeInteractions, previewRuleChange } from "../addie/jobs/rule-analyzer.js";
import { invalidateAddieRulesCache } from "../addie/handler.js";
import {
  getThreadService,
  type ThreadChannel,
} from "../addie/thread-service.js";
import Anthropic from "@anthropic-ai/sdk";
import { getAddieBoltApp } from "../addie/bolt-app.js";
import { AddieRouter, type RoutingContext } from "../addie/router.js";
import { sanitizeInput } from "../addie/security.js";
import { runSlackHistoryBackfill } from "../addie/jobs/slack-history-backfill.js";
import {
  resolveSlackUserDisplayName,
  resolveSlackUserDisplayNames,
} from "../slack/client.js";

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

      const documents = await addieDb.listKnowledge({
        category: category as string | undefined,
        sourceType: source_type as string | undefined,
        fetchStatus: status as string | undefined,
        activeOnly: active_only !== "false",
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({
        documents,
        total: documents.length,
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
        limit: limit ? parseInt(limit as string, 10) : 10,
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
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : undefined,
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
      const { channel, flagged_only, unreviewed_only, has_user_feedback, user_id, since, limit, offset } = req.query;

      const threads = await threadService.listThreads({
        channel: channel as ThreadChannel | undefined,
        flagged_only: flagged_only === "true",
        unreviewed_only: unreviewed_only === "true",
        has_user_feedback: has_user_feedback === "true",
        user_id: user_id as string | undefined,
        since: since ? new Date(since as string) : undefined,
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : undefined,
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
  apiRouter.get("/threads/performance", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { days } = req.query;
      const daysNum = days ? parseInt(days as string, 10) : 7;

      const performance = await threadService.getPerformanceMetrics(daysNum);
      res.json(performance);
    } catch (error) {
      logger.error({ err: error }, "Error fetching performance metrics");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch performance metrics",
      });
    }
  });

  // GET /api/admin/addie/threads/:id - Get a single thread with messages
  apiRouter.get("/threads/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const threadService = getThreadService();
      const { id } = req.params;

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
        model: 'claude-sonnet-4-20250514',
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
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : undefined,
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
  // APPROVAL QUEUE API (mounted at /api/admin/addie/queue)
  // =========================================================================

  // GET /api/admin/addie/queue - Get pending approval items
  apiRouter.get("/queue", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit } = req.query;

      const items = await addieDb.getPendingApprovals({
        limit: limit ? parseInt(limit as string, 10) : 50,
      });

      res.json({
        items,
        total: items.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching approval queue");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch approval queue",
      });
    }
  });

  // GET /api/admin/addie/queue/stats - Get approval queue statistics
  apiRouter.get("/queue/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await addieDb.getApprovalStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching approval queue stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch approval queue statistics",
      });
    }
  });

  // PUT /api/admin/addie/queue/:id/approve - Approve a queued item
  apiRouter.put("/queue/:id/approve", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid queue item ID" });
      }
      const { edit_notes, final_content } = req.body;

      const item = await addieDb.approveItem(numericId, req.user?.id || "admin", {
        editNotes: edit_notes,
        finalContent: final_content,
      });

      if (!item) {
        return res.status(404).json({ error: "Approval item not found or already processed" });
      }

      // Execute the approved action (send the message to Slack)
      const boltApp = getAddieBoltApp();
      if (boltApp && item.target_channel_id) {
        try {
          const contentToSend = final_content || item.proposed_content;
          const result = await boltApp.client.chat.postMessage({
            channel: item.target_channel_id,
            text: contentToSend,
            thread_ts: item.target_thread_ts || undefined,
          });

          // Update the item with execution result
          await addieDb.markExecuted(numericId, {
            success: true,
            message_ts: result.ts,
            channel: result.channel,
          });

          logger.info({ queueId: numericId, messageTs: result.ts }, "Approved and sent queue item");
        } catch (sendError) {
          logger.error({ err: sendError, queueId: numericId }, "Failed to send approved message");
          // Still return success for approval, but note the send failure
          await addieDb.markExecuted(numericId, {
            success: false,
            error: sendError instanceof Error ? sendError.message : "Unknown error",
          });
        }
      }

      logger.info({ queueId: numericId }, "Approved queue item");
      res.json(item);
    } catch (error) {
      logger.error({ err: error }, "Error approving queue item");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to approve queue item",
      });
    }
  });

  // PUT /api/admin/addie/queue/:id/reject - Reject a queued item
  apiRouter.put("/queue/:id/reject", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid queue item ID" });
      }
      const { reason } = req.body;

      const item = await addieDb.rejectItem(numericId, req.user?.id || "admin", reason);

      if (!item) {
        return res.status(404).json({ error: "Approval item not found or already processed" });
      }

      logger.info({ queueId: numericId, reason }, "Rejected queue item");
      res.json(item);
    } catch (error) {
      logger.error({ err: error }, "Error rejecting queue item");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to reject queue item",
      });
    }
  });

  // =========================================================================
  // RULES MANAGEMENT API (mounted at /api/admin/addie/rules)
  // =========================================================================

  // GET /api/admin/addie/rules - List all rules
  apiRouter.get("/rules", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { active_only } = req.query;
      const rules = active_only === "true"
        ? await addieDb.getActiveRules()
        : await addieDb.getAllRules();

      res.json({
        rules,
        total: rules.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching rules");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch rules",
      });
    }
  });

  // GET /api/admin/addie/rules/system-prompt - Get the built system prompt
  apiRouter.get("/rules/system-prompt", requireAuth, requireAdmin, async (req, res) => {
    try {
      const systemPrompt = await addieDb.buildSystemPrompt();
      res.json({ system_prompt: systemPrompt });
    } catch (error) {
      logger.error({ err: error }, "Error building system prompt");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to build system prompt",
      });
    }
  });

  // GET /api/admin/addie/rules/:id - Get a specific rule
  apiRouter.get("/rules/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid rule ID" });
      }
      const rule = await addieDb.getRuleById(numericId);

      if (!rule) {
        return res.status(404).json({ error: "Rule not found" });
      }

      res.json(rule);
    } catch (error) {
      logger.error({ err: error }, "Error fetching rule");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch rule",
      });
    }
  });

  // POST /api/admin/addie/rules - Create a new rule
  apiRouter.post("/rules", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rule_type, name, description, content, priority } = req.body;

      if (!rule_type || !["system_prompt", "behavior", "knowledge", "constraint", "response_style"].includes(rule_type)) {
        return res.status(400).json({ error: "Valid rule_type is required" });
      }
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "Name is required" });
      }
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Content is required" });
      }

      const rule = await addieDb.createRule({
        rule_type: rule_type as RuleType,
        name,
        description,
        content,
        priority,
        created_by: req.user?.id || "admin",
      });

      invalidateAddieRulesCache();
      logger.info({ ruleId: rule.id, name }, "Created rule");
      res.status(201).json(rule);
    } catch (error) {
      logger.error({ err: error }, "Error creating rule");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create rule",
      });
    }
  });

  // PUT /api/admin/addie/rules/:id - Update a rule (creates new version)
  apiRouter.put("/rules/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid rule ID" });
      }
      const { rule_type, name, description, content, priority } = req.body;

      const rule = await addieDb.updateRule(
        numericId,
        { rule_type, name, description, content, priority },
        req.user?.id || "admin"
      );

      if (!rule) {
        return res.status(404).json({ error: "Rule not found" });
      }

      invalidateAddieRulesCache();
      logger.info({ ruleId: rule.id, oldRuleId: numericId }, "Updated rule (new version)");
      res.json(rule);
    } catch (error) {
      logger.error({ err: error }, "Error updating rule");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to update rule",
      });
    }
  });

  // PUT /api/admin/addie/rules/:id/active - Toggle rule active status
  apiRouter.put("/rules/:id/active", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid rule ID" });
      }
      const { is_active } = req.body;

      if (typeof is_active !== "boolean") {
        return res.status(400).json({ error: "is_active (boolean) is required" });
      }

      const rule = await addieDb.setRuleActive(numericId, is_active);

      if (!rule) {
        return res.status(404).json({ error: "Rule not found" });
      }

      invalidateAddieRulesCache();
      logger.info({ ruleId: rule.id, isActive: is_active }, "Toggled rule active status");
      res.json(rule);
    } catch (error) {
      logger.error({ err: error }, "Error toggling rule active status");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to toggle rule active status",
      });
    }
  });

  // DELETE /api/admin/addie/rules/:id - Delete a rule (soft delete)
  apiRouter.delete("/rules/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid rule ID" });
      }
      const deleted = await addieDb.deleteRule(numericId);

      if (!deleted) {
        return res.status(404).json({ error: "Rule not found" });
      }

      invalidateAddieRulesCache();
      logger.info({ ruleId: numericId }, "Deleted rule");
      res.json({ success: true, id: numericId });
    } catch (error) {
      logger.error({ err: error }, "Error deleting rule");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to delete rule",
      });
    }
  });

  // =========================================================================
  // SUGGESTIONS API (mounted at /api/admin/addie/suggestions)
  // =========================================================================

  // GET /api/admin/addie/suggestions - List pending suggestions
  apiRouter.get("/suggestions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit } = req.query;
      const suggestions = await addieDb.getPendingSuggestions(
        limit ? parseInt(limit as string, 10) : 50
      );

      res.json({
        suggestions,
        total: suggestions.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching suggestions");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch suggestions",
      });
    }
  });

  // GET /api/admin/addie/suggestions/stats - Get suggestion statistics
  apiRouter.get("/suggestions/stats", requireAuth, requireAdmin, async (req, res) => {
    try {
      const stats = await addieDb.getSuggestionStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error }, "Error fetching suggestion stats");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch suggestion statistics",
      });
    }
  });

  // GET /api/admin/addie/suggestions/:id - Get a specific suggestion
  apiRouter.get("/suggestions/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid suggestion ID" });
      }
      const suggestion = await addieDb.getSuggestionById(numericId);

      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      res.json(suggestion);
    } catch (error) {
      logger.error({ err: error }, "Error fetching suggestion");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch suggestion",
      });
    }
  });

  // PUT /api/admin/addie/suggestions/:id/approve - Approve a suggestion
  apiRouter.put("/suggestions/:id/approve", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid suggestion ID" });
      }
      const { notes } = req.body;

      const suggestion = await addieDb.approveSuggestion(
        numericId,
        req.user?.id || "admin",
        notes
      );

      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found or already processed" });
      }

      logger.info({ suggestionId: numericId }, "Approved suggestion");
      res.json(suggestion);
    } catch (error) {
      logger.error({ err: error }, "Error approving suggestion");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to approve suggestion",
      });
    }
  });

  // PUT /api/admin/addie/suggestions/:id/reject - Reject a suggestion
  apiRouter.put("/suggestions/:id/reject", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid suggestion ID" });
      }
      const { notes } = req.body;

      const suggestion = await addieDb.rejectSuggestion(
        numericId,
        req.user?.id || "admin",
        notes
      );

      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found or already processed" });
      }

      logger.info({ suggestionId: numericId }, "Rejected suggestion");
      res.json(suggestion);
    } catch (error) {
      logger.error({ err: error }, "Error rejecting suggestion");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to reject suggestion",
      });
    }
  });

  // PUT /api/admin/addie/suggestions/:id/apply - Apply an approved suggestion
  apiRouter.put("/suggestions/:id/apply", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const suggestionId = parseInt(id, 10);

      if (isNaN(suggestionId)) {
        return res.status(400).json({ error: "Invalid suggestion ID" });
      }

      // First check if the suggestion exists and its status
      const suggestion = await addieDb.getSuggestionById(suggestionId);

      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      if (suggestion.status !== "approved") {
        return res.status(400).json({
          error: "Suggestion must be approved before applying",
          current_status: suggestion.status,
        });
      }

      // Check for unsupported suggestion types
      const supportedTypes = ["new_rule", "modify_rule", "disable_rule"];
      if (!supportedTypes.includes(suggestion.suggestion_type)) {
        return res.status(400).json({
          error: `Suggestion type '${suggestion.suggestion_type}' is not yet supported`,
          suggestion_type: suggestion.suggestion_type,
          supported_types: supportedTypes,
        });
      }

      const result = await addieDb.applySuggestion(
        suggestionId,
        req.user?.id || "admin"
      );

      if (!result) {
        // This shouldn't happen if the above checks pass, but handle it anyway
        return res.status(500).json({ error: "Failed to apply suggestion" });
      }

      invalidateAddieRulesCache();
      logger.info({ suggestionId: id, newRuleId: result.rule.id }, "Applied suggestion");
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, "Error applying suggestion");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to apply suggestion",
      });
    }
  });

  // POST /api/admin/addie/suggestions - Create a manual suggestion
  apiRouter.post("/suggestions", requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        suggestion_type,
        target_rule_id,
        suggested_name,
        suggested_content,
        suggested_rule_type,
        reasoning,
        confidence,
        expected_impact,
        supporting_interactions,
        content_type,
        suggested_topic,
        external_sources,
      } = req.body;

      // Validate required fields
      if (!suggestion_type || !suggested_content || !reasoning) {
        return res.status(400).json({
          error: "Missing required fields",
          required: ["suggestion_type", "suggested_content", "reasoning"],
        });
      }

      // Validate suggestion_type
      const validTypes = ["new_rule", "modify_rule", "disable_rule", "merge_rules", "experiment", "publish_content"];
      if (!validTypes.includes(suggestion_type)) {
        return res.status(400).json({
          error: "Invalid suggestion_type",
          valid_types: validTypes,
        });
      }

      // If publish_content, require content_type
      if (suggestion_type === "publish_content" && !content_type) {
        return res.status(400).json({
          error: "content_type is required for publish_content suggestions",
          valid_content_types: ["docs", "perspectives", "external_link"],
        });
      }

      const suggestion = await addieDb.createSuggestion({
        suggestion_type,
        target_rule_id,
        suggested_name,
        suggested_content,
        suggested_rule_type,
        reasoning,
        confidence: confidence ?? 0.5,
        expected_impact,
        supporting_interactions,
        content_type,
        suggested_topic,
        external_sources,
        analysis_batch_id: `manual-${Date.now()}`,
      });

      logger.info({
        suggestionId: suggestion.id,
        type: suggestion_type,
        content_type,
      }, "Created manual suggestion");

      res.status(201).json(suggestion);
    } catch (error) {
      logger.error({ err: error }, "Error creating suggestion");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create suggestion",
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
        limit: limit ? parseInt(limit as string, 10) : 50,
        offset: offset ? parseInt(offset as string, 10) : undefined,
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
  // ANALYSIS API (mounted at /api/admin/addie/analysis)
  // =========================================================================

  // POST /api/admin/addie/analysis/run - Trigger an analysis run
  apiRouter.post("/analysis/run", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { days, focus_on_negative, max_interactions } = req.body;

      const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicApiKey) {
        return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
      }

      // Run analysis (this may take a while)
      const result = await analyzeInteractions({
        db: addieDb,
        anthropicApiKey,
        analysisType: "manual",
        days: days || 7,
        focusOnNegative: focus_on_negative || false,
        maxInteractions: max_interactions || 100,
      });

      logger.info({
        suggestionsGenerated: result.suggestions.length,
        tokensUsed: result.tokensUsed,
      }, "Analysis run completed");

      res.json({
        success: true,
        suggestions_generated: result.suggestions.length,
        patterns_found: Object.keys(result.patterns).length,
        summary: result.summary,
        tokens_used: result.tokensUsed,
      });
    } catch (error) {
      logger.error({ err: error }, "Error running analysis");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unable to run analysis",
      });
    }
  });

  // GET /api/admin/addie/analysis/runs - Get recent analysis runs
  apiRouter.get("/analysis/runs", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit } = req.query;
      const runs = await addieDb.getRecentAnalysisRuns(
        limit ? parseInt(limit as string, 10) : 10
      );

      res.json({
        runs,
        total: runs.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching analysis runs");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch analysis runs",
      });
    }
  });

  // POST /api/admin/addie/analysis/preview - Preview how rule changes would affect interactions
  apiRouter.post("/analysis/preview", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { rule_ids, sample_size } = req.body;

      if (!rule_ids || !Array.isArray(rule_ids)) {
        return res.status(400).json({ error: "rule_ids array is required" });
      }

      const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicApiKey) {
        return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
      }

      // Get the proposed rules
      const proposedRules = await Promise.all(
        rule_ids.map((id: number) => addieDb.getRuleById(id))
      );

      const validRules = proposedRules.filter((r): r is NonNullable<typeof r> => r !== null);

      if (validRules.length === 0) {
        return res.status(400).json({ error: "No valid rules found for the provided IDs" });
      }

      const result = await previewRuleChange({
        db: addieDb,
        anthropicApiKey,
        proposedRules: validRules,
        sampleSize: sample_size || 5,
      });

      res.json(result);
    } catch (error) {
      logger.error({ err: error }, "Error previewing rule changes");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unable to preview rule changes",
      });
    }
  });

  // =========================================================================
  // EVAL FRAMEWORK API (mounted at /api/admin/addie/eval)
  // Test rule changes against historical interactions
  // =========================================================================

  // Lazy-load eval service to avoid circular dependencies
  const getEvalServiceLazy = async () => {
    const { getEvalService } = await import("../addie/eval-service.js");
    return getEvalService();
  };

  // POST /api/admin/addie/eval/runs - Create and start an eval run
  apiRouter.post("/eval/runs", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { proposed_rule_ids, criteria } = req.body;

      if (!proposed_rule_ids || !Array.isArray(proposed_rule_ids) || proposed_rule_ids.length === 0) {
        return res.status(400).json({ error: "proposed_rule_ids array is required" });
      }

      // Validate rule IDs are numbers
      if (!proposed_rule_ids.every((id: unknown) => typeof id === "number")) {
        return res.status(400).json({ error: "proposed_rule_ids must be an array of numbers" });
      }

      // Validate criteria if provided
      const validatedCriteria: {
        minRating?: number;
        maxRating?: number;
        startDate?: Date;
        endDate?: Date;
        channel?: 'slack' | 'web' | 'a2a' | 'email';
        toolsUsed?: string[];
        flaggedOnly?: boolean;
        sampleSize?: number;
        randomSeed?: number;
      } = { sampleSize: 10 };

      if (criteria && typeof criteria === "object") {
        if (criteria.minRating !== undefined) {
          if (typeof criteria.minRating !== "number" || criteria.minRating < 1 || criteria.minRating > 5) {
            return res.status(400).json({ error: "minRating must be a number between 1 and 5" });
          }
          validatedCriteria.minRating = criteria.minRating;
        }
        if (criteria.maxRating !== undefined) {
          if (typeof criteria.maxRating !== "number" || criteria.maxRating < 1 || criteria.maxRating > 5) {
            return res.status(400).json({ error: "maxRating must be a number between 1 and 5" });
          }
          validatedCriteria.maxRating = criteria.maxRating;
        }
        if (criteria.sampleSize !== undefined) {
          if (typeof criteria.sampleSize !== "number" || criteria.sampleSize < 1 || criteria.sampleSize > 100) {
            return res.status(400).json({ error: "sampleSize must be a number between 1 and 100" });
          }
          validatedCriteria.sampleSize = criteria.sampleSize;
        }
        if (criteria.randomSeed !== undefined) {
          if (typeof criteria.randomSeed !== "number") {
            return res.status(400).json({ error: "randomSeed must be a number" });
          }
          validatedCriteria.randomSeed = criteria.randomSeed;
        }
        if (criteria.channel !== undefined) {
          const validChannels = ["slack", "web", "a2a", "email"] as const;
          if (typeof criteria.channel !== "string" || !validChannels.includes(criteria.channel as typeof validChannels[number])) {
            return res.status(400).json({ error: `channel must be one of: ${validChannels.join(", ")}` });
          }
          validatedCriteria.channel = criteria.channel as typeof validChannels[number];
        }
        if (criteria.flaggedOnly !== undefined) {
          validatedCriteria.flaggedOnly = Boolean(criteria.flaggedOnly);
        }
        if (criteria.toolsUsed !== undefined) {
          if (!Array.isArray(criteria.toolsUsed) || !criteria.toolsUsed.every((t: unknown) => typeof t === "string")) {
            return res.status(400).json({ error: "toolsUsed must be an array of strings" });
          }
          validatedCriteria.toolsUsed = criteria.toolsUsed;
        }
        if (criteria.startDate !== undefined) {
          const parsed = new Date(criteria.startDate);
          if (isNaN(parsed.getTime())) {
            return res.status(400).json({ error: "startDate must be a valid date" });
          }
          validatedCriteria.startDate = parsed;
        }
        if (criteria.endDate !== undefined) {
          const parsed = new Date(criteria.endDate);
          if (isNaN(parsed.getTime())) {
            return res.status(400).json({ error: "endDate must be a valid date" });
          }
          validatedCriteria.endDate = parsed;
        }
      }

      const evalService = await getEvalServiceLazy();

      const run = await evalService.createAndStartRun({
        proposedRuleIds: proposed_rule_ids,
        criteria: validatedCriteria,
        createdBy: req.user?.id || "admin",
      });

      logger.info({ runId: run.id, proposedRuleIds: proposed_rule_ids }, "Created eval run");
      res.status(201).json(run);
    } catch (error) {
      logger.error({ err: error }, "Error creating eval run");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unable to create eval run",
      });
    }
  });

  // GET /api/admin/addie/eval/runs - List eval runs
  apiRouter.get("/eval/runs", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { limit, offset } = req.query;

      const evalService = await getEvalServiceLazy();

      const runs = await evalService.listRuns(
        limit ? parseInt(limit as string, 10) : 20,
        offset ? parseInt(offset as string, 10) : 0
      );

      res.json({
        runs,
        total: runs.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching eval runs");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch eval runs",
      });
    }
  });

  // GET /api/admin/addie/eval/runs/:id - Get a specific eval run
  apiRouter.get("/eval/runs/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid run ID" });
      }

      const evalService = await getEvalServiceLazy();

      const run = await evalService.getRun(numericId);

      if (!run) {
        return res.status(404).json({ error: "Eval run not found" });
      }

      res.json(run);
    } catch (error) {
      logger.error({ err: error }, "Error fetching eval run");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch eval run",
      });
    }
  });

  // GET /api/admin/addie/eval/runs/:id/results - Get results for an eval run
  apiRouter.get("/eval/runs/:id/results", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid run ID" });
      }

      const { limit, offset } = req.query;

      const evalService = await getEvalServiceLazy();

      const results = await evalService.getResults(
        numericId,
        limit ? parseInt(limit as string, 10) : 100,
        offset ? parseInt(offset as string, 10) : 0
      );

      res.json({
        results,
        total: results.length,
      });
    } catch (error) {
      logger.error({ err: error }, "Error fetching eval results");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch eval results",
      });
    }
  });

  // PUT /api/admin/addie/eval/results/:id/review - Submit a review verdict for an eval result
  apiRouter.put("/eval/results/:id/review", requireAuth, requireAdmin, async (req, res) => {
    try {
      const numericId = parseNumericId(req.params.id);
      if (!numericId) {
        return res.status(400).json({ error: "Invalid result ID" });
      }

      const { verdict, notes } = req.body;

      const validVerdicts = ["improved", "same", "worse", "uncertain"];
      if (!verdict || !validVerdicts.includes(verdict)) {
        return res.status(400).json({
          error: `verdict must be one of: ${validVerdicts.join(", ")}`,
        });
      }

      const evalService = await getEvalServiceLazy();

      await evalService.submitReview(numericId, verdict, req.user?.id || "admin", notes);

      logger.info({ resultId: numericId, verdict }, "Submitted eval result review");
      res.json({ success: true, result_id: numericId, verdict });
    } catch (error) {
      logger.error({ err: error }, "Error submitting eval result review");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to submit eval result review",
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
        const { workos } = await import("../auth/workos-client.js");

        let workosUserId: string;

        if (user_id) {
          workosUserId = user_id as string;
        } else if (email) {
          // Look up user by email
          const users = await workos!.userManagement.listUsers({
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
        message: error instanceof Error ? error.message : "Unable to preview Addie Home",
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
        ...(plan.action === 'respond' ? { tools: plan.tools } : {}),
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
        message: error instanceof Error ? error.message : "Unable to test router",
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
        message: error instanceof Error ? error.message : "Unable to run backfill",
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
        message: error instanceof Error ? error.message : "Unable to get status",
      });
    }
  });

  return { pageRouter, apiRouter };
}
