/**
 * Unified Account Management Routes
 *
 * Replaces separate prospect and organization detail endpoints with a unified
 * account view that works for both members and non-members.
 *
 * Key simplifications:
 * - member_status derived from subscription (not a separate field)
 * - Uses engagement_score only (removes engagement_level computation)
 * - No prospect_status pipeline stages (uses interest_level + activity log)
 */

import { Router } from "express";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { serveHtmlWithConfig } from "../../utils/html-config.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { getPendingInvoices } from "../../billing/stripe-client.js";

const orgDb = new OrganizationDatabase();
const logger = createLogger("admin-accounts");

/**
 * Derive member status from subscription fields
 */
function deriveMemberStatus(org: {
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
}): "member" | "trial" | "lapsed" | "prospect" {
  if (!org.subscription_status) {
    return "prospect";
  }

  if (org.subscription_status === "active") {
    return "member";
  }

  if (org.subscription_status === "trialing") {
    return "trial";
  }

  // canceled, past_due, unpaid, etc. - check if they ever had an active subscription
  if (org.subscription_canceled_at) {
    return "lapsed";
  }

  return "prospect";
}

/**
 * Map engagement score (0-100) to fire count (0-4)
 */
function scoreToFires(score: number): number {
  if (score >= 76) return 4;
  if (score >= 56) return 3;
  if (score >= 36) return 2;
  if (score >= 16) return 1;
  return 0;
}

