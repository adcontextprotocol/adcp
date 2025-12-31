/**
 * Addie Admin routes module
 *
 * Admin routes for managing Addie's knowledge base, viewing interactions,
 * and managing the approval queue.
 */

import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { AddieDatabase, type RuleType } from "../db/addie-db.js";
import { analyzeInteractions, previewRuleChange } from "../addie/jobs/rule-analyzer.js";
import { invalidateAddieRulesCache } from "../addie/handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("addie-admin-routes");
const addieDb = new AddieDatabase();

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
    const dashboardPath =
      process.env.NODE_ENV === "production"
        ? path.join(__dirname, "../../server/public/admin-addie.html")
        : path.join(__dirname, "../../public/admin-addie.html");
    res.sendFile(dashboardPath);
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
  // WEB CONVERSATIONS API (mounted at /api/admin/addie/conversations)
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

  return { pageRouter, apiRouter };
}
