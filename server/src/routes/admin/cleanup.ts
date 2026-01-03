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
import { mergeOrganizations, previewMerge } from "../../db/org-merge-db.js";
import { getPool } from "../../db/client.js";

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

  // GET /api/admin/cleanup/preview-merge - Preview a merge operation
  apiRouter.get(
    "/cleanup/preview-merge",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { primary, secondary } = req.query;

        if (!primary || !secondary) {
          return res.status(400).json({
            error: "Missing parameters",
            message: "Both 'primary' and 'secondary' org IDs are required",
          });
        }

        const pool = getPool();

        // Get detailed org info for both organizations
        const orgsResult = await pool.query(
          `SELECT
            o.workos_organization_id,
            o.name,
            o.email_domain,
            o.company_type,
            o.prospect_status,
            o.created_at,
            o.prospect_notes,
            o.enrichment_at,
            (SELECT COUNT(*) FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id) as member_count,
            (SELECT email FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id ORDER BY om.created_at ASC LIMIT 1) as created_by
          FROM organizations o
          WHERE o.workos_organization_id = ANY($1)`,
          [[primary, secondary]]
        );

        if (orgsResult.rows.length !== 2) {
          return res.status(404).json({
            error: "Organizations not found",
            message: "One or both organizations do not exist",
          });
        }

        const primaryOrg = orgsResult.rows.find(
          (r) => r.workos_organization_id === primary
        );
        const secondaryOrg = orgsResult.rows.find(
          (r) => r.workos_organization_id === secondary
        );

        // Get merge preview (what data would be moved)
        const preview = await previewMerge(
          primary as string,
          secondary as string
        );

        res.json({
          primary_org: {
            id: primaryOrg.workos_organization_id,
            name: primaryOrg.name,
            email_domain: primaryOrg.email_domain,
            company_type: primaryOrg.company_type,
            prospect_status: primaryOrg.prospect_status,
            member_count: parseInt(primaryOrg.member_count, 10),
            created_by: primaryOrg.created_by,
            has_enrichment: !!primaryOrg.enrichment_at,
            has_notes: !!primaryOrg.prospect_notes,
          },
          secondary_org: {
            id: secondaryOrg.workos_organization_id,
            name: secondaryOrg.name,
            email_domain: secondaryOrg.email_domain,
            company_type: secondaryOrg.company_type,
            prospect_status: secondaryOrg.prospect_status,
            member_count: parseInt(secondaryOrg.member_count, 10),
            created_by: secondaryOrg.created_by,
            has_enrichment: !!secondaryOrg.enrichment_at,
            has_notes: !!secondaryOrg.prospect_notes,
          },
          estimated_changes: preview.estimated_changes,
          warnings: preview.warnings,
        });
      } catch (error) {
        logger.error({ err: error }, "Error previewing merge");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to preview merge",
        });
      }
    }
  );

  // POST /api/admin/cleanup/merge - Execute organization merge
  apiRouter.post("/cleanup/merge", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { primary_org_id, secondary_org_id } = req.body;

      if (!primary_org_id || !secondary_org_id) {
        return res.status(400).json({
          error: "Missing parameters",
          message: "Both 'primary_org_id' and 'secondary_org_id' are required",
        });
      }

      const user = (req as any).user;
      const userId = user?.id || "unknown";

      logger.info(
        { primary_org_id, secondary_org_id, userId },
        "Executing organization merge"
      );

      const result = await mergeOrganizations(
        primary_org_id,
        secondary_org_id,
        userId
      );

      logger.info(
        {
          primary_org_id,
          secondary_org_id,
          tables_merged: result.tables_merged.length,
        },
        "Organization merge completed"
      );

      res.json(result);
    } catch (error) {
      logger.error({ err: error }, "Error executing merge");
      res.status(500).json({
        error: "Internal server error",
        message:
          error instanceof Error ? error.message : "Unable to execute merge",
      });
    }
  });
}
