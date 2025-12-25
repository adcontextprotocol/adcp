/**
 * Admin routes module
 *
 * This module contains admin-only routes extracted from http.ts.
 * New admin routes should be added here to keep http.ts from growing.
 *
 * Existing admin routes in http.ts will be migrated here incrementally.
 */

import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { WorkOS, DomainDataState } from "@workos-inc/node";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger("admin-routes");

// Initialize WorkOS client only if authentication is enabled
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

const workos = AUTH_ENABLED
  ? new WorkOS(process.env.WORKOS_API_KEY!, {
      clientId: process.env.WORKOS_CLIENT_ID!,
    })
  : null;

/**
 * Create admin routes
 */
export function createAdminRouter(): Router {
  const router = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES
  // =========================================================================

  router.get("/prospects", requireAuth, requireAdmin, (req, res) => {
    const prospectsPath =
      process.env.NODE_ENV === "production"
        ? path.join(__dirname, "../../server/public/admin-prospects.html")
        : path.join(__dirname, "../../public/admin-prospects.html");
    res.sendFile(prospectsPath);
  });

  // =========================================================================
  // PROSPECT MANAGEMENT API (AAO Outreach Tracking)
  // =========================================================================

  // GET /api/admin/prospects - List all prospects
  router.get("/prospects", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const { status, source } = req.query;

      let query = `
        SELECT
          o.workos_organization_id,
          o.name,
          o.company_type,
          o.revenue_tier,
          o.prospect_status,
          o.prospect_source,
          o.prospect_owner,
          o.prospect_notes,
          o.prospect_contact_name,
          o.prospect_contact_email,
          o.prospect_contact_title,
          o.prospect_next_action,
          o.prospect_next_action_date,
          o.parent_organization_id,
          o.created_at,
          o.updated_at,
          p.name as parent_name,
          (SELECT COUNT(*) FROM organizations WHERE parent_organization_id = o.workos_organization_id) as subsidiary_count
        FROM organizations o
        LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
        WHERE o.prospect_status IS NOT NULL
      `;
      const params: (string | null)[] = [];

      if (status && typeof status === "string") {
        params.push(status);
        query += ` AND o.prospect_status = $${params.length}`;
      }

      if (source && typeof source === "string") {
        params.push(source);
        query += ` AND o.prospect_source = $${params.length}`;
      }

      const { owner } = req.query;
      if (owner && typeof owner === "string") {
        params.push(owner);
        query += ` AND o.prospect_owner = $${params.length}`;
      }

      query += ` ORDER BY o.prospect_next_action_date ASC NULLS LAST, o.created_at DESC`;

      const result = await pool.query(query, params);

      // Enrich with WorkOS membership count
      const prospects = await Promise.all(
        result.rows.map(async (row) => {
          let memberCount = 0;
          try {
            if (workos) {
              const memberships =
                await workos.userManagement.listOrganizationMemberships({
                  organizationId: row.workos_organization_id,
                });
              memberCount = memberships.data?.length || 0;
            }
          } catch {
            // Org might not exist in WorkOS yet or other error
          }

          return {
            ...row,
            member_count: memberCount,
            has_members: memberCount > 0,
          };
        })
      );

      res.json(prospects);
    } catch (error) {
      logger.error({ err: error }, "Error fetching prospects");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch prospects",
      });
    }
  });

  // POST /api/admin/prospects - Create a new prospect
  router.post("/prospects", requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        name,
        domain,
        prospect_source,
        prospect_notes,
        prospect_contact_name,
        prospect_contact_email,
        prospect_contact_title,
        prospect_next_action,
        prospect_next_action_date,
        parent_organization_id,
      } = req.body;

      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "Company name is required" });
      }

      if (!workos) {
        return res.status(500).json({ error: "WorkOS not configured" });
      }

      // Create organization in WorkOS with domain (if provided)
      const workosOrg = await workos.organizations.createOrganization({
        name: name.trim(),
        domainData: domain
          ? [{ domain: domain.trim(), state: DomainDataState.Verified }]
          : undefined,
      });

      logger.info(
        { orgId: workosOrg.id, name, domain },
        "Created WorkOS organization for prospect"
      );

      // Create local record with prospect tracking fields
      const pool = getPool();
      const result = await pool.query(
        `INSERT INTO organizations (
          workos_organization_id,
          name,
          prospect_status,
          prospect_source,
          prospect_notes,
          prospect_contact_name,
          prospect_contact_email,
          prospect_contact_title,
          prospect_next_action,
          prospect_next_action_date,
          parent_organization_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          workosOrg.id,
          name.trim(),
          "prospect", // Initial status
          prospect_source || "aao_launch_list",
          prospect_notes || null,
          prospect_contact_name || null,
          prospect_contact_email || null,
          prospect_contact_title || null,
          prospect_next_action || null,
          prospect_next_action_date || null,
          parent_organization_id || null,
        ]
      );

      res.status(201).json({
        ...result.rows[0],
        domain: domain || null,
        workos_org: {
          id: workosOrg.id,
          domains: workosOrg.domains,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Error creating prospect");

      // Handle WorkOS-specific errors
      if (error instanceof Error && error.message.includes("domain")) {
        return res.status(400).json({
          error: "Domain error",
          message: error.message,
        });
      }

      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create prospect",
      });
    }
  });

  // POST /api/admin/prospects/bulk - Bulk import prospects
  router.post(
    "/prospects/bulk",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { prospects } = req.body;

        if (!Array.isArray(prospects) || prospects.length === 0) {
          return res
            .status(400)
            .json({ error: "prospects array is required and cannot be empty" });
        }

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        const results: {
          success: any[];
          errors: { name: string; error: string }[];
        } = {
          success: [],
          errors: [],
        };

        const pool = getPool();

        for (const prospect of prospects) {
          try {
            const {
              name,
              domain,
              prospect_source,
              prospect_notes,
              prospect_contact_name,
              prospect_contact_email,
              prospect_contact_title,
              prospect_next_action,
              prospect_next_action_date,
              parent_organization_id,
            } = prospect;

            if (!name || typeof name !== "string") {
              results.errors.push({
                name: name || "unknown",
                error: "Company name is required",
              });
              continue;
            }

            // Create organization in WorkOS
            const workosOrg = await workos.organizations.createOrganization({
              name: name.trim(),
              domainData: domain
                ? [{ domain: domain.trim(), state: DomainDataState.Verified }]
                : undefined,
            });

            // Create local record
            const result = await pool.query(
              `INSERT INTO organizations (
              workos_organization_id,
              name,
              prospect_status,
              prospect_source,
              prospect_notes,
              prospect_contact_name,
              prospect_contact_email,
              prospect_contact_title,
              prospect_next_action,
              prospect_next_action_date,
              parent_organization_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *`,
              [
                workosOrg.id,
                name.trim(),
                "prospect",
                prospect_source || "aao_launch_list",
                prospect_notes || null,
                prospect_contact_name || null,
                prospect_contact_email || null,
                prospect_contact_title || null,
                prospect_next_action || null,
                prospect_next_action_date || null,
                parent_organization_id || null,
              ]
            );

            results.success.push({
              ...result.rows[0],
              domain: domain || null,
            });
          } catch (error) {
            results.errors.push({
              name: prospect.name || "unknown",
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        res.status(201).json({
          created: results.success.length,
          failed: results.errors.length,
          results,
        });
      } catch (error) {
        logger.error({ err: error }, "Error bulk creating prospects");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to bulk create prospects",
        });
      }
    }
  );

  // PUT /api/admin/prospects/:orgId - Update prospect
  router.put(
    "/prospects/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const {
          prospect_status,
          prospect_source,
          prospect_owner,
          prospect_notes,
          prospect_contact_name,
          prospect_contact_email,
          prospect_contact_title,
          prospect_next_action,
          prospect_next_action_date,
          company_type,
          revenue_tier,
          parent_organization_id,
        } = req.body;

        const pool = getPool();

        // Build dynamic update query
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (prospect_status !== undefined) {
          updates.push(`prospect_status = $${paramIndex++}`);
          values.push(prospect_status);
        }
        if (prospect_source !== undefined) {
          updates.push(`prospect_source = $${paramIndex++}`);
          values.push(prospect_source);
        }
        if (prospect_owner !== undefined) {
          updates.push(`prospect_owner = $${paramIndex++}`);
          values.push(prospect_owner);
        }
        if (prospect_notes !== undefined) {
          updates.push(`prospect_notes = $${paramIndex++}`);
          values.push(prospect_notes);
        }
        if (prospect_contact_name !== undefined) {
          updates.push(`prospect_contact_name = $${paramIndex++}`);
          values.push(prospect_contact_name);
        }
        if (prospect_contact_email !== undefined) {
          updates.push(`prospect_contact_email = $${paramIndex++}`);
          values.push(prospect_contact_email);
        }
        if (prospect_contact_title !== undefined) {
          updates.push(`prospect_contact_title = $${paramIndex++}`);
          values.push(prospect_contact_title);
        }
        if (prospect_next_action !== undefined) {
          updates.push(`prospect_next_action = $${paramIndex++}`);
          values.push(prospect_next_action);
        }
        if (prospect_next_action_date !== undefined) {
          updates.push(`prospect_next_action_date = $${paramIndex++}`);
          values.push(prospect_next_action_date);
        }
        if (company_type !== undefined) {
          updates.push(`company_type = $${paramIndex++}`);
          values.push(company_type);
        }
        if (revenue_tier !== undefined) {
          updates.push(`revenue_tier = $${paramIndex++}`);
          values.push(revenue_tier);
        }
        if (parent_organization_id !== undefined) {
          updates.push(`parent_organization_id = $${paramIndex++}`);
          values.push(parent_organization_id);
        }

        if (updates.length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }

        updates.push("updated_at = NOW()");
        values.push(orgId);

        const result = await pool.query(
          `UPDATE organizations
         SET ${updates.join(", ")}
         WHERE workos_organization_id = $${paramIndex}
         RETURNING *`,
          values
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Prospect not found" });
        }

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, "Error updating prospect");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to update prospect",
        });
      }
    }
  );

  // GET /api/admin/prospects/stats - Get prospect statistics
  router.get(
    "/prospects/stats",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();

        const result = await pool.query(`
        SELECT
          prospect_status,
          COUNT(*) as count
        FROM organizations
        WHERE prospect_status IS NOT NULL
        GROUP BY prospect_status
        ORDER BY
          CASE prospect_status
            WHEN 'prospect' THEN 1
            WHEN 'contacted' THEN 2
            WHEN 'interested' THEN 3
            WHEN 'negotiating' THEN 4
            WHEN 'converted' THEN 5
            WHEN 'declined' THEN 6
            ELSE 7
          END
      `);

        const stats: Record<string, number> = {};
        let total = 0;

        for (const row of result.rows) {
          stats[row.prospect_status] = parseInt(row.count);
          total += parseInt(row.count);
        }

        res.json({
          by_status: stats,
          total,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching prospect stats");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch prospect statistics",
        });
      }
    }
  );

  // GET /api/admin/organizations - List all organizations (for parent org dropdown)
  router.get(
    "/organizations",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();

        const result = await pool.query(`
        SELECT
          workos_organization_id,
          name,
          company_type,
          prospect_status
        FROM organizations
        ORDER BY name ASC
      `);

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error }, "Error fetching organizations");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch organizations",
        });
      }
    }
  );

  return router;
}
