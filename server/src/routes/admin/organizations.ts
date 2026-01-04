/**
 * Organization detail and management routes
 * Handles org details, activities, stakeholders, and engagement signals
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { serveHtmlWithConfig } from "../../utils/html-config.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { getPendingInvoices } from "../../billing/stripe-client.js";

const orgDb = new OrganizationDatabase();
const logger = createLogger("admin-organizations");

interface OrganizationRoutesConfig {
  workos: WorkOS | null;
}

export function setupOrganizationRoutes(
  pageRouter: Router,
  apiRouter: Router,
  config: OrganizationRoutesConfig
): void {
  const { workos } = config;

  // Page route for org detail
  pageRouter.get(
    "/organizations/:orgId",
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, "admin-org-detail.html").catch((err) => {
        logger.error({ err }, "Error serving admin org detail page");
        res.status(500).send("Internal server error");
      });
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
  // STAKEHOLDER MANAGEMENT
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

        // Check if user is already an owner - don't downgrade them
        const existing = await pool.query(
          `SELECT role FROM org_stakeholders WHERE organization_id = $1 AND user_id = $2`,
          [orgId, req.user.id]
        );

        if (existing.rows.length > 0 && existing.rows[0].role === "owner" && actualRole !== "owner") {
          return res.status(400).json({
            error: "Cannot change role from owner. Use the owner selector to reassign ownership first.",
          });
        }

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

  // DELETE /api/admin/organizations/:orgId/stakeholders/me - Remove self as stakeholder (but not if owner)
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

        // Only delete if not owner - owners must be reassigned via owner selector
        const result = await pool.query(
          `
          DELETE FROM org_stakeholders
          WHERE organization_id = $1 AND user_id = $2 AND role != 'owner'
          RETURNING *
        `,
          [orgId, req.user.id]
        );

        if (result.rows.length === 0) {
          // Check if they're the owner
          const ownerCheck = await pool.query(
            `SELECT role FROM org_stakeholders WHERE organization_id = $1 AND user_id = $2`,
            [orgId, req.user.id]
          );
          if (ownerCheck.rows.length > 0 && ownerCheck.rows[0].role === "owner") {
            return res.status(400).json({
              error: "Cannot remove yourself as owner. Reassign ownership first.",
            });
          }
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
  // ENGAGEMENT / INTEREST LEVEL
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
}
