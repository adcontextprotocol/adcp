/**
 * Organization API routes
 * API endpoints for org details, activities, stakeholders, and engagement signals
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { getPendingInvoices } from "../../billing/stripe-client.js";

const orgDb = new OrganizationDatabase();
const logger = createLogger("admin-organizations");

interface OrganizationRoutesConfig {
  workos: WorkOS | null;
}

export function setupOrganizationRoutes(
  apiRouter: Router,
  config: OrganizationRoutesConfig
): void {
  const { workos } = config;

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

        // Get recent activities (combines org_activities with email activities via contacts)
        const activitiesResult = await pool.query(
          `
          SELECT * FROM (
            -- Direct org activities (manual logs, etc.)
            SELECT
              id::text as id,
              activity_type,
              description,
              logged_by_user_id,
              logged_by_name,
              activity_date,
              is_next_step,
              next_step_due_date,
              next_step_owner_user_id,
              next_step_owner_name,
              next_step_completed_at,
              metadata,
              created_at,
              updated_at
            FROM org_activities
            WHERE organization_id = $1

            UNION ALL

            -- Email activities via linked contacts
            SELECT
              eca.id::text as id,
              'email_inbound' as activity_type,
              eca.insights as description,
              NULL as logged_by_user_id,
              'Addie' as logged_by_name,
              eca.email_date as activity_date,
              false as is_next_step,
              NULL as next_step_due_date,
              NULL as next_step_owner_user_id,
              NULL as next_step_owner_name,
              NULL as next_step_completed_at,
              jsonb_build_object(
                'email_id', eca.email_id,
                'message_id', eca.message_id,
                'subject', eca.subject,
                'contact_email', ec.email,
                'source', 'email_contact_activities'
              ) as metadata,
              eca.created_at,
              eca.created_at as updated_at
            FROM email_contact_activities eca
            INNER JOIN email_activity_contacts eac ON eac.activity_id = eca.id AND eac.is_primary = true
            INNER JOIN email_contacts ec ON ec.id = eac.contact_id
            WHERE ec.organization_id = $1
          ) combined
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

        // When completing a task, clear the org's prospect_next_action if it matches
        const completed = result.rows[0];
        if (next_step_completed_at && completed.is_next_step && completed.next_step_due_date) {
          await pool.query(`
            UPDATE organizations
            SET prospect_next_action = NULL, prospect_next_action_date = NULL, updated_at = NOW()
            WHERE workos_organization_id = $1
              AND prospect_next_action_date = $2
          `, [orgId, completed.next_step_due_date]);
        }

        res.json(completed);
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

  // GET /api/admin/organizations/:orgId/addie-research - Get Addie interactions related to this org
  apiRouter.get(
    "/organizations/:orgId/addie-research",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        // Get org details to find related domains and member emails
        const orgResult = await pool.query(
          `SELECT name, email_domain FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: "Organization not found" });
        }

        const org = orgResult.rows[0];
        const orgName = org.name;
        const emailDomain = org.email_domain;

        // Get linked domains
        const domainsResult = await pool.query(
          `SELECT domain FROM organization_domains WHERE workos_organization_id = $1`,
          [orgId]
        );
        const domains = domainsResult.rows.map((r) => r.domain);

        // Search Addie interactions that mention this org name or domains
        // Look in both input_text and output_text
        const searchTerms = [orgName, ...domains].filter(Boolean);

        if (searchTerms.length === 0) {
          return res.json({ interactions: [] });
        }

        // Build search pattern - case insensitive search for org name or domains
        const searchPattern = searchTerms
          .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");

        const interactionsResult = await pool.query(
          `
          SELECT
            id,
            event_type,
            input_text,
            output_text,
            tools_used,
            user_id,
            created_at
          FROM addie_interactions
          WHERE (
            input_text ~* $1 OR
            output_text ~* $1
          )
          ORDER BY created_at DESC
          LIMIT 20
        `,
          [searchPattern]
        );

        // Get user names for interactions
        const interactions = await Promise.all(
          interactionsResult.rows.map(async (interaction) => {
            let userName = null;
            if (interaction.user_id) {
              // Try to get Slack user name
              const slackUserResult = await pool.query(
                `SELECT slack_display_name, slack_real_name FROM slack_user_mappings WHERE slack_user_id = $1`,
                [interaction.user_id]
              );
              if (slackUserResult.rows.length > 0) {
                userName =
                  slackUserResult.rows[0].slack_display_name ||
                  slackUserResult.rows[0].slack_real_name;
              }
            }

            return {
              id: interaction.id,
              event_type: interaction.event_type,
              summary: interaction.output_text?.substring(0, 500),
              output_text: interaction.output_text,
              tools_used: interaction.tools_used,
              user_name: userName,
              created_at: interaction.created_at,
            };
          })
        );

        res.json({ interactions });
      } catch (error) {
        logger.error({ err: error }, "Error fetching Addie research");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch Addie research",
        });
      }
    }
  );

  // GET /api/admin/organizations/:orgId/member-insights - Get member insights for this org
  apiRouter.get(
    "/organizations/:orgId/member-insights",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        // Get all WorkOS user IDs for members of this org
        // We need to look up via organization memberships
        let memberUserIds: string[] = [];
        try {
          if (workos) {
            const memberships =
              await workos.userManagement.listOrganizationMemberships({
                organizationId: orgId,
              });
            memberUserIds = (memberships.data || []).map((m) => m.userId);
          }
        } catch {
          // Org might not exist in WorkOS
        }

        if (memberUserIds.length === 0) {
          return res.json({ insights: [] });
        }

        // Get Slack user IDs for these WorkOS users
        const slackUsersResult = await pool.query(
          `SELECT slack_user_id, slack_display_name, slack_real_name
           FROM slack_user_mappings
           WHERE workos_user_id = ANY($1)`,
          [memberUserIds]
        );

        const slackUserMap = new Map(
          slackUsersResult.rows.map((r) => [
            r.slack_user_id,
            r.slack_display_name || r.slack_real_name,
          ])
        );
        const slackUserIds = slackUsersResult.rows.map((r) => r.slack_user_id);

        if (slackUserIds.length === 0) {
          return res.json({ insights: [] });
        }

        // Get insights for these Slack users
        const insightsResult = await pool.query(
          `
          SELECT
            mi.slack_user_id,
            mi.value,
            mi.confidence,
            mi.source_type,
            mi.created_at,
            mit.name as insight_type
          FROM member_insights mi
          JOIN member_insight_types mit ON mi.insight_type_id = mit.id
          WHERE mi.slack_user_id = ANY($1)
            AND mi.is_current = true
          ORDER BY mi.created_at DESC
        `,
          [slackUserIds]
        );

        const insights = insightsResult.rows.map((row) => ({
          slack_user_id: row.slack_user_id,
          member_name: slackUserMap.get(row.slack_user_id) || row.slack_user_id,
          insight_type: row.insight_type,
          value: row.value,
          confidence: row.confidence,
          source_type: row.source_type,
          created_at: row.created_at,
        }));

        res.json({ insights });
      } catch (error) {
        logger.error({ err: error }, "Error fetching member insights");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch member insights",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/enrich - Refresh enrichment data for an org
  apiRouter.post(
    "/organizations/:orgId/enrich",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const pool = getPool();

        // Check if enrichment was done recently (within last hour) to prevent abuse
        const recentCheck = await pool.query(
          `SELECT enrichment_at FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );
        if (recentCheck.rows[0]?.enrichment_at) {
          const lastEnrichment = new Date(recentCheck.rows[0].enrichment_at);
          const hourAgo = new Date(Date.now() - 3600000);
          if (lastEnrichment > hourAgo) {
            return res.status(429).json({
              error: "Too soon",
              message:
                "Enrichment was refreshed recently. Please wait an hour.",
            });
          }
        }

        // Get primary domain for this org
        const domainResult = await pool.query(
          `SELECT domain FROM organization_domains
           WHERE workos_organization_id = $1 AND is_primary = true
           LIMIT 1`,
          [orgId]
        );

        if (domainResult.rows.length === 0) {
          // Try to get any domain
          const anyDomainResult = await pool.query(
            `SELECT domain FROM organization_domains
             WHERE workos_organization_id = $1
             LIMIT 1`,
            [orgId]
          );

          if (anyDomainResult.rows.length === 0) {
            return res.status(400).json({
              error: "No domain found",
              message:
                "Add a domain to this organization before enriching",
            });
          }
        }

        const domain =
          domainResult.rows[0]?.domain ||
          (
            await pool.query(
              `SELECT domain FROM organization_domains WHERE workos_organization_id = $1 LIMIT 1`,
              [orgId]
            )
          ).rows[0]?.domain;

        if (!domain) {
          return res.status(400).json({
            error: "No domain found",
            message: "Add a domain to this organization before enriching",
          });
        }

        // Import and call the enrichment function
        const { enrichOrganization } = await import(
          "../../services/enrichment"
        );
        const result = await enrichOrganization(orgId, domain);

        if (!result.success) {
          return res.status(500).json({
            error: "Enrichment failed",
            message: result.error || "Unable to enrich organization",
          });
        }

        logger.info(
          { orgId, domain, adminEmail: req.user!.email },
          "Admin refreshed enrichment data"
        );

        res.json({
          success: true,
          message: "Enrichment data refreshed",
        });
      } catch (error) {
        logger.error({ err: error }, "Error enriching organization");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to enrich organization",
        });
      }
    }
  );

  // POST /api/admin/organizations/:orgId/add-users - Add users to an organization
  // Used by Domain Health to move users from personal workspaces to company orgs
  apiRouter.post(
    "/organizations/:orgId/add-users",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const { user_ids } = req.body;

        if (!Array.isArray(user_ids) || user_ids.length === 0) {
          return res.status(400).json({
            error: "Invalid request",
            message: "user_ids must be a non-empty array",
          });
        }

        if (user_ids.length > 100) {
          return res.status(400).json({
            error: "Too many users",
            message: "Cannot add more than 100 users at once",
          });
        }

        const pool = getPool();

        // Verify the target org exists and is not a personal workspace
        const orgCheck = await pool.query(
          `SELECT workos_organization_id, name, is_personal FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        );

        if (orgCheck.rows.length === 0) {
          return res.status(404).json({
            error: "Organization not found",
          });
        }

        if (orgCheck.rows[0].is_personal) {
          return res.status(400).json({
            error: "Invalid target",
            message: "Cannot add users to a personal workspace",
          });
        }

        const orgName = orgCheck.rows[0].name;

        // Process each user
        let addedCount = 0;
        const errors: string[] = [];

        for (const userId of user_ids) {
          try {
            // Validate user ID format
            if (typeof userId !== "string" || !/^[\w-]+$/.test(userId)) {
              errors.push(`Invalid user ID format`);
              continue;
            }

            // Check if user exists
            const userCheck = await pool.query(
              `SELECT workos_user_id, email, first_name, last_name, workos_organization_id
               FROM organization_memberships
               WHERE workos_user_id = $1`,
              [userId]
            );

            if (userCheck.rows.length === 0) {
              errors.push(`User ${userId} not found`);
              continue;
            }

            const user = userCheck.rows[0];

            // Check if user is already in this org
            const existingMembership = await pool.query(
              `SELECT id FROM organization_memberships
               WHERE workos_user_id = $1 AND workos_organization_id = $2`,
              [userId, orgId]
            );

            if (existingMembership.rows.length > 0) {
              // User already in target org, skip
              addedCount++;
              continue;
            }

            // Add membership to the new org
            await pool.query(
              `INSERT INTO organization_memberships
               (workos_user_id, workos_organization_id, email, first_name, last_name)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (workos_user_id, workos_organization_id)
               DO UPDATE SET email = EXCLUDED.email, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
              [userId, orgId, user.email, user.first_name, user.last_name]
            );

            addedCount++;

            logger.info(
              {
                userId,
                userEmail: user.email,
                targetOrgId: orgId,
                targetOrgName: orgName,
                previousOrgId: user.workos_organization_id,
                adminEmail: req.user!.email,
              },
              "Admin added user to organization"
            );
          } catch (err) {
            logger.error({ err, userId }, "Error adding user to org");
            errors.push(`Failed to add user ${userId}`);
          }
        }

        res.json({
          success: true,
          added_count: addedCount,
          total_requested: user_ids.length,
          errors: errors.length > 0 ? errors : undefined,
        });
      } catch (error) {
        logger.error({ err: error }, "Error adding users to organization");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to add users to organization",
        });
      }
    }
  );

  // POST /api/admin/organizations/audit-admins - Find and fix orgs without admins
  // Query params:
  //   fix=true - Auto-promote single-member orgs (multi-member orgs need manual review)
  apiRouter.post(
    "/organizations/audit-admins",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const fix = req.query.fix === "true";
        const pool = getPool();

        if (!workos) {
          return res.status(500).json({
            error: "WorkOS not configured",
          });
        }

        // Get all non-personal orgs with members
        const orgsResult = await pool.query<{
          workos_organization_id: string;
          name: string;
        }>(
          `SELECT DISTINCT o.workos_organization_id, o.name
           FROM organizations o
           JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
           WHERE o.is_personal = false
             AND o.workos_organization_id IS NOT NULL
           ORDER BY o.name ASC`
        );

        const orgsWithoutAdmin: Array<{
          orgId: string;
          orgName: string;
          memberCount: number;
          members: Array<{ userId: string; membershipId: string; email: string }>;
          fixed: boolean;
        }> = [];

        for (const org of orgsResult.rows) {
          try {
            // Note: Using limit=100 to check first page only. Orgs with 100+ members
            // where admin is on a later page may show false positives. Acceptable for
            // this admin audit tool since most orgs have few members.
            const memberships =
              await workos.userManagement.listOrganizationMemberships({
                organizationId: org.workos_organization_id,
                limit: 100,
              });

            if (memberships.data.length === 0) continue;

            // Check for admin or owner
            const hasAdmin = memberships.data.some((m) => {
              const role = m.role?.slug;
              return role === "admin" || role === "owner";
            });

            if (!hasAdmin) {
              // Fetch user details for all members
              const members: Array<{
                userId: string;
                membershipId: string;
                email: string;
              }> = [];

              for (const membership of memberships.data) {
                try {
                  const user = await workos.userManagement.getUser(
                    membership.userId
                  );
                  members.push({
                    userId: membership.userId,
                    membershipId: membership.id,
                    email: user.email,
                  });
                } catch {
                  members.push({
                    userId: membership.userId,
                    membershipId: membership.id,
                    email: "unknown",
                  });
                }
              }

              let fixed = false;

              // Only auto-fix single-member orgs
              if (fix && members.length === 1) {
                const member = members[0];
                try {
                  await workos.userManagement.updateOrganizationMembership(
                    member.membershipId,
                    { roleSlug: "admin" }
                  );

                  // Update local cache
                  await pool.query(
                    `UPDATE organization_memberships
                     SET role = 'admin', updated_at = NOW()
                     WHERE workos_organization_id = $1 AND workos_user_id = $2`,
                    [org.workos_organization_id, member.userId]
                  );

                  fixed = true;

                  logger.info(
                    {
                      orgId: org.workos_organization_id,
                      orgName: org.name,
                      userId: member.userId,
                      adminEmail: req.user!.email,
                    },
                    "Admin audit: promoted single-member org user to admin"
                  );
                } catch (err) {
                  logger.error(
                    { err, orgId: org.workos_organization_id },
                    "Admin audit: failed to promote user"
                  );
                }
              }

              orgsWithoutAdmin.push({
                orgId: org.workos_organization_id,
                orgName: org.name,
                memberCount: members.length,
                members,
                fixed,
              });
            }
          } catch (err) {
            logger.warn(
              { err, orgId: org.workos_organization_id },
              "Admin audit: failed to check org"
            );
          }
        }

        const singleMemberOrgs = orgsWithoutAdmin.filter(
          (o) => o.memberCount === 1
        );
        const multiMemberOrgs = orgsWithoutAdmin.filter(
          (o) => o.memberCount > 1
        );

        res.json({
          total_orgs: orgsResult.rows.length,
          orgs_without_admin: orgsWithoutAdmin.length,
          fix_mode: fix,
          auto_fixed: singleMemberOrgs.filter((o) => o.fixed).length,
          single_member_orgs: singleMemberOrgs.length,
          needs_review: multiMemberOrgs.length,
          details: orgsWithoutAdmin.map((o) => ({
            org_id: o.orgId,
            org_name: o.orgName,
            has_admin: false,
            member_count: o.memberCount,
            members: o.members.map((m) => ({ email: m.email, user_id: m.userId })),
            promoted_user: o.fixed ? o.members[0]?.email : null,
            needs_manual_review: o.memberCount > 1,
          })),
        });
      } catch (error) {
        logger.error({ err: error }, "Error running admin audit");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to run admin audit",
        });
      }
    }
  );
}
