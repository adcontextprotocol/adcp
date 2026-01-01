/**
 * Prospect cleanup routes
 * Handles AI-powered prospect analysis and cleanup
 */

import { Router } from "express";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import {
  getCleanupService,
  isCleanupConfigured,
} from "../../services/prospect-cleanup.js";
import { isLushaConfigured } from "../../services/lusha.js";

const logger = createLogger("admin-cleanup");

export function setupCleanupRoutes(apiRouter: Router): void {
  // GET /api/admin/cleanup/status - Check if cleanup is configured
  apiRouter.get("/cleanup/status", requireAuth, requireAdmin, async (_req, res) => {
    res.json({
      configured: isCleanupConfigured(),
      enrichment_configured: isLushaConfigured(),
    });
  });

  // POST /api/admin/cleanup/analyze - Analyze prospects for issues
  apiRouter.post(
    "/cleanup/analyze",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const cleanupService = getCleanupService();
        if (!cleanupService) {
          return res.status(503).json({
            error: "Cleanup not configured",
            message: "ANTHROPIC_API_KEY is required for intelligent cleanup",
          });
        }

        const { limit, onlyProblematic, orgIds } = req.body;

        const report = await cleanupService.analyzeProspects({
          limit: limit || 50,
          onlyProblematic: onlyProblematic !== false, // Default true
          orgIds,
        });

        res.json(report);
      } catch (error) {
        logger.error({ err: error }, "Error analyzing prospects");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to analyze prospects",
        });
      }
    }
  );

  // POST /api/admin/cleanup/auto-fix - Auto-fix issues that can be resolved automatically
  apiRouter.post(
    "/cleanup/auto-fix",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const cleanupService = getCleanupService();
        if (!cleanupService) {
          return res.status(503).json({
            error: "Cleanup not configured",
            message: "ANTHROPIC_API_KEY is required for intelligent cleanup",
          });
        }

        const { analyses } = req.body;

        if (!Array.isArray(analyses) || analyses.length === 0) {
          return res.status(400).json({
            error: "Invalid request",
            message: "analyses array is required",
          });
        }

        const results = await cleanupService.autoFixIssues(analyses);

        res.json({
          total: results.length,
          successful: results.filter((r) => r.success).length,
          results,
        });
      } catch (error) {
        logger.error({ err: error }, "Error auto-fixing prospects");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to auto-fix prospects",
        });
      }
    }
  );

  // POST /api/admin/cleanup/analyze-with-ai/:orgId - Use Claude to analyze a specific prospect
  apiRouter.post(
    "/cleanup/analyze-with-ai/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const cleanupService = getCleanupService();
        if (!cleanupService) {
          return res.status(503).json({
            error: "Cleanup not configured",
            message: "ANTHROPIC_API_KEY is required for intelligent cleanup",
          });
        }

        const { orgId } = req.params;

        logger.info({ orgId }, "Starting AI analysis for prospect");

        const result = await cleanupService.analyzeWithClaude(orgId);

        res.json(result);
      } catch (error) {
        logger.error({ err: error }, "Error in AI analysis");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to analyze prospect with AI",
        });
      }
    }
  );

  // POST /api/admin/cleanup/batch-analyze-ai - Use Claude to analyze multiple prospects
  apiRouter.post(
    "/cleanup/batch-analyze-ai",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const cleanupService = getCleanupService();
        if (!cleanupService) {
          return res.status(503).json({
            error: "Cleanup not configured",
            message: "ANTHROPIC_API_KEY is required for intelligent cleanup",
          });
        }

        const { orgIds } = req.body;

        if (!Array.isArray(orgIds) || orgIds.length === 0) {
          return res.status(400).json({
            error: "Invalid request",
            message: "orgIds array is required",
          });
        }

        // Limit batch size
        const limitedOrgIds = orgIds.slice(0, 10);

        logger.info(
          { count: limitedOrgIds.length },
          "Starting batch AI analysis"
        );

        const result = await cleanupService.batchAnalyzeWithClaude(limitedOrgIds);

        res.json(result);
      } catch (error) {
        logger.error({ err: error }, "Error in batch AI analysis");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to batch analyze prospects with AI",
        });
      }
    }
  );
}
