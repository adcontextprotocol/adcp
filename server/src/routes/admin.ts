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
import { SlackDatabase } from "../db/slack-db.js";
import { OrganizationDatabase } from "../db/organization-db.js";
import {
  createCheckoutSession,
  getProductsForCustomer,
  getPendingInvoices,
  createAndSendInvoice,
} from "../billing/stripe-client.js";
import { getMemberContext, getWebMemberContext } from "../addie/member-context.js";

const slackDb = new SlackDatabase();
const orgDb = new OrganizationDatabase();

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
 * Returns separate routers for page routes (/admin/*) and API routes (/api/admin/*)
 */
export function createAdminRouter(): { pageRouter: Router; apiRouter: Router } {
  const pageRouter = Router();
  const apiRouter = Router();

  // =========================================================================
  // ADMIN PAGE ROUTES (mounted at /admin)
  // =========================================================================

  pageRouter.get("/prospects", requireAuth, requireAdmin, (req, res) => {
    const prospectsPath =
      process.env.NODE_ENV === "production"
        ? path.join(__dirname, "../../server/public/admin-prospects.html")
        : path.join(__dirname, "../../public/admin-prospects.html");
    res.sendFile(prospectsPath);
  });

  // =========================================================================
  // PROSPECT MANAGEMENT API (mounted at /api/admin)
  // =========================================================================

  // GET /api/admin/prospects - List all prospects with action-based views
  apiRouter.get("/prospects", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const { status, source, view, owner } = req.query;

      // Base SELECT fields
      const selectFields = `
        SELECT
          o.workos_organization_id,
          o.name,
          o.company_type,
          o.revenue_tier,
          o.is_personal,
          COALESCE(o.prospect_status, 'signed_up') as prospect_status,
          COALESCE(o.prospect_source, 'organic') as prospect_source,
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
          o.invoice_requested_at,
          o.last_activity_at,
          p.name as parent_name,
          (SELECT COUNT(*) FROM organizations WHERE parent_organization_id = o.workos_organization_id) as subsidiary_count,
          o.subscription_status,
          o.subscription_product_name,
          o.subscription_current_period_end
      `;

      const params: (string | Date | null)[] = [];
      let query = "";
      let orderBy = "";

      // Action-based views
      if (view && typeof view === "string") {
        switch (view) {
          case "needs_followup":
            // Orgs with pending next steps due in next 7 days
            query = `
              ${selectFields},
              na.next_step_due_date as followup_due,
              na.description as followup_description
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              INNER JOIN org_activities na ON na.organization_id = o.workos_organization_id
                AND na.is_next_step = TRUE
                AND na.next_step_completed_at IS NULL
                AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
            `;
            orderBy = ` ORDER BY na.next_step_due_date ASC NULLS FIRST`;
            break;

          case "hot_prospects":
            // Non-paying orgs with high engagement (level 3+)
            // We'll calculate engagement in JS, so just get non-paying orgs
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
            `;
            orderBy = ` ORDER BY o.invoice_requested_at DESC NULLS LAST, o.last_activity_at DESC NULLS LAST`;
            break;

          case "new_signups":
            // Orgs created in last 14 days with no activities logged
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
            params.push(fourteenDaysAgo);
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.created_at > $${params.length}
                AND NOT EXISTS (SELECT 1 FROM org_activities WHERE organization_id = o.workos_organization_id)
            `;
            orderBy = ` ORDER BY o.created_at DESC`;
            break;

          case "going_cold":
            // Orgs with activity more than 30 days ago (but had some activity)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            params.push(thirtyDaysAgo);
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.last_activity_at IS NOT NULL
                AND o.last_activity_at < $${params.length}
                AND (
                  o.subscription_status IS NULL
                  OR o.subscription_status NOT IN ('active', 'trialing')
                  OR o.subscription_canceled_at IS NOT NULL
                )
            `;
            orderBy = ` ORDER BY o.last_activity_at ASC`;
            break;

          case "renewals":
            // Paying orgs with subscription ending in next 60 days
            const sixtyDaysFromNow = new Date();
            sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
            params.push(new Date());
            params.push(sixtyDaysFromNow);
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.subscription_status = 'active'
                AND o.subscription_current_period_end IS NOT NULL
                AND o.subscription_current_period_end >= $${params.length - 1}
                AND o.subscription_current_period_end <= $${params.length}
            `;
            orderBy = ` ORDER BY o.subscription_current_period_end ASC`;
            break;

          case "low_engagement":
            // Paying members with low engagement (we'll filter by engagement_level <= 2 in JS)
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.subscription_status = 'active'
                AND o.subscription_canceled_at IS NULL
            `;
            orderBy = ` ORDER BY o.last_activity_at ASC NULLS FIRST`;
            break;

          case "my_accounts":
            // Accounts where current user is a stakeholder
            const userId = req.user?.id;
            if (userId) {
              params.push(userId);
              query = `
                ${selectFields},
                os.role as stakeholder_role
                FROM organizations o
                LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
                INNER JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
                  AND os.user_id = $${params.length}
              `;
              orderBy = ` ORDER BY os.role ASC, o.name ASC`;
            } else {
              // No user ID, return empty
              return res.json([]);
            }
            break;

          default:
            // Fall back to default query for unknown views
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
            `;
            orderBy = ` ORDER BY o.created_at DESC`;
        }
      } else {
        // Default: Show all non-paying orgs (original behavior)
        query = `
          ${selectFields}
          FROM organizations o
          LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
          WHERE (
            o.subscription_status IS NULL
            OR o.subscription_status NOT IN ('active', 'trialing')
            OR o.subscription_canceled_at IS NOT NULL
          )
        `;
        orderBy = ` ORDER BY o.prospect_next_action_date ASC NULLS LAST, o.created_at DESC`;
      }

      // Apply additional filters (status, source, owner) if not using a specialized view
      if (!view || view === "hot_prospects" || view === "going_cold" || view === "low_engagement") {
        if (status && typeof status === "string") {
          params.push(status);
          query += ` AND o.prospect_status = $${params.length}`;
        }

        if (source && typeof source === "string") {
          params.push(source);
          query += ` AND o.prospect_source = $${params.length}`;
        }

        if (owner && typeof owner === "string") {
          params.push(owner);
          query += ` AND o.prospect_owner = $${params.length}`;
        }
      }

      query += orderBy;

      const result = await pool.query(query, params);

      // Get working group counts for all orgs
      const workingGroupCounts = await pool.query(`
        SELECT workos_organization_id as organization_id, COUNT(DISTINCT working_group_id) as wg_count
        FROM working_group_memberships
        WHERE status = 'active' AND workos_organization_id IS NOT NULL
        GROUP BY workos_organization_id
      `);
      const wgCountMap = new Map(
        workingGroupCounts.rows.map((r) => [r.organization_id, parseInt(r.wg_count)])
      );

      // Get recent activity counts (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentActivityCounts = await pool.query(
        `
        SELECT organization_id, COUNT(*) as activity_count
        FROM org_activities
        WHERE activity_date > $1
        GROUP BY organization_id
      `,
        [thirtyDaysAgo]
      );
      const activityCountMap = new Map(
        recentActivityCounts.rows.map((r) => [
          r.organization_id,
          parseInt(r.activity_count),
        ])
      );

      // Enrich with WorkOS membership count and engagement level
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

          // Calculate engagement level
          const wgCount = wgCountMap.get(row.workos_organization_id) || 0;
          const recentActivityCount =
            activityCountMap.get(row.workos_organization_id) || 0;

          let engagementLevel = 1; // Base level - exists
          const engagementReasons: string[] = [];

          if (row.invoice_requested_at) {
            engagementLevel = 5;
            engagementReasons.push("Requested invoice");
          } else if (wgCount > 0) {
            engagementLevel = 4;
            engagementReasons.push(`In ${wgCount} working group(s)`);
          } else if (memberCount > 0) {
            engagementLevel = 3;
            engagementReasons.push(`${memberCount} team member(s)`);
          } else if (recentActivityCount > 0) {
            engagementLevel = 2;
            engagementReasons.push("Recent contact");
          }

          return {
            ...row,
            member_count: memberCount,
            has_members: memberCount > 0,
            working_group_count: wgCount,
            engagement_level: engagementLevel,
            engagement_reasons: engagementReasons,
          };
        })
      );

      // Filter by engagement level for specific views
      let filteredProspects = prospects;
      if (view === "hot_prospects") {
        // Only show high engagement (level 3+)
        filteredProspects = prospects.filter((p) => p.engagement_level >= 3);
      } else if (view === "low_engagement") {
        // Only show low engagement (level 2 or less)
        filteredProspects = prospects.filter((p) => p.engagement_level <= 2);
      }

      res.json(filteredProspects);
    } catch (error) {
      logger.error({ err: error }, "Error fetching prospects");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch prospects",
      });
    }
  });

  // POST /api/admin/prospects - Create a new prospect
  apiRouter.post("/prospects", requireAuth, requireAdmin, async (req, res) => {
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
  apiRouter.post(
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
              company_type,
              prospect_owner,
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
              parent_organization_id,
              company_type,
              prospect_owner
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
                company_type || null,
                prospect_owner || null,
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
  apiRouter.put(
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
  apiRouter.get(
    "/prospects/stats",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();

        // Count all non-paying orgs by status (including signed_up for those without explicit status)
        const result = await pool.query(`
        SELECT
          COALESCE(prospect_status, 'signed_up') as prospect_status,
          COUNT(*) as count
        FROM organizations
        WHERE (
          subscription_status IS NULL
          OR subscription_status NOT IN ('active', 'trialing')
          OR subscription_canceled_at IS NOT NULL
        )
        GROUP BY COALESCE(prospect_status, 'signed_up')
        ORDER BY
          CASE COALESCE(prospect_status, 'signed_up')
            WHEN 'signed_up' THEN 0
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
  apiRouter.get(
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

  // =========================================================================
  // ORGANIZATION DETAIL PAGE AND API
  // =========================================================================

  // Page route for org detail
  pageRouter.get(
    "/organizations/:orgId",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const detailPath =
        process.env.NODE_ENV === "production"
          ? path.join(__dirname, "../../server/public/admin-org-detail.html")
          : path.join(__dirname, "../../public/admin-org-detail.html");
      res.sendFile(detailPath);
    }
  );

  // GET /api/admin/organizations/:orgId - Get full org details with engagement data
  apiRouter.get(
    "/organizations/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        // Get organization details
        const orgResult = await pool.query(
          `
          SELECT
            o.*,
            p.name as parent_name,
            (SELECT COUNT(*) FROM organizations WHERE parent_organization_id = o.workos_organization_id) as subsidiary_count
          FROM organizations o
          LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
          WHERE o.workos_organization_id = $1
        `,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];

        // Get member count from WorkOS
        let memberCount = 0;
        let members: any[] = [];
        try {
          if (workos) {
            const memberships =
              await workos.userManagement.listOrganizationMemberships({
                organizationId: orgId,
              });
            memberCount = memberships.data?.length || 0;

            // Get user details for each membership
            for (const membership of memberships.data || []) {
              try {
                const user = await workos.userManagement.getUser(
                  membership.userId
                );
                members.push({
                  id: user.id,
                  email: user.email,
                  firstName: user.firstName,
                  lastName: user.lastName,
                  role: membership.role?.slug || "member",
                });
              } catch {
                // User might not exist
              }
            }
          }
        } catch {
          // Org might not exist in WorkOS
        }

        // Get working group memberships
        const workingGroupResult = await pool.query(
          `
          SELECT DISTINCT wg.id, wg.name, wg.slug, wgm.status, wgm.joined_at
          FROM working_group_memberships wgm
          JOIN working_groups wg ON wgm.working_group_id = wg.id
          WHERE wgm.workos_organization_id = $1 AND wgm.status = 'active'
        `,
          [orgId]
        );

        // Get recent activities
        const activitiesResult = await pool.query(
          `
          SELECT *
          FROM org_activities
          WHERE organization_id = $1
          ORDER BY activity_date DESC
          LIMIT 50
        `,
          [orgId]
        );

        // Get pending next steps
        const nextStepsResult = await pool.query(
          `
          SELECT *
          FROM org_activities
          WHERE organization_id = $1
            AND is_next_step = TRUE
            AND next_step_completed_at IS NULL
          ORDER BY next_step_due_date ASC NULLS LAST
        `,
          [orgId]
        );

        // Get engagement signals using the new engagement tracking system
        const engagementSignals = await orgDb.getEngagementSignals(orgId);

        // Calculate engagement level based on signals
        let engagementLevel = 1; // Base level - exists
        let engagementReasons: string[] = [];

        // Priority-based scoring - use human interest level first if set
        if (engagementSignals.interest_level === 'very_high') {
          engagementLevel = 5;
          engagementReasons.push(`Interest: Very High (${engagementSignals.interest_level_set_by || 'admin'})`);
        } else if (engagementSignals.interest_level === 'high') {
          engagementLevel = 4;
          engagementReasons.push(`Interest: High (${engagementSignals.interest_level_set_by || 'admin'})`);
        } else if (org.invoice_requested_at) {
          engagementLevel = 5;
          engagementReasons.push("Requested invoice");
        } else if (engagementSignals.working_group_count > 0) {
          engagementLevel = 4;
          engagementReasons.push(`In ${engagementSignals.working_group_count} working group(s)`);
        } else if (engagementSignals.has_member_profile) {
          engagementLevel = 4;
          engagementReasons.push("Member profile configured");
        } else if (engagementSignals.login_count_30d > 3) {
          engagementLevel = 3;
          engagementReasons.push(`${engagementSignals.login_count_30d} dashboard logins (30d)`);
        } else if (memberCount > 0) {
          engagementLevel = 3;
          engagementReasons.push(`${memberCount} team member(s)`);
        } else if (engagementSignals.email_click_count_30d > 0) {
          engagementLevel = 2;
          engagementReasons.push(`${engagementSignals.email_click_count_30d} email clicks (30d)`);
        } else if (engagementSignals.login_count_30d > 0) {
          engagementLevel = 2;
          engagementReasons.push(`${engagementSignals.login_count_30d} dashboard login(s) (30d)`);
        } else if (activitiesResult.rows.length > 0) {
          const recentActivity = activitiesResult.rows.find((a) => {
            const activityDate = new Date(a.activity_date);
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            return activityDate > thirtyDaysAgo;
          });
          if (recentActivity) {
            engagementLevel = 2;
            engagementReasons.push("Recent contact");
          }
        }

        // Handle low/medium interest levels - should cap the engagement
        if (engagementSignals.interest_level === 'low') {
          engagementLevel = Math.min(engagementLevel, 2);
          engagementReasons.unshift(`Interest: Low (${engagementSignals.interest_level_set_by || 'admin'})`);
        } else if (engagementSignals.interest_level === 'medium') {
          engagementLevel = Math.min(engagementLevel, 3);
          engagementReasons.unshift(`Interest: Medium (${engagementSignals.interest_level_set_by || 'admin'})`);
        }

        // Fetch pending invoices if org has a Stripe customer ID
        let pendingInvoices: Awaited<ReturnType<typeof getPendingInvoices>> = [];
        if (org.stripe_customer_id) {
          try {
            pendingInvoices = await getPendingInvoices(org.stripe_customer_id);
          } catch (err) {
            logger.warn({ err, orgId, stripeCustomerId: org.stripe_customer_id }, 'Error fetching pending invoices');
          }
        }

        res.json({
          ...org,
          member_count: memberCount,
          members,
          working_groups: workingGroupResult.rows,
          activities: activitiesResult.rows,
          next_steps: nextStepsResult.rows,
          engagement_level: engagementLevel,
          engagement_reasons: engagementReasons,
          engagement_signals: engagementSignals,
          pending_invoices: pendingInvoices,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching organization details");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch organization details",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/activities - Log an activity
  apiRouter.post(
    "/organizations/:orgId/activities",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const {
          activity_type,
          description,
          activity_date,
          is_next_step,
          next_step_due_date,
          next_step_owner_user_id,
          next_step_owner_name,
        } = req.body;

        if (!activity_type) {
          return res.status(400).json({ error: "activity_type is required" });
        }

        const pool = getPool();

        // Get logged-in user info
        const loggedByUserId = req.user?.id || null;
        const loggedByName = req.user
          ? `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
            req.user.email
          : null;

        const result = await pool.query(
          `
          INSERT INTO org_activities (
            organization_id,
            activity_type,
            description,
            logged_by_user_id,
            logged_by_name,
            activity_date,
            is_next_step,
            next_step_due_date,
            next_step_owner_user_id,
            next_step_owner_name
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `,
          [
            orgId,
            activity_type,
            description || null,
            loggedByUserId,
            loggedByName,
            activity_date || new Date(),
            is_next_step || false,
            next_step_due_date || null,
            next_step_owner_user_id || null,
            next_step_owner_name || null,
          ]
        );

        // Update last_activity_at on the organization
        await pool.query(
          `
          UPDATE organizations
          SET last_activity_at = $2, updated_at = NOW()
          WHERE workos_organization_id = $1
        `,
          [orgId, activity_date || new Date()]
        );

        // If invoice_requested, update that field too
        if (activity_type === "invoice_requested") {
          await pool.query(
            `
            UPDATE organizations
            SET invoice_requested_at = $2
            WHERE workos_organization_id = $1 AND invoice_requested_at IS NULL
          `,
            [orgId, activity_date || new Date()]
          );
        }

        res.status(201).json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, "Error logging activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to log activity",
        });
      }
    }
  );

  // PUT /api/admin/organizations/:orgId/activities/:activityId - Update activity (e.g., complete next step)
  apiRouter.put(
    "/organizations/:orgId/activities/:activityId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId, activityId } = req.params;
        const { next_step_completed_at, description, next_step_due_date } =
          req.body;

        const pool = getPool();

        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (next_step_completed_at !== undefined) {
          updates.push(`next_step_completed_at = $${paramIndex++}`);
          values.push(next_step_completed_at);
        }
        if (description !== undefined) {
          updates.push(`description = $${paramIndex++}`);
          values.push(description);
        }
        if (next_step_due_date !== undefined) {
          updates.push(`next_step_due_date = $${paramIndex++}`);
          values.push(next_step_due_date);
        }

        if (updates.length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }

        updates.push("updated_at = NOW()");
        values.push(activityId);
        values.push(orgId);

        const result = await pool.query(
          `
          UPDATE org_activities
          SET ${updates.join(", ")}
          WHERE id = $${paramIndex} AND organization_id = $${paramIndex + 1}
          RETURNING *
        `,
          values
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Activity not found" });
        }

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, "Error updating activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to update activity",
        });
      }
    }
  );

  // =========================================================================
  // STAKEHOLDER MANAGEMENT API
  // =========================================================================

  // GET /api/admin/organizations/:orgId/stakeholders - Get all stakeholders for an org
  apiRouter.get(
    "/organizations/:orgId/stakeholders",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        const result = await pool.query(
          `
          SELECT *
          FROM org_stakeholders
          WHERE organization_id = $1
          ORDER BY
            CASE role
              WHEN 'owner' THEN 1
              WHEN 'interested' THEN 2
              WHEN 'connected' THEN 3
            END,
            created_at ASC
        `,
          [orgId]
        );

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error }, "Error fetching stakeholders");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch stakeholders",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/stakeholders - Add stakeholder (or update role)
  apiRouter.post(
    "/organizations/:orgId/stakeholders",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { user_id, user_name, user_email, role, notes } = req.body;

        // If no user_id provided, use the current logged-in user
        const actualUserId = user_id || req.user?.id;
        const actualUserName =
          user_name ||
          (req.user
            ? `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
              req.user.email
            : null);
        const actualUserEmail = user_email || req.user?.email;

        if (!actualUserId) {
          return res.status(400).json({ error: "user_id is required" });
        }

        if (!role || !["owner", "interested", "connected"].includes(role)) {
          return res.status(400).json({
            error: "role must be one of: owner, interested, connected",
          });
        }

        const pool = getPool();

        // Upsert: insert or update if already exists
        const result = await pool.query(
          `
          INSERT INTO org_stakeholders (
            organization_id,
            user_id,
            user_name,
            user_email,
            role,
            notes
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (organization_id, user_id)
          DO UPDATE SET
            role = EXCLUDED.role,
            notes = COALESCE(EXCLUDED.notes, org_stakeholders.notes),
            user_name = EXCLUDED.user_name,
            user_email = EXCLUDED.user_email,
            updated_at = NOW()
          RETURNING *
        `,
          [
            orgId,
            actualUserId,
            actualUserName,
            actualUserEmail,
            role,
            notes || null,
          ]
        );

        res.status(201).json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, "Error adding stakeholder");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to add stakeholder",
        });
      }
    }
  );

  // DELETE /api/admin/organizations/:orgId/stakeholders/:stakeholderId - Remove stakeholder
  apiRouter.delete(
    "/organizations/:orgId/stakeholders/:stakeholderId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId, stakeholderId } = req.params;
        const pool = getPool();

        const result = await pool.query(
          `
          DELETE FROM org_stakeholders
          WHERE id = $1 AND organization_id = $2
          RETURNING *
        `,
          [stakeholderId, orgId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Stakeholder not found" });
        }

        res.json({ success: true, deleted: result.rows[0] });
      } catch (error) {
        logger.error({ err: error }, "Error removing stakeholder");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to remove stakeholder",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/stakeholders/me - Quick "I'm connected" for current user
  apiRouter.post(
    "/organizations/:orgId/stakeholders/me",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { role } = req.body;

        if (!req.user?.id) {
          return res.status(401).json({ error: "User not authenticated" });
        }

        const actualRole = role || "connected";
        if (!["owner", "interested", "connected"].includes(actualRole)) {
          return res.status(400).json({
            error: "role must be one of: owner, interested, connected",
          });
        }

        const pool = getPool();

        const userName =
          `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
          req.user.email;

        // Upsert for current user
        const result = await pool.query(
          `
          INSERT INTO org_stakeholders (
            organization_id,
            user_id,
            user_name,
            user_email,
            role
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (organization_id, user_id)
          DO UPDATE SET
            role = EXCLUDED.role,
            updated_at = NOW()
          RETURNING *
        `,
          [orgId, req.user.id, userName, req.user.email, actualRole]
        );

        res.status(201).json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, "Error adding self as stakeholder");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to add yourself as stakeholder",
        });
      }
    }
  );

  // DELETE /api/admin/organizations/:orgId/stakeholders/me - Remove self as stakeholder
  apiRouter.delete(
    "/organizations/:orgId/stakeholders/me",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;

        if (!req.user?.id) {
          return res.status(401).json({ error: "User not authenticated" });
        }

        const pool = getPool();

        const result = await pool.query(
          `
          DELETE FROM org_stakeholders
          WHERE organization_id = $1 AND user_id = $2
          RETURNING *
        `,
          [orgId, req.user.id]
        );

        if (result.rows.length === 0) {
          return res
            .status(404)
            .json({ error: "You are not a stakeholder for this organization" });
        }

        res.json({ success: true, deleted: result.rows[0] });
      } catch (error) {
        logger.error({ err: error }, "Error removing self as stakeholder");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to remove yourself as stakeholder",
        });
      }
    }
  );

  // =========================================================================
  // ENGAGEMENT / INTEREST LEVEL MANAGEMENT
  // =========================================================================

  // PUT /api/admin/organizations/:orgId/interest-level - Set interest level for an org
  apiRouter.put(
    "/organizations/:orgId/interest-level",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { interest_level, note } = req.body;

        // Validate interest level
        const validLevels = ['low', 'medium', 'high', 'very_high', null];
        if (!validLevels.includes(interest_level)) {
          return res.status(400).json({
            error: "Invalid interest_level. Must be one of: low, medium, high, very_high (or null to clear)",
          });
        }

        // Get the admin's name
        const setBy = req.user
          ? `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
            req.user.email
          : "admin";

        await orgDb.setInterestLevel(orgId, {
          interest_level,
          note,
          set_by: setBy,
        });

        // Return the updated engagement signals
        const engagementSignals = await orgDb.getEngagementSignals(orgId);

        logger.info(
          { orgId, interest_level, setBy },
          "Interest level updated"
        );

        res.json({
          success: true,
          engagement_signals: engagementSignals,
        });
      } catch (error) {
        logger.error({ err: error }, "Error setting interest level");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to set interest level",
        });
      }
    }
  );

  // GET /api/admin/organizations/:orgId/engagement-signals - Get engagement signals for an org
  apiRouter.get(
    "/organizations/:orgId/engagement-signals",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const engagementSignals = await orgDb.getEngagementSignals(orgId);
        res.json(engagementSignals);
      } catch (error) {
        logger.error({ err: error }, "Error fetching engagement signals");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch engagement signals",
        });
      }
    }
  );

  // =========================================================================
  // SLACK DOMAIN DISCOVERY FOR PROSPECT IDENTIFICATION
  // =========================================================================

  // GET /api/admin/slack/domains - Get email domains from unmapped Slack users
  // These are potential organizations to add as prospects
  apiRouter.get(
    "/slack/domains",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { min_users, limit, include_free } = req.query;

        const domains = await slackDb.getUnmappedDomains({
          excludeFreeEmailProviders: include_free !== "true",
          minUsers: min_users ? parseInt(min_users as string, 10) : 1,
          limit: limit ? parseInt(limit as string, 10) : 100,
        });

        // Check which domains already have organizations
        const pool = getPool();
        const enrichedDomains = await Promise.all(
          domains.map(async (domain) => {
            // Check if this domain is already associated with an org
            // by checking WorkOS organization domains
            let existingOrg = null;
            try {
              if (workos) {
                // Search for orgs with this domain
                const orgs = await workos.organizations.listOrganizations({
                  limit: 1,
                  domains: [domain.domain],
                });
                if (orgs.data.length > 0) {
                  const orgResult = await pool.query(
                    `SELECT name, workos_organization_id FROM organizations WHERE workos_organization_id = $1`,
                    [orgs.data[0].id]
                  );
                  if (orgResult.rows.length > 0) {
                    existingOrg = {
                      id: orgs.data[0].id,
                      name: orgResult.rows[0].name,
                    };
                  }
                }
              }
            } catch {
              // Ignore lookup errors
            }

            return {
              ...domain,
              existing_org: existingOrg,
              is_new_prospect: !existingOrg,
            };
          })
        );

        res.json({
          domains: enrichedDomains,
          total: enrichedDomains.length,
          new_prospect_count: enrichedDomains.filter((d) => d.is_new_prospect)
            .length,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching Slack domains");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch Slack domains",
        });
      }
    }
  );

  // POST /api/admin/slack/domains/:domain/create-prospect - Create a prospect from a Slack domain
  apiRouter.post(
    "/slack/domains/:domain/create-prospect",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { domain } = req.params;
        const { name, prospect_notes } = req.body;

        if (!workos) {
          return res.status(500).json({ error: "WorkOS not configured" });
        }

        // Get the users from this domain for context
        const domainData = await slackDb.getUnmappedDomains({
          excludeFreeEmailProviders: false,
          minUsers: 1,
        });
        const domainInfo = domainData.find(
          (d) => d.domain.toLowerCase() === domain.toLowerCase()
        );

        if (!domainInfo) {
          return res.status(404).json({
            error: "Domain not found in unmapped Slack users",
          });
        }

        // Generate a name if not provided
        const orgName =
          name ||
          domain
            .split(".")
            .slice(0, -1)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");

        // Create organization in WorkOS with the domain
        const workosOrg = await workos.organizations.createOrganization({
          name: orgName,
          domainData: [{ domain: domain, state: DomainDataState.Verified }],
        });

        logger.info(
          { orgId: workosOrg.id, name: orgName, domain },
          "Created WorkOS organization from Slack domain"
        );

        // Create local record
        const pool = getPool();
        const slackUserNames = domainInfo.users
          .map((u) => u.slack_real_name || u.slack_display_name)
          .filter(Boolean)
          .slice(0, 5)
          .join(", ");

        const notes =
          prospect_notes ||
          `Discovered via Slack. ${domainInfo.user_count} user(s) in Slack workspace: ${slackUserNames}`;

        const result = await pool.query(
          `INSERT INTO organizations (
            workos_organization_id,
            name,
            prospect_status,
            prospect_source,
            prospect_notes
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [workosOrg.id, orgName, "prospect", "slack_discovery", notes]
        );

        res.status(201).json({
          ...result.rows[0],
          domain,
          slack_users: domainInfo.users,
          workos_org: {
            id: workosOrg.id,
            domains: workosOrg.domains,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error creating prospect from Slack domain");

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
    }
  );

  // =========================================================================
  // SLACK ACTIVITY INSIGHTS FOR ENGAGEMENT TRACKING
  // =========================================================================

  // GET /api/admin/slack/activity/top-users - Get most active Slack users
  apiRouter.get(
    "/slack/activity/top-users",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { days, limit, mapped_only } = req.query;

        const users = await slackDb.getMostActiveUsers({
          days: days ? parseInt(days as string, 10) : 30,
          limit: limit ? parseInt(limit as string, 10) : 50,
          mappedOnly: mapped_only === "true",
        });

        res.json({
          users,
          total: users.length,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching top Slack users");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch top Slack users",
        });
      }
    }
  );

  // GET /api/admin/slack/activity/user/:slackUserId - Get activity summary for a Slack user
  apiRouter.get(
    "/slack/activity/user/:slackUserId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { slackUserId } = req.params;
        const { days } = req.query;

        const [summary, mapping] = await Promise.all([
          slackDb.getActivitySummary(slackUserId, {
            days: days ? parseInt(days as string, 10) : 30,
          }),
          slackDb.getBySlackUserId(slackUserId),
        ]);

        if (!mapping) {
          return res.status(404).json({ error: "Slack user not found" });
        }

        res.json({
          user: {
            slack_user_id: mapping.slack_user_id,
            slack_email: mapping.slack_email,
            slack_real_name: mapping.slack_real_name,
            slack_display_name: mapping.slack_display_name,
            workos_user_id: mapping.workos_user_id,
            mapping_status: mapping.mapping_status,
          },
          activity: summary,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching Slack user activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch Slack user activity",
        });
      }
    }
  );

  // GET /api/admin/organizations/:orgId/slack-activity - Get Slack activity for an org
  apiRouter.get(
    "/organizations/:orgId/slack-activity",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { days } = req.query;

        const summary = await slackDb.getOrgActivitySummary(orgId, {
          days: days ? parseInt(days as string, 10) : 30,
        });

        res.json({
          organization_id: orgId,
          activity: summary,
          period_days: days ? parseInt(days as string, 10) : 30,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching org Slack activity");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch organization Slack activity",
        });
      }
    }
  );

  // =========================================================================
  // USER CONTEXT API (for viewing member context like Addie sees it)
  // =========================================================================

  // GET /api/admin/users/:userId/context - Get member context for a user
  // Accepts either a WorkOS user ID or Slack user ID
  apiRouter.get(
    "/users/:userId/context",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { userId } = req.params;
        const { type } = req.query; // 'workos' or 'slack' - defaults to auto-detect

        let context;

        // Auto-detect or use specified type
        if (type === "slack" || (!type && userId.startsWith("U"))) {
          // Slack user ID (starts with U)
          context = await getMemberContext(userId);
        } else if (type === "workos" || (!type && userId.startsWith("user_"))) {
          // WorkOS user ID (starts with user_)
          context = await getWebMemberContext(userId);
        } else {
          // Try both - first check if it's a WorkOS ID
          try {
            context = await getWebMemberContext(userId);
            // If the context came back with meaningful data, use it
            if (context.workos_user || context.organization) {
              // Good, we found the user
            } else {
              // Try as Slack ID
              context = await getMemberContext(userId);
            }
          } catch {
            // Fall back to Slack lookup
            context = await getMemberContext(userId);
          }
        }

        if (!context.is_mapped && !context.slack_user && !context.workos_user) {
          return res.status(404).json({
            error: "User not found",
            message: "Could not find context for this user ID",
          });
        }

        res.json(context);
      } catch (error) {
        logger.error({ err: error }, "Error fetching user context");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch user context",
        });
      }
    }
  );

  // GET /api/admin/prospects/view-counts - Get counts for each view for the nav
  apiRouter.get(
    "/prospects/view-counts",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const userId = req.user?.id;

        // Run all counts in parallel
        const [
          needsFollowup,
          newSignups,
          goingCold,
          renewals,
          myAccounts,
        ] = await Promise.all([
          // Needs follow-up: pending next steps due in next 7 days
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
          `),

          // New signups: created in last 14 days with no activities
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.created_at > NOW() - INTERVAL '14 days'
              AND NOT EXISTS (SELECT 1 FROM org_activities WHERE organization_id = o.workos_organization_id)
          `),

          // Going cold: last activity > 30 days ago
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.last_activity_at IS NOT NULL
              AND o.last_activity_at < NOW() - INTERVAL '30 days'
              AND (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
          `),

          // Renewals: subscription ending in next 60 days
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND o.subscription_current_period_end IS NOT NULL
              AND o.subscription_current_period_end >= NOW()
              AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
          `),

          // My accounts: orgs where current user is a stakeholder
          userId
            ? pool.query(
                `
            SELECT COUNT(*) as count
            FROM org_stakeholders
            WHERE user_id = $1
          `,
                [userId]
              )
            : Promise.resolve({ rows: [{ count: 0 }] }),
        ]);

        res.json({
          needs_followup: parseInt(needsFollowup.rows[0]?.count || "0"),
          new_signups: parseInt(newSignups.rows[0]?.count || "0"),
          going_cold: parseInt(goingCold.rows[0]?.count || "0"),
          renewals: parseInt(renewals.rows[0]?.count || "0"),
          my_accounts: parseInt(myAccounts.rows[0]?.count || "0"),
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching view counts");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch view counts",
        });
      }
    }
  );

  // =========================================================================
  // PAYMENT LINK GENERATION FOR PROSPECTS
  // =========================================================================

  // POST /api/admin/prospects/:orgId/payment-link - Generate a payment link for a prospect
  apiRouter.post(
    "/prospects/:orgId/payment-link",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { lookup_key } = req.body;

        // Get the organization details
        const pool = getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name, is_personal, prospect_contact_email
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];
        const customerType = org.is_personal ? "individual" : "company";

        // If no specific lookup_key provided, get available products for this customer type
        let priceId: string | undefined;
        let selectedProduct: { lookup_key: string; display_name: string; amount_cents: number } | undefined;

        if (lookup_key) {
          // Get the specific product
          const products = await getProductsForCustomer({
            customerType,
            category: "membership",
          });
          selectedProduct = products.find(p => p.lookup_key === lookup_key);
          if (!selectedProduct) {
            return res.status(400).json({
              error: "Product not found",
              message: `No product found with lookup key: ${lookup_key}`,
            });
          }
          priceId = selectedProduct.lookup_key;
        } else {
          // Return available products for selection
          const products = await getProductsForCustomer({
            customerType,
            category: "membership",
          });

          return res.json({
            needs_selection: true,
            products: products.map(p => ({
              lookup_key: p.lookup_key,
              display_name: p.display_name,
              amount_cents: p.amount_cents,
              revenue_tiers: p.revenue_tiers,
            })),
            message: "Select a product to generate payment link",
          });
        }

        // Look up price ID from lookup key
        const products = await getProductsForCustomer({ category: "membership" });
        const product = products.find(p => p.lookup_key === lookup_key);
        if (!product) {
          return res.status(400).json({
            error: "Product not found",
            message: `No product found with lookup key: ${lookup_key}`,
          });
        }

        // Create checkout session
        const baseUrl = process.env.BASE_URL || "https://agenticadvertising.org";
        const session = await createCheckoutSession({
          priceId: product.price_id,
          customerEmail: org.prospect_contact_email || undefined,
          successUrl: `${baseUrl}/dashboard?payment=success`,
          cancelUrl: `${baseUrl}/join?payment=cancelled`,
          workosOrganizationId: orgId,
          isPersonalWorkspace: org.is_personal,
        });

        if (!session) {
          return res.status(500).json({
            error: "Failed to create payment link",
            message: "Stripe may not be configured",
          });
        }

        logger.info(
          {
            orgId,
            orgName: org.name,
            lookupKey: lookup_key,
            adminEmail: req.user!.email,
          },
          "Admin generated payment link for prospect"
        );

        res.json({
          success: true,
          payment_url: session.url,
          product: {
            display_name: product.display_name,
            amount_cents: product.amount_cents,
          },
          organization: {
            name: org.name,
            email: org.prospect_contact_email,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error generating payment link");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to generate payment link",
        });
      }
    }
  );

  // =========================================================================
  // INVOICE GENERATION FOR PROSPECTS
  // =========================================================================

  // POST /api/admin/prospects/:orgId/invoice - Generate and send an invoice for a prospect
  apiRouter.post(
    "/prospects/:orgId/invoice",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const {
          lookup_key,
          company_name,
          contact_name,
          contact_email,
          billing_address,
        } = req.body;

        // Validate required fields
        if (!lookup_key || !company_name || !contact_name || !contact_email || !billing_address) {
          return res.status(400).json({
            error: "Missing required fields",
            message: "lookup_key, company_name, contact_name, contact_email, and billing_address are required",
          });
        }

        // Validate billing address
        if (!billing_address.line1 || !billing_address.city || !billing_address.state ||
            !billing_address.postal_code || !billing_address.country) {
          return res.status(400).json({
            error: "Incomplete billing address",
            message: "Billing address must include line1, city, state, postal_code, and country",
          });
        }

        // Verify the organization exists
        const pool = getPool();
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];

        // Create and send the invoice
        const result = await createAndSendInvoice({
          lookupKey: lookup_key,
          companyName: company_name,
          contactName: contact_name,
          contactEmail: contact_email,
          billingAddress: {
            line1: billing_address.line1,
            line2: billing_address.line2,
            city: billing_address.city,
            state: billing_address.state,
            postal_code: billing_address.postal_code,
            country: billing_address.country,
          },
          workosOrganizationId: orgId,
        });

        if (!result) {
          return res.status(500).json({
            error: "Failed to create invoice",
            message: "Stripe may not be configured or the product was not found",
          });
        }

        // Update organization to mark invoice was requested
        await pool.query(
          `UPDATE organizations SET
            invoice_requested_at = NOW(),
            prospect_contact_name = $1,
            prospect_contact_email = $2
           WHERE workos_organization_id = $3`,
          [contact_name, contact_email, orgId]
        );

        logger.info(
          {
            orgId,
            orgName: org.name,
            lookupKey: lookup_key,
            invoiceId: result.invoiceId,
            contactEmail: contact_email,
            adminEmail: req.user!.email,
          },
          "Admin sent invoice to prospect"
        );

        res.json({
          success: true,
          invoice_id: result.invoiceId,
          invoice_url: result.invoiceUrl,
          organization: {
            name: org.name,
          },
          contact: {
            name: contact_name,
            email: contact_email,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error sending invoice");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to send invoice",
        });
      }
    }
  );

  return { pageRouter, apiRouter };
}