export function setupAccountRoutes(
  pageRouter: Router,
  apiRouter: Router
): void {

  // Page route for unified account list
  pageRouter.get(
    "/accounts",
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, "admin-accounts.html").catch((err) => {
        logger.error({ err }, "Error serving admin accounts page");
        res.status(500).send("Internal server error");
      });
    }
  );

  // Page route for domain discovery tool
  pageRouter.get(
    "/tools/domain-discovery",
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, "admin-domain-discovery.html").catch((err) => {
        logger.error({ err }, "Error serving domain discovery page");
        res.status(500).send("Internal server error");
      });
    }
  );

  // Page route for data cleanup tool
  pageRouter.get(
    "/tools/data-cleanup",
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, "admin-data-cleanup.html").catch((err) => {
        logger.error({ err }, "Error serving data cleanup page");
        res.status(500).send("Internal server error");
      });
    }
  );

  // Page route for unified account detail
  pageRouter.get(
    "/accounts/:orgId",
    requireAuth,
    requireAdmin,
    (req, res) => {
      serveHtmlWithConfig(req, res, "admin-account-detail.html").catch((err) => {
        logger.error({ err }, "Error serving admin account detail page");
        res.status(500).send("Internal server error");
      });
    }
  );

  // Redirect old URL to new
  pageRouter.get(
    "/organizations/:orgId",
    requireAuth,
    requireAdmin,
    (req, res) => {
      res.redirect(301, `/admin/accounts/${req.params.orgId}`);
    }
  );

  // GET /api/admin/accounts/:orgId - Unified account detail
  apiRouter.get(
    "/accounts/:orgId",
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
          return res.status(404).json({ error: "Account not found" });
        }

        const org = orgResult.rows[0];

        // Derive member status from subscription
        const memberStatus = deriveMemberStatus(org);
        const isDisqualified = org.prospect_status === "disqualified";

        // Run parallel queries for related data (including members from local cache)
        const [
          workingGroupResult,
          activitiesResult,
          nextStepsResult,
          stakeholdersResult,
          domainsResult,
          membersResult,
        ] = await Promise.all([
          // Working groups
          pool.query(
            `
            SELECT DISTINCT wg.id, wg.name, wg.slug, wgm.status, wgm.joined_at
            FROM working_group_memberships wgm
            JOIN working_groups wg ON wgm.working_group_id = wg.id
            WHERE wgm.workos_organization_id = $1 AND wgm.status = 'active'
          `,
            [orgId]
          ),

          // Activities (combined org + email activities)
          pool.query(
            `
            SELECT * FROM (
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
          ),

          // Pending next steps
          pool.query(
            `
            SELECT *
            FROM org_activities
            WHERE organization_id = $1
              AND is_next_step = TRUE
              AND next_step_completed_at IS NULL
            ORDER BY next_step_due_date ASC NULLS LAST
          `,
            [orgId]
          ),

          // Stakeholders
          pool.query(
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
          ),

          // Domains
          pool.query(
            `
            SELECT domain, is_primary, verified, source, created_at
            FROM organization_domains
            WHERE workos_organization_id = $1
            ORDER BY is_primary DESC, domain ASC
          `,
            [orgId]
          ),

          // Members (from local cache instead of WorkOS API)
          pool.query(
            `
            SELECT
              workos_user_id as id,
              email,
              first_name,
              last_name
            FROM organization_memberships
            WHERE workos_organization_id = $1
            ORDER BY created_at ASC
          `,
            [orgId]
          ),
        ]);

        // Get engagement signals
        const engagementSignals = await orgDb.getEngagementSignals(orgId);

        // Use stored engagement_score, compute fires from it
        const engagementScore = org.engagement_score || 0;
        const engagementFires = scoreToFires(engagementScore);

        // Fetch pending invoices - try Stripe first, fall back to local DB
        let pendingInvoices: Awaited<ReturnType<typeof getPendingInvoices>> = [];
        if (org.stripe_customer_id) {
          try {
            pendingInvoices = await getPendingInvoices(org.stripe_customer_id);
          } catch (err) {
            logger.warn(
              { err, orgId, stripeCustomerId: org.stripe_customer_id },
              "Error fetching pending invoices from Stripe"
            );
          }
        }
        // If no Stripe invoices, check local database
        if (pendingInvoices.length === 0) {
          const localInvoices = await pool.query(
            `SELECT stripe_invoice_id as id, status, amount_due, currency, due_date, hosted_invoice_url
             FROM org_invoices
             WHERE workos_organization_id = $1
               AND status IN ('draft', 'open')
             ORDER BY created_at DESC`,
            [orgId]
          );
          pendingInvoices = localInvoices.rows.map((inv) => ({
            id: inv.id,
            status: inv.status as "draft" | "open",
            amount_due: inv.amount_due,
            currency: inv.currency,
            created: inv.created_at || new Date(),
            due_date: inv.due_date,
            hosted_invoice_url: inv.hosted_invoice_url,
            product_name: null,
            customer_email: null,
          }));
        }

        // Find owner from stakeholders
        const owner = stakeholdersResult.rows.find((s) => s.role === "owner");

        // Build response - clean, unified structure
        res.json({
          // Identity
          id: org.workos_organization_id,
          name: org.name,
          company_type: org.company_type,
          company_types: org.company_types,
          is_personal: org.is_personal,

          // Status (derived, not stored)
          member_status: memberStatus,
          is_disqualified: isDisqualified,
          disqualification_reason: org.disqualification_reason,

          // Engagement (score only, no level)
          engagement_score: engagementScore,
          engagement_fires: engagementFires,
          engagement_signals: engagementSignals,

          // Interest (manual input)
          interest_level: org.interest_level,
          interest_level_note: org.interest_level_note,
          interest_level_set_by: org.interest_level_set_by,
          interest_level_set_at: org.interest_level_set_at,

          // Invoice status
          has_pending_invoice: pendingInvoices.length > 0,
          pending_invoices: pendingInvoices,
          invoice_requested_at: org.invoice_requested_at,

          // Contact
          contact_name: org.prospect_contact_name,
          contact_email: org.prospect_contact_email,
          contact_title: org.prospect_contact_title,

          // Enrichment
          enrichment: org.enrichment_data
            ? {
                industry: org.enrichment_industry,
                sub_industry: org.enrichment_sub_industry,
                revenue: org.enrichment_revenue,
                revenue_range: org.enrichment_revenue_range,
                employee_count: org.enrichment_employee_count,
                employee_count_range: org.enrichment_employee_count_range,
                founded_year: org.enrichment_founded_year,
                city: org.enrichment_city,
                country: org.enrichment_country,
                linkedin_url: org.enrichment_linkedin_url,
                description: org.enrichment_description,
                source: org.enrichment_source,
                enriched_at: org.enrichment_at,
              }
            : null,

          // Subscription details (for members)
          subscription: org.subscription_status
            ? {
                status: org.subscription_status,
                product_name: org.subscription_product_name,
                current_period_end: org.subscription_current_period_end,
                canceled_at: org.subscription_canceled_at,
              }
            : null,

          // Pricing & discount
          revenue_tier: org.revenue_tier,
          discount: org.discount_percent || org.discount_amount_cents
            ? {
                percent: org.discount_percent,
                amount_cents: org.discount_amount_cents,
                reason: org.discount_reason,
                granted_by: org.discount_granted_by,
                granted_at: org.discount_granted_at,
                promo_code: org.stripe_promotion_code,
              }
            : null,

          // Relationships
          members: membersResult.rows.map((m) => ({
            id: m.id,
            email: m.email,
            firstName: m.first_name,
            lastName: m.last_name,
            role: "member", // Role not cached locally
          })),
          member_count: membersResult.rows.length,
          working_groups: workingGroupResult.rows,
          stakeholders: stakeholdersResult.rows,
          domains: domainsResult.rows,
          owner: owner
            ? {
                user_id: owner.user_id,
                user_name: owner.user_name,
                user_email: owner.user_email,
              }
            : null,

          // Hierarchy
          parent_organization_id: org.parent_organization_id,
          parent_name: org.parent_name,
          subsidiary_count: parseInt(org.subsidiary_count) || 0,

          // Activity
          activities: activitiesResult.rows,
          next_steps: nextStepsResult.rows,

          // Metadata
          source: org.prospect_source,
          created_at: org.created_at,
          updated_at: org.updated_at,
          last_activity_at: org.last_activity_at,

          // Legacy fields (for backward compatibility during transition)
          // These can be removed once UI is fully migrated
          workos_organization_id: org.workos_organization_id,
          prospect_status: org.prospect_status,
          email_domain: org.email_domain,
          stripe_customer_id: org.stripe_customer_id,
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching account details");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch account details",
        });
      }
    }
  );

  // GET /api/admin/accounts - List all accounts with action-based views
  apiRouter.get("/accounts", requireAuth, requireAdmin, async (req, res) => {
    try {
      const pool = getPool();
      const { view, owner, search, limit: limitParam, offset: offsetParam } = req.query;
      const currentUserId = req.user?.id;

      // Pagination with sensible defaults and limits
      const limit = Math.min(Math.max(parseInt(limitParam as string) || 100, 1), 500);
      const offset = Math.max(parseInt(offsetParam as string) || 0, 0);

      // Base SELECT fields
      const selectFields = `
        SELECT
          o.workos_organization_id,
          o.name,
          o.company_type,
          o.company_types,
          o.is_personal,
          o.subscription_status,
          o.subscription_product_name,
          o.subscription_current_period_end,
          o.subscription_canceled_at,
          o.engagement_score,
          o.interest_level,
          o.interest_level_set_by,
          o.invoice_requested_at,
          o.last_activity_at,
          o.created_at,
          o.email_domain,
          o.prospect_status,
          o.disqualification_reason,
          o.prospect_source,
          o.prospect_contact_name,
          o.prospect_contact_email
      `;

      const params: (string | Date | null)[] = [];
      let query = "";
      let orderBy = "";

      // Action-based views
      const viewName = (view as string) || "needs_attention";

      switch (viewName) {
        case "needs_attention":
          // All accounts needing action: overdue next steps, open invoices, high engagement unowned
          query = `
            ${selectFields},
            na.next_step_due_date as next_step_due,
            na.description as next_step_description,
            CASE
              WHEN na.next_step_due_date < CURRENT_DATE THEN 'overdue'
              WHEN na.next_step_due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'due_soon'
              WHEN oi.stripe_invoice_id IS NOT NULL THEN 'open_invoice'
              WHEN COALESCE(o.engagement_score, 0) >= 50 AND NOT EXISTS (
                SELECT 1 FROM org_stakeholders os WHERE os.organization_id = o.workos_organization_id
              ) THEN 'high_engagement_unowned'
              ELSE 'needs_review'
            END as attention_reason
            FROM organizations o
            LEFT JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
            LEFT JOIN org_invoices oi ON oi.workos_organization_id = o.workos_organization_id
              AND oi.status IN ('draft', 'open')
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (
                na.id IS NOT NULL
                OR oi.stripe_invoice_id IS NOT NULL
                OR (
                  COALESCE(o.engagement_score, 0) >= 50
                  AND NOT EXISTS (
                    SELECT 1 FROM org_stakeholders os WHERE os.organization_id = o.workos_organization_id
                  )
                )
              )
          `;
          orderBy = ` ORDER BY
            CASE
              WHEN na.next_step_due_date < CURRENT_DATE THEN 1
              WHEN oi.stripe_invoice_id IS NOT NULL THEN 2
              WHEN na.next_step_due_date IS NOT NULL THEN 3
              ELSE 4
            END,
            na.next_step_due_date ASC NULLS LAST,
            o.engagement_score DESC NULLS LAST`;
          break;

        case "needs_followup":
          // Accounts with pending next steps due in 7 days
          query = `
            ${selectFields},
            na.next_step_due_date as next_step_due,
            na.description as next_step_description
            FROM organizations o
            INNER JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY na.next_step_due_date ASC NULLS FIRST`;
          break;

        case "open_invoices":
          // Accounts with pending invoices
          query = `
            ${selectFields},
            oi.amount_due as invoice_amount,
            oi.status as invoice_status,
            oi.due_date as invoice_due_date
            FROM organizations o
            INNER JOIN org_invoices oi ON oi.workos_organization_id = o.workos_organization_id
              AND oi.status IN ('draft', 'open')
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY oi.due_date ASC NULLS LAST`;
          break;

        case "hot":
          // High engagement non-members
          query = `
            ${selectFields}
            FROM organizations o
            WHERE (
              o.subscription_status IS NULL
              OR o.subscription_status NOT IN ('active', 'trialing')
            )
            AND COALESCE(o.engagement_score, 0) >= 50
            AND o.interest_level IN ('high', 'very_high')
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY o.engagement_score DESC NULLS LAST`;
          break;

        case "going_cold":
          // Accounts with no activity in 30 days (but had some activity before)
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.last_activity_at IS NOT NULL
              AND o.last_activity_at < NOW() - INTERVAL '30 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (
                o.subscription_status IS NULL
                OR o.subscription_status NOT IN ('active', 'trialing')
              )
          `;
          orderBy = ` ORDER BY o.last_activity_at DESC`;
          break;

        case "unowned":
          // Accounts with some engagement but no stakeholder assigned
          query = `
            ${selectFields}
            FROM organizations o
            WHERE NOT EXISTS (
              SELECT 1 FROM org_stakeholders os
              WHERE os.organization_id = o.workos_organization_id
            )
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
            AND (
              COALESCE(o.engagement_score, 0) > 0
              OR o.last_activity_at IS NOT NULL
            )
          `;
          orderBy = ` ORDER BY o.engagement_score DESC NULLS LAST, o.last_activity_at DESC NULLS LAST`;
          break;

        case "active_prospects":
          // Non-members with recent activity, sorted by engagement
          query = `
            ${selectFields}
            FROM organizations o
            WHERE (
              o.subscription_status IS NULL
              OR o.subscription_status NOT IN ('active', 'trialing')
            )
            AND o.last_activity_at >= NOW() - INTERVAL '30 days'
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY o.engagement_score DESC NULLS LAST, o.last_activity_at DESC`;
          break;

        case "recently_contacted":
          // Accounts with recent outreach activity (notes, emails logged)
          // Use LATERAL join to get only the most recent activity per org
          query = `
            ${selectFields},
            recent_activity.activity_date as last_contact_date,
            recent_activity.activity_type as last_contact_type,
            recent_activity.description as last_contact_description
            FROM organizations o
            INNER JOIN LATERAL (
              SELECT activity_date, activity_type, description
              FROM org_activities
              WHERE organization_id = o.workos_organization_id
                AND activity_type IN ('note', 'email_sent', 'call', 'meeting')
                AND activity_date >= NOW() - INTERVAL '14 days'
              ORDER BY activity_date DESC
              LIMIT 1
            ) recent_activity ON true
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY recent_activity.activity_date DESC`;
          break;

        case "renewals":
          // Members with subscriptions ending soon
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND o.subscription_current_period_end IS NOT NULL
              AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
              AND o.subscription_current_period_end > NOW()
          `;
          orderBy = ` ORDER BY o.subscription_current_period_end ASC`;
          break;

        case "low_engagement":
          // Members with low engagement
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND COALESCE(o.engagement_score, 0) < 30
          `;
          orderBy = ` ORDER BY o.engagement_score ASC NULLS FIRST`;
          break;

        case "my_accounts":
          // Accounts where current user is stakeholder
          if (!currentUserId) {
            return res.json([]);
          }
          query = `
            ${selectFields},
            os.role as stakeholder_role
            FROM organizations o
            INNER JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
              AND os.user_id = $1
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          params.push(currentUserId);
          orderBy = ` ORDER BY o.last_activity_at DESC NULLS LAST`;
          break;

        case "new":
          // Recently created accounts
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.created_at >= NOW() - INTERVAL '14 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY o.created_at DESC`;
          break;

        case "disqualified":
          // Explicitly disqualified accounts
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.prospect_status = 'disqualified'
          `;
          orderBy = ` ORDER BY o.updated_at DESC`;
          break;

        default:
          // All accounts (except disqualified)
          query = `
            ${selectFields}
            FROM organizations o
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY o.updated_at DESC`;
      }

      // Apply additional filters
      if (owner && typeof owner === "string") {
        params.push(owner);
        query += ` AND EXISTS (
          SELECT 1 FROM org_stakeholders os
          WHERE os.organization_id = o.workos_organization_id
            AND os.user_id = $${params.length}
            AND os.role = 'owner'
        )`;
      }

      if (search && typeof search === "string" && search.trim()) {
        // Escape LIKE metacharacters to prevent wildcard injection
        const escapedSearch = search.trim().replace(/[%_\\]/g, "\\$&");
        const searchPattern = `%${escapedSearch}%`;
        params.push(searchPattern);
        query += ` AND (o.name ILIKE $${params.length} ESCAPE '\\' OR o.email_domain ILIKE $${params.length} ESCAPE '\\')`;
      }

      query += orderBy;
      query += ` LIMIT ${limit} OFFSET ${offset}`;

      const result = await pool.query(query, params);

      // Early return if no results
      if (result.rows.length === 0) {
        return res.json([]);
      }

      const orgIds = result.rows.map((r) => r.workos_organization_id);

      // Fetch related data in parallel
      const [stakeholdersResult, domainsResult, slackUserCounts, memberCounts] =
        await Promise.all([
          pool.query(
            `
            SELECT organization_id, user_id, user_name, user_email, role
            FROM org_stakeholders
            WHERE organization_id = ANY($1)
            ORDER BY organization_id,
              CASE role WHEN 'owner' THEN 1 WHEN 'interested' THEN 2 WHEN 'connected' THEN 3 END
          `,
            [orgIds]
          ),

          pool.query(
            `
            SELECT workos_organization_id, domain, is_primary
            FROM organization_domains
            WHERE workos_organization_id = ANY($1)
            ORDER BY workos_organization_id, is_primary DESC
          `,
            [orgIds]
          ),

          pool.query(
            `
            SELECT om.workos_organization_id, COUNT(DISTINCT sm.slack_user_id) as count
            FROM slack_user_mappings sm
            JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
            WHERE om.workos_organization_id = ANY($1)
              AND sm.mapping_status = 'mapped'
            GROUP BY om.workos_organization_id
          `,
            [orgIds]
          ),

          pool.query(
            `
            SELECT workos_organization_id, COUNT(*) as count
            FROM organization_memberships
            WHERE workos_organization_id = ANY($1)
            GROUP BY workos_organization_id
          `,
            [orgIds]
          ),
        ]);

      // Build maps
      const stakeholdersMap = new Map<string, any[]>();
      for (const row of stakeholdersResult.rows) {
        if (!stakeholdersMap.has(row.organization_id)) {
          stakeholdersMap.set(row.organization_id, []);
        }
        stakeholdersMap.get(row.organization_id)!.push(row);
      }

      const domainsMap = new Map<string, any[]>();
      for (const row of domainsResult.rows) {
        if (!domainsMap.has(row.workos_organization_id)) {
          domainsMap.set(row.workos_organization_id, []);
        }
        domainsMap.get(row.workos_organization_id)!.push(row);
      }

      const slackCountMap = new Map(
        slackUserCounts.rows.map((r) => [
          r.workos_organization_id,
          parseInt(r.count),
        ])
      );

      const memberCountMap = new Map(
        memberCounts.rows.map((r) => [
          r.workos_organization_id,
          parseInt(r.count),
        ])
      );

      // Transform results
      const accounts = result.rows.map((row) => {
        const memberStatus = deriveMemberStatus(row);
        const engagementScore = row.engagement_score || 0;
        const stakeholders =
          stakeholdersMap.get(row.workos_organization_id) || [];
        const owner = stakeholders.find((s) => s.role === "owner");

        return {
          id: row.workos_organization_id,
          name: row.name,
          company_type: row.company_type,

          // Status
          member_status: memberStatus,
          is_disqualified: row.prospect_status === "disqualified",

          // Engagement
          engagement_score: engagementScore,
          engagement_fires: scoreToFires(engagementScore),
          interest_level: row.interest_level,

          // Counts
          slack_user_count: slackCountMap.get(row.workos_organization_id) || 0,
          member_count: memberCountMap.get(row.workos_organization_id) || 0,

          // Domains
          domain:
            domainsMap.get(row.workos_organization_id)?.[0]?.domain ||
            row.email_domain,
          domains: domainsMap.get(row.workos_organization_id) || [],

          // Owner
          owner: owner
            ? {
                user_id: owner.user_id,
                user_name: owner.user_name,
              }
            : null,
          stakeholders,

          // Contact
          contact_name: row.prospect_contact_name,
          contact_email: row.prospect_contact_email,

          // Dates
          last_activity_at: row.last_activity_at,
          created_at: row.created_at,
          invoice_requested_at: row.invoice_requested_at,

          // Source
          source: row.prospect_source,

          // View-specific fields
          next_step_due: row.next_step_due,
          next_step_description: row.next_step_description,
          attention_reason: row.attention_reason,
          invoice_amount: row.invoice_amount,
          invoice_status: row.invoice_status,
          stakeholder_role: row.stakeholder_role,

          // Legacy (for transition)
          workos_organization_id: row.workos_organization_id,
        };
      });

      res.json(accounts);
    } catch (error) {
      logger.error({ err: error }, "Error fetching accounts");
      res.status(500).json({
        error: "Internal server error",
        message: "Unable to fetch accounts",
      });
    }
  });

  // GET /api/admin/accounts/view-counts - Get counts for each view tab
  apiRouter.get(
    "/accounts/view-counts",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const currentUserId = req.user?.id;

        const [
          needsFollowup,
          openInvoices,
          hot,
          goingCold,
          renewals,
          lowEngagement,
          myAccounts,
          newAccounts,
          disqualified,
          needsAttention,
          unowned,
          activeProspects,
          recentlyContacted,
        ] = await Promise.all([
          // Needs followup
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),

          // Open invoices
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_invoices oi ON oi.workos_organization_id = o.workos_organization_id
              AND oi.status IN ('draft', 'open')
          `),

          // Hot prospects
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE (o.subscription_status IS NULL OR o.subscription_status NOT IN ('active', 'trialing'))
              AND COALESCE(o.engagement_score, 0) >= 50
              AND o.interest_level IN ('high', 'very_high')
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),

          // Going cold - must have had activity before (matches view query)
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.last_activity_at IS NOT NULL
              AND o.last_activity_at < NOW() - INTERVAL '30 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (o.subscription_status IS NULL OR o.subscription_status NOT IN ('active', 'trialing'))
          `),

          // Renewals
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND o.subscription_current_period_end IS NOT NULL
              AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
              AND o.subscription_current_period_end > NOW()
          `),

          // Low engagement members
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.subscription_status = 'active'
              AND COALESCE(o.engagement_score, 0) < 30
          `),

          // My accounts
          currentUserId
            ? pool.query(
                `
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id AND os.user_id = $1
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `,
                [currentUserId]
              )
            : Promise.resolve({ rows: [{ count: 0 }] }),

          // New accounts
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.created_at >= NOW() - INTERVAL '14 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),

          // Disqualified
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.prospect_status = 'disqualified'
          `),

          // Needs attention - all accounts needing action (not just owned)
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            LEFT JOIN org_activities na ON na.organization_id = o.workos_organization_id
              AND na.is_next_step = TRUE
              AND na.next_step_completed_at IS NULL
              AND (na.next_step_due_date IS NULL OR na.next_step_due_date <= NOW() + INTERVAL '7 days')
            LEFT JOIN org_invoices oi ON oi.workos_organization_id = o.workos_organization_id
              AND oi.status IN ('draft', 'open')
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (
                na.id IS NOT NULL
                OR oi.stripe_invoice_id IS NOT NULL
                OR (
                  COALESCE(o.engagement_score, 0) >= 50
                  AND NOT EXISTS (
                    SELECT 1 FROM org_stakeholders os WHERE os.organization_id = o.workos_organization_id
                  )
                )
              )
          `),

          // Unowned - accounts with engagement but no stakeholder
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE NOT EXISTS (
              SELECT 1 FROM org_stakeholders os
              WHERE os.organization_id = o.workos_organization_id
            )
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
            AND (
              COALESCE(o.engagement_score, 0) > 0
              OR o.last_activity_at IS NOT NULL
            )
          `),

          // Active prospects - non-members with recent activity
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE (
              o.subscription_status IS NULL
              OR o.subscription_status NOT IN ('active', 'trialing')
            )
            AND o.last_activity_at >= NOW() - INTERVAL '30 days'
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),

          // Recently contacted - accounts with recent outreach
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            INNER JOIN org_activities oa ON oa.organization_id = o.workos_organization_id
              AND oa.activity_type IN ('note', 'email_sent', 'call', 'meeting')
              AND oa.activity_date >= NOW() - INTERVAL '14 days'
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),
        ]);

        res.json({
          needs_attention: parseInt(needsAttention.rows[0].count),
          unowned: parseInt(unowned.rows[0].count),
          active_prospects: parseInt(activeProspects.rows[0].count),
          recently_contacted: parseInt(recentlyContacted.rows[0].count),
          needs_followup: parseInt(needsFollowup.rows[0].count),
          open_invoices: parseInt(openInvoices.rows[0].count),
          hot: parseInt(hot.rows[0].count),
          going_cold: parseInt(goingCold.rows[0].count),
          renewals: parseInt(renewals.rows[0].count),
          low_engagement: parseInt(lowEngagement.rows[0].count),
          my_accounts: parseInt(myAccounts.rows[0].count),
          new: parseInt(newAccounts.rows[0].count),
          disqualified: parseInt(disqualified.rows[0].count),
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
}
