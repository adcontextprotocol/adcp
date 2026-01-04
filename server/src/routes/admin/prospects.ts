/**
 * Prospect management routes
 * Handles prospect listing, creation, updates, and views
 */

import { Router } from "express";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { createProspect } from "../../services/prospect.js";
import { COMPANY_TYPE_VALUES } from "../../config/company-types.js";

const logger = createLogger("admin-prospects");

export function setupProspectRoutes(apiRouter: Router): void {

  // GET /api/admin/prospects - List all prospects with action-based views
  apiRouter.get("/prospects", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const { status, source, view, owner, mine } = req.query;

      // Base SELECT fields
      const selectFields = `
        SELECT
          o.workos_organization_id,
          o.name,
          o.company_type,
          o.company_types,
          o.revenue_tier,
          o.is_personal,
          COALESCE(o.prospect_status, 'prospect') as prospect_status,
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
          o.email_domain,
          o.interest_level,
          o.stripe_customer_id,
          o.disqualification_reason,
          p.name as parent_name,
          (SELECT COUNT(*) FROM organizations WHERE parent_organization_id = o.workos_organization_id) as subsidiary_count,
          o.subscription_status,
          o.subscription_product_name,
          o.subscription_current_period_end,
          o.engagement_score,
          o.engagement_level,
          o.org_scores_computed_at
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
            // Non-paying orgs with high engagement score (30+)
            // Uses the stored engagement_score from compute_org_engagement_score()
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
              AND COALESCE(o.engagement_score, 0) >= 30
            `;
            orderBy = ` ORDER BY o.engagement_score DESC NULLS LAST, o.invoice_requested_at DESC NULLS LAST`;
            break;

          case "new_signups":
            // Orgs created in last 14 days with no activities logged
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.created_at >= NOW() - INTERVAL '14 days'
                AND NOT EXISTS (
                  SELECT 1 FROM org_activities WHERE organization_id = o.workos_organization_id
                )
            `;
            orderBy = ` ORDER BY o.created_at DESC`;
            break;

          case "going_cold":
            // Non-paying orgs with no activity in last 30 days
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
                OR o.subscription_canceled_at IS NOT NULL
              )
              AND (
                o.last_activity_at IS NULL
                OR o.last_activity_at < NOW() - INTERVAL '30 days'
              )
            `;
            orderBy = ` ORDER BY o.last_activity_at ASC NULLS FIRST`;
            break;

          case "renewals":
            // Active members with subscriptions ending in next 60 days
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.subscription_status = 'active'
                AND o.subscription_current_period_end IS NOT NULL
                AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
                AND o.subscription_current_period_end > NOW()
            `;
            orderBy = ` ORDER BY o.subscription_current_period_end ASC`;
            break;

          case "low_engagement":
            // Active members with low engagement - we'll filter in JS
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE o.subscription_status = 'active'
            `;
            orderBy = ` ORDER BY o.last_activity_at ASC NULLS FIRST`;
            break;

          case "my_accounts":
            // Orgs where current user is a stakeholder
            const userId = req.user?.id;
            if (!userId) {
              return res.json([]);
            }
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              INNER JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
                AND os.user_id = $1
            `;
            params.push(userId);
            orderBy = ` ORDER BY o.last_activity_at DESC NULLS LAST`;
            break;

          default:
            // Default: all orgs
            query = `
              ${selectFields}
              FROM organizations o
              LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
              WHERE 1=1
            `;
            orderBy = ` ORDER BY o.updated_at DESC`;
        }
      } else {
        // Default: all organizations
        query = `
          ${selectFields}
          FROM organizations o
          LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
          WHERE 1=1
        `;
        orderBy = ` ORDER BY o.updated_at DESC`;
      }

      // Apply additional filters
      if (status && typeof status === "string") {
        params.push(status);
        query += ` AND COALESCE(o.prospect_status, 'prospect') = $${params.length}`;
      } else {
        // Exclude disqualified orgs by default unless explicitly filtering for them
        query += ` AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'`;
      }

      if (source && typeof source === "string") {
        params.push(source);
        query += ` AND COALESCE(o.prospect_source, 'organic') = $${params.length}`;
      }

      if (owner && typeof owner === "string") {
        params.push(owner);
        query += ` AND o.prospect_owner = $${params.length}`;
      }

      // mine=true filter: only show prospects where current user is owner in org_stakeholders
      if (mine === "true") {
        const currentUserId = req.user?.id;
        if (currentUserId) {
          params.push(currentUserId);
          query += ` AND EXISTS (
            SELECT 1 FROM org_stakeholders os
            WHERE os.organization_id = o.workos_organization_id
              AND os.user_id = $${params.length}
              AND os.role = 'owner'
          )`;
        }
      }

      query += orderBy;

      const result = await pool.query(query, params);

      // Get org IDs for subsequent queries
      const orgIds = result.rows.map((r) => r.workos_organization_id);

      // Early return if no organizations to avoid unnecessary database queries
      if (orgIds.length === 0) {
        return res.json([]);
      }

      // Run all independent queries in parallel for performance
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const [
        wgCountResult,
        recentActivityCounts,
        stakeholdersResult,
        slackUserCounts,
        domainsResult,
        lastActivitiesResult,
        pendingStepsResult,
        memberCountsResult,
        pendingInvoicesResult,
      ] = await Promise.all([
        // Working group counts (filtered to just these orgs)
        pool.query(`
          SELECT workos_organization_id, COUNT(DISTINCT working_group_id) as wg_count
          FROM working_group_memberships
          WHERE workos_organization_id = ANY($1) AND status = 'active'
          GROUP BY workos_organization_id
        `, [orgIds]),

        // Recent activity counts
        pool.query(`
          SELECT organization_id, COUNT(*) as activity_count
          FROM org_activities
          WHERE organization_id = ANY($1) AND activity_date > $2
          GROUP BY organization_id
        `, [orgIds, thirtyDaysAgo]),

        // Stakeholders
        pool.query(`
          SELECT organization_id, user_id, user_name, user_email, role
          FROM org_stakeholders
          WHERE organization_id = ANY($1)
          ORDER BY organization_id,
            CASE role WHEN 'owner' THEN 1 WHEN 'interested' THEN 2 WHEN 'connected' THEN 3 END
        `, [orgIds]),

        // Slack user counts
        pool.query(`
          SELECT om.workos_organization_id, COUNT(DISTINCT sm.slack_user_id) as slack_user_count
          FROM slack_user_mappings sm
          JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
          WHERE om.workos_organization_id = ANY($1)
            AND sm.mapping_status = 'mapped'
          GROUP BY om.workos_organization_id
        `, [orgIds]),

        // Domains
        pool.query(`
          SELECT workos_organization_id, domain, is_primary, verified
          FROM organization_domains
          WHERE workos_organization_id = ANY($1)
          ORDER BY workos_organization_id, is_primary DESC, domain ASC
        `, [orgIds]),

        // Last activity
        pool.query(`
          SELECT DISTINCT ON (organization_id)
            organization_id,
            activity_type,
            activity_date,
            description
          FROM org_activities
          WHERE organization_id = ANY($1)
          ORDER BY organization_id, activity_date DESC
        `, [orgIds]),

        // Pending steps
        pool.query(`
          SELECT organization_id, COUNT(*) as pending_count,
            SUM(CASE WHEN next_step_due_date < CURRENT_DATE THEN 1 ELSE 0 END) as overdue_count
          FROM org_activities
          WHERE organization_id = ANY($1)
            AND is_next_step = TRUE
            AND next_step_completed_at IS NULL
          GROUP BY organization_id
        `, [orgIds]),

        // Member counts
        pool.query(`
          SELECT workos_organization_id, COUNT(*) as member_count
          FROM organization_memberships
          WHERE workos_organization_id = ANY($1)
          GROUP BY workos_organization_id
        `, [orgIds]),

        // Pending invoices from local cache (synced via Stripe webhooks)
        pool.query(`
          SELECT
            workos_organization_id,
            stripe_invoice_id as id,
            status,
            amount_due,
            currency,
            created_at as created,
            due_date,
            hosted_invoice_url,
            product_name,
            customer_email
          FROM org_invoices
          WHERE workos_organization_id = ANY($1)
            AND status IN ('draft', 'open')
          ORDER BY workos_organization_id, created_at DESC
        `, [orgIds]),
      ]);

      // Build maps from query results
      const wgCountMap = new Map(
        wgCountResult.rows.map((r) => [r.workos_organization_id, parseInt(r.wg_count)])
      );

      const activityCountMap = new Map(
        recentActivityCounts.rows.map((r) => [
          r.organization_id,
          parseInt(r.activity_count),
        ])
      );

      const stakeholdersMap = new Map<string, Array<{ user_id: string; user_name: string; user_email: string; role: string }>>();
      for (const row of stakeholdersResult.rows) {
        if (!stakeholdersMap.has(row.organization_id)) {
          stakeholdersMap.set(row.organization_id, []);
        }
        stakeholdersMap.get(row.organization_id)!.push({
          user_id: row.user_id,
          user_name: row.user_name,
          user_email: row.user_email,
          role: row.role,
        });
      }

      const slackUserCountMap = new Map(
        slackUserCounts.rows.map((r) => [r.workos_organization_id, parseInt(r.slack_user_count)])
      );

      const domainsMap = new Map<string, Array<{ domain: string; is_primary: boolean; verified: boolean }>>();
      for (const row of domainsResult.rows) {
        if (!domainsMap.has(row.workos_organization_id)) {
          domainsMap.set(row.workos_organization_id, []);
        }
        domainsMap.get(row.workos_organization_id)!.push({
          domain: row.domain,
          is_primary: row.is_primary,
          verified: row.verified,
        });
      }

      const lastActivityMap = new Map(
        lastActivitiesResult.rows.map((r) => [r.organization_id, {
          type: r.activity_type,
          date: r.activity_date,
          description: r.description,
        }])
      );

      const pendingStepsMap = new Map(
        pendingStepsResult.rows.map((r) => [r.organization_id, {
          pending: parseInt(r.pending_count),
          overdue: parseInt(r.overdue_count),
        }])
      );

      const memberCountMap = new Map(
        memberCountsResult.rows.map((r) => [r.workos_organization_id, parseInt(r.member_count)])
      );

      // Build map: orgId -> array of pending invoices
      const pendingInvoicesMap = new Map<string, Array<{
        id: string;
        status: string;
        amount_due: number;
        currency: string;
        created: Date;
        due_date: Date | null;
        hosted_invoice_url: string | null;
        product_name: string | null;
        customer_email: string | null;
      }>>();
      for (const row of pendingInvoicesResult.rows) {
        if (!pendingInvoicesMap.has(row.workos_organization_id)) {
          pendingInvoicesMap.set(row.workos_organization_id, []);
        }
        pendingInvoicesMap.get(row.workos_organization_id)!.push({
          id: row.id,
          status: row.status,
          amount_due: row.amount_due,
          currency: row.currency,
          created: row.created,
          due_date: row.due_date,
          hosted_invoice_url: row.hosted_invoice_url,
          product_name: row.product_name,
          customer_email: row.customer_email,
        });
      }

      // Enrich with membership count and engagement data
      const prospects = result.rows.map((row) => {
        const memberCount = memberCountMap.get(row.workos_organization_id) || 0;
        const wgCount = wgCountMap.get(row.workos_organization_id) || 0;
        const recentActivityCount = activityCountMap.get(row.workos_organization_id) || 0;
        const pendingInvoices = pendingInvoicesMap.get(row.workos_organization_id) || [];
        const slackUserCount = slackUserCountMap.get(row.workos_organization_id) || 0;

        // Use stored engagement_level directly (matches detail page calculation)
        const engagementScore = row.engagement_score || 0;
        const engagementLevel = row.engagement_level || 1;

        // Build engagement reasons from actual data (additive - all contributing factors)
        const engagementReasons: string[] = [];

        if (pendingInvoices.length > 0) {
          const totalAmount = pendingInvoices.reduce((sum, inv) => sum + inv.amount_due, 0);
          engagementReasons.push(`Open invoice: $${(totalAmount / 100).toLocaleString()}`);
        }
        if (slackUserCount > 0) {
          engagementReasons.push(`${slackUserCount} Slack user(s)`);
        }
        if (memberCount > 0) {
          engagementReasons.push(`${memberCount} team member(s)`);
        }
        if (wgCount > 0) {
          engagementReasons.push(`In ${wgCount} working group(s)`);
        }
        if (recentActivityCount > 0) {
          engagementReasons.push(`${recentActivityCount} recent activity(ies)`);
        }
        if (row.interest_level) {
          // Low interest caps the score at 20 (matching SQL behavior)
          if (row.interest_level === 'low') {
            engagementReasons.push(`Interest: Low (capped)`);
          } else {
            const interestDisplay = row.interest_level.replace('_', ' ');
            engagementReasons.push(`Interest: ${interestDisplay.charAt(0).toUpperCase() + interestDisplay.slice(1)}`);
          }
        }

        // If no reasons found, show base state
        if (engagementReasons.length === 0) {
          engagementReasons.push("New prospect");
        }

        return {
          ...row,
          member_count: memberCount,
          has_members: memberCount > 0,
          working_group_count: wgCount,
          engagement_level: engagementLevel,
          engagement_score: engagementScore,
          engagement_reasons: engagementReasons,
          stakeholders: stakeholdersMap.get(row.workos_organization_id) || [],
          slack_user_count: slackUserCount,
          domains: domainsMap.get(row.workos_organization_id) || [],
          last_activity: lastActivityMap.get(row.workos_organization_id) || null,
          pending_steps: pendingStepsMap.get(row.workos_organization_id) || { pending: 0, overdue: 0 },
          recent_activity_count: recentActivityCount,
          pending_invoices: pendingInvoices,
        };
      });

      // Filter by engagement score for specific views (hot_prospects already filtered in SQL)
      let filteredProspects = prospects;
      if (view === "low_engagement") {
        // Only show low engagement (score < 30)
        filteredProspects = prospects.filter((p) => (p.engagement_score || 0) < 30);
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
        company_type,
        prospect_status,
        prospect_source,
        prospect_notes,
        prospect_contact_name,
        prospect_contact_email,
        prospect_contact_title,
        prospect_next_action,
        prospect_next_action_date,
        prospect_owner,
        parent_organization_id,
      } = req.body;

      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "Company name is required" });
      }

      // Use centralized prospect service
      const result = await createProspect({
        name,
        domain,
        company_type,
        prospect_status,
        prospect_source: prospect_source || "aao_launch_list",
        prospect_notes,
        prospect_contact_name,
        prospect_contact_email,
        prospect_contact_title,
        prospect_next_action,
        prospect_next_action_date,
        prospect_owner,
        parent_organization_id,
      });

      if (!result.success) {
        if (result.alreadyExists) {
          return res.status(409).json({
            error: "Organization already exists",
            message: result.error,
            organization: result.organization,
          });
        }
        return res.status(400).json({
          error: "Failed to create prospect",
          message: result.error,
        });
      }

      res.status(201).json(result.organization);
    } catch (error) {
      logger.error({ err: error }, "Error creating prospect");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to create prospect",
      });
    }
  });

  // PUT /api/admin/prospects/:orgId - Update prospect
  apiRouter.put(
    "/prospects/:orgId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const updates = req.body;
        const pool = getPool();

        // Validate revenue_tier if provided
        const validRevenueTiers = ['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'];
        if (updates.revenue_tier && !validRevenueTiers.includes(updates.revenue_tier)) {
          return res.status(400).json({
            error: "Invalid revenue_tier",
            message: `revenue_tier must be one of: ${validRevenueTiers.join(", ")}`,
          });
        }

        // Build dynamic UPDATE query
        const allowedFields = [
          "name",
          "company_type", // Deprecated: kept for backwards compatibility
          "company_types", // New: array of types
          "revenue_tier",
          "prospect_status",
          "prospect_source",
          "prospect_owner",
          "prospect_notes",
          "prospect_contact_name",
          "prospect_contact_email",
          "prospect_contact_title",
          "prospect_next_action",
          "prospect_next_action_date",
          "parent_organization_id",
          "disqualification_reason",
        ];

        const setClauses: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        for (const field of allowedFields) {
          if (updates[field] !== undefined) {
            if (field === "company_types") {
              // Handle array field - validate and ensure it's stored as a PostgreSQL array
              let typesArray = Array.isArray(updates[field]) ? updates[field] : null;
              // Validate each type value against allowed values
              if (typesArray) {
                typesArray = typesArray.filter((t: string) => COMPANY_TYPE_VALUES.includes(t as any));
                if (typesArray.length === 0) typesArray = null;
              }
              setClauses.push(`${field} = $${paramIndex}`);
              values.push(typesArray);
              paramIndex++;
              // Also update legacy company_type with first value for backwards compatibility
              if (typesArray && typesArray.length > 0) {
                setClauses.push(`company_type = $${paramIndex}`);
                values.push(typesArray[0]);
                paramIndex++;
              }
            } else {
              setClauses.push(`${field} = $${paramIndex}`);
              values.push(updates[field] === "" ? null : updates[field]);
              paramIndex++;
            }
          }
        }

        if (setClauses.length === 0) {
          return res.status(400).json({ error: "No valid fields to update" });
        }

        setClauses.push("updated_at = NOW()");
        values.push(orgId);

        const result = await pool.query(
          `
          UPDATE organizations
          SET ${setClauses.join(", ")}
          WHERE workos_organization_id = $${paramIndex}
          RETURNING *
        `,
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
    async (_req, res) => {
      try {
        const pool = getPool();

        // Count all non-paying orgs by status
        const result = await pool.query(`
        SELECT
          COALESCE(prospect_status, 'prospect') as prospect_status,
          COUNT(*) as count
        FROM organizations
        WHERE (
          subscription_status IS NULL
          OR subscription_status NOT IN ('active', 'trialing')
          OR subscription_canceled_at IS NOT NULL
        )
        GROUP BY COALESCE(prospect_status, 'prospect')
        ORDER BY
          CASE COALESCE(prospect_status, 'prospect')
            WHEN 'prospect' THEN 0
            WHEN 'signed_up' THEN 1
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

  // GET /api/admin/team - Get admin team members for assignment dropdowns
  apiRouter.get("/team", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();

      // Get all members of the aao-admin working group (the actual admins)
      const result = await pool.query(`
        SELECT DISTINCT
          u.workos_user_id as user_id,
          COALESCE(u.first_name || ' ' || u.last_name, u.email) as user_name,
          u.email as user_email
        FROM working_group_memberships wgm
        JOIN working_groups wg ON wg.id = wgm.working_group_id
        JOIN users u ON u.workos_user_id = wgm.workos_user_id
        WHERE wg.slug = 'aao-admin'
          AND wgm.status = 'active'
        ORDER BY user_name ASC
      `);

      // Also include the current user if not already in the list (they should be admin to reach here)
      const currentUserId = req.user?.id;
      const currentUserName =
        req.user?.firstName && req.user?.lastName
          ? `${req.user.firstName} ${req.user.lastName}`.trim()
          : req.user?.email;
      const currentUserEmail = req.user?.email;

      const teamMembers = result.rows;
      const currentUserInList = teamMembers.some(
        (m: { user_id: string }) => m.user_id === currentUserId
      );

      if (!currentUserInList && currentUserId) {
        teamMembers.unshift({
          user_id: currentUserId,
          user_name: currentUserName,
          user_email: currentUserEmail,
        });
      }

      res.json(teamMembers);
    } catch (error) {
      logger.error({ err: error }, "Error fetching admin team");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch admin team",
      });
    }
  });

  // GET /api/admin/organizations - List all organizations (for parent org dropdown)
  apiRouter.get(
    "/organizations",
    requireAuth,
    requireAdmin,
    async (_req, res) => {
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

  // POST /api/admin/prospects/refresh-scores - Refresh engagement scores for all orgs
  apiRouter.post(
    "/prospects/refresh-scores",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const { orgId } = req.body;

        let result;
        if (orgId) {
          // Refresh single org
          await pool.query("SELECT update_org_engagement($1)", [orgId]);
          result = { updated: 1, message: `Refreshed score for ${orgId}` };
        } else {
          // Refresh all stale scores (limit to 200 at a time)
          const updateResult = await pool.query(
            "SELECT update_stale_org_engagement_scores(200)"
          );
          const count = updateResult.rows[0]?.update_stale_org_engagement_scores || 0;
          result = { updated: count, message: `Refreshed ${count} stale scores` };
        }

        logger.info(result, "Engagement scores refreshed");
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, "Error refreshing engagement scores");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to refresh engagement scores",
        });
      }
    }
  );
}
