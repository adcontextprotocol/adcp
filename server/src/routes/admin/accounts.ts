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

import { Router, Request, Response } from "express";
import { getPool } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { serveHtmlWithConfig } from "../../utils/html-config.js";
import { OrganizationDatabase } from "../../db/organization-db.js";
import { getPendingInvoices } from "../../billing/stripe-client.js";
import {
  MEMBER_FILTER_ALIASED,
  NOT_MEMBER_ALIASED,
  type OrgTier,
} from "../../db/org-filters.js";
import { isValidWorkOSMembershipId } from "../../utils/workos-validation.js";

const orgDb = new OrganizationDatabase();
const logger = createLogger("admin-accounts");

/**
 * Derive organization tier from subscription and engagement data
 * Uses the shared tier definitions from org-filters.ts
 *
 * Tiers (mutually exclusive, highest wins):
 * - member: paying subscription (active, not canceled, amount > 0)
 * - engaged: not paying, but has users with engagement
 * - registered: not paying, no engaged users, but has users
 * - prospect: no users at all (pure placeholder)
 *
 * For backward compatibility, if has_users/has_engaged_users are not provided,
 * returns simplified "member" or "prospect" based on subscription only.
 */
function deriveOrgTier(org: {
  subscription_status: string | null;
  subscription_canceled_at?: Date | null;
  has_users?: boolean;
  has_engaged_users?: boolean;
}): OrgTier {
  // Member: active, non-canceled subscription (includes comped members)
  if (org.subscription_status === "active" && !org.subscription_canceled_at) {
    return "member";
  }

  // If we have the engagement data, use full tier logic
  if (org.has_engaged_users !== undefined || org.has_users !== undefined) {
    // Engaged: has users with engagement
    if (org.has_engaged_users) {
      return "engaged";
    }

    // Registered: has users but no engagement
    if (org.has_users) {
      return "registered";
    }

    // Prospect: no users at all
    return "prospect";
  }

  // Backward compatibility: no engagement data, just return prospect for non-members
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

  // GET /api/admin/accounts/view-counts - Get counts for each view tab
  // NOTE: Must be registered BEFORE /accounts/:orgId to avoid matching "view-counts" as an orgId
  apiRouter.get(
    "/accounts/view-counts",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const currentUserId = req.user?.id;

        const [
          needsAttention,
          newInsights,
          hot,
          newProspects,
          goingCold,
          myAccounts,
          renewals,
          members,
          disqualified,
          missingOwner,
        ] = await Promise.all([
          // Needs attention - prospects with action items OR members with real problems
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
                -- Non-members: show if they have action items
                (
                  (${NOT_MEMBER_ALIASED})
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
                )
                OR
                -- Members: show if they have a real problem (expiring soon OR missing owner)
                (
                  ${MEMBER_FILTER_ALIASED}
                  AND (
                    o.subscription_current_period_end <= NOW() + INTERVAL '30 days'
                    OR (
                      EXISTS (SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id)
                      AND NOT EXISTS (SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id AND om.role = 'owner')
                    )
                  )
                )
              )
          `),

          // New insights - prospects with recent Slack activity (30 days)
          pool.query(`
            SELECT COUNT(DISTINCT o.workos_organization_id) as count
            FROM organizations o
            WHERE EXISTS (
              SELECT 1 FROM organization_memberships om
              JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
              WHERE om.workos_organization_id = o.workos_organization_id
                AND sm.last_slack_activity_at >= NOW() - INTERVAL '30 days'
            )
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
            AND (${NOT_MEMBER_ALIASED})
          `),

          // Hot prospects (engagement >= 50 OR high interest)
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE (${NOT_MEMBER_ALIASED})
              AND (
                COALESCE(o.engagement_score, 0) >= 50
                OR o.interest_level IN ('high', 'very_high')
              )
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),

          // New prospects - recently created non-members
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.created_at >= NOW() - INTERVAL '14 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (${NOT_MEMBER_ALIASED})
          `),

          // Going cold
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.last_activity_at IS NOT NULL
              AND o.last_activity_at < NOW() - INTERVAL '30 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (${NOT_MEMBER_ALIASED})
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

          // Renewals
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE ${MEMBER_FILTER_ALIASED}
              AND o.subscription_current_period_end IS NOT NULL
              AND o.subscription_current_period_end <= NOW() + INTERVAL '60 days'
              AND o.subscription_current_period_end > NOW()
          `),

          // Members
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE ${MEMBER_FILTER_ALIASED}
          `),

          // Disqualified
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE o.prospect_status = 'disqualified'
          `),

          // Missing owner - orgs with members but no owner role
          pool.query(`
            SELECT COUNT(*) as count
            FROM organizations o
            WHERE EXISTS (
              SELECT 1 FROM organization_memberships om
              WHERE om.workos_organization_id = o.workos_organization_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM organization_memberships om
              WHERE om.workos_organization_id = o.workos_organization_id AND om.role = 'owner'
            )
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `),
        ]);

        res.json({
          needs_attention: parseInt(needsAttention.rows[0].count),
          new_insights: parseInt(newInsights.rows[0].count),
          hot: parseInt(hot.rows[0].count),
          new_prospects: parseInt(newProspects.rows[0].count),
          going_cold: parseInt(goingCold.rows[0].count),
          my_accounts: parseInt(myAccounts.rows[0].count),
          renewals: parseInt(renewals.rows[0].count),
          members: parseInt(members.rows[0].count),
          disqualified: parseInt(disqualified.rows[0].count),
          missing_owner: parseInt(missingOwner.rows[0].count),
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
        const memberStatus = deriveOrgTier(org);
        const isDisqualified = org.prospect_status === "disqualified";

        // Run parallel queries for related data (including members from local cache)
        const [
          workingGroupResult,
          activitiesResult,
          nextStepsResult,
          stakeholdersResult,
          domainsResult,
          membersResult,
          misalignedUsersResult,
          similarOrgsResult,
          pendingSlackUsersResult,
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
              last_name,
              role
            FROM organization_memberships
            WHERE workos_organization_id = $1
            ORDER BY created_at ASC
          `,
            [orgId]
          ),

          // Domain health: Users with this org's domains who are in personal workspaces
          // (They should be in this org but aren't)
          pool.query(
            `
            WITH org_domains AS (
              -- Get all domains claimed by this org
              SELECT domain FROM organization_domains WHERE workos_organization_id = $1
            ),
            users_with_domain AS (
              -- Find users whose email domain matches one of this org's domains
              SELECT DISTINCT
                om.workos_user_id,
                om.email,
                om.first_name,
                om.last_name,
                om.workos_organization_id,
                o.name as org_name,
                o.is_personal,
                LOWER(SUBSTRING(om.email FROM POSITION('@' IN om.email) + 1)) as user_domain
              FROM organization_memberships om
              JOIN organizations o ON om.workos_organization_id = o.workos_organization_id
              JOIN org_domains od ON LOWER(SUBSTRING(om.email FROM POSITION('@' IN om.email) + 1)) = od.domain
            )
            SELECT
              workos_user_id as user_id,
              email,
              first_name,
              last_name,
              user_domain,
              workos_organization_id as current_org_id,
              org_name as current_org_name,
              is_personal as in_personal_workspace
            FROM users_with_domain
            WHERE workos_organization_id != $1  -- Not already in this org
            ORDER BY is_personal DESC, email ASC
          `,
            [orgId]
          ),

          // Domain health: Similar organization names (potential duplicates)
          // Uses pg_trgm trigram similarity for fuzzy matching
          // Skip for personal workspaces - they shouldn't have duplicates
          pool.query(
            `
            WITH this_org AS (
              SELECT
                workos_organization_id,
                name,
                is_personal,
                LOWER(REGEXP_REPLACE(
                  REGEXP_REPLACE(name, '\\s*(Inc\\.?|LLC|Corp\\.?|Ltd\\.?|Company|Co\\.?)\\s*$', '', 'i'),
                  '[^a-z0-9\\s]', '', 'g'
                )) as normalized_name
              FROM organizations
              WHERE workos_organization_id = $1
            ),
            other_orgs AS (
              SELECT
                workos_organization_id,
                name,
                subscription_status,
                LOWER(REGEXP_REPLACE(
                  REGEXP_REPLACE(name, '\\s*(Inc\\.?|LLC|Corp\\.?|Ltd\\.?|Company|Co\\.?)\\s*$', '', 'i'),
                  '[^a-z0-9\\s]', '', 'g'
                )) as normalized_name
              FROM organizations
              WHERE workos_organization_id != $1
                AND is_personal = false
            )
            SELECT
              oo.workos_organization_id as org_id,
              oo.name,
              oo.subscription_status,
              oo.normalized_name,
              similarity(oo.normalized_name, t.normalized_name) as match_score
            FROM this_org t
            JOIN other_orgs oo ON (
              -- Exact match on normalized name
              oo.normalized_name = t.normalized_name
              -- Or one is a prefix/suffix of the other (e.g., "Yahoo" vs "Yahoo Inc")
              OR oo.normalized_name LIKE t.normalized_name || '%'
              OR oo.normalized_name LIKE '%' || t.normalized_name
              OR t.normalized_name LIKE oo.normalized_name || '%'
              OR t.normalized_name LIKE '%' || oo.normalized_name
              -- Or high trigram similarity (0.4+ catches typos and variations)
              OR similarity(oo.normalized_name, t.normalized_name) >= 0.4
            )
            WHERE LENGTH(t.normalized_name) >= 3
              AND LENGTH(oo.normalized_name) >= 3
              AND t.is_personal = false
            ORDER BY similarity(oo.normalized_name, t.normalized_name) DESC, oo.name ASC
          `,
            [orgId]
          ),

          // Pending Slack users (discovered via domain but not yet members)
          pool.query(
            `
            SELECT
              slack_user_id,
              slack_email,
              slack_display_name,
              slack_real_name,
              last_slack_activity_at
            FROM slack_user_mappings
            WHERE pending_organization_id = $1
              AND mapping_status = 'unmapped'
              AND slack_is_bot = false
              AND slack_is_deleted = false
            ORDER BY last_slack_activity_at DESC NULLS LAST, slack_real_name ASC
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
          pendingInvoices = localInvoices.rows.map((inv) => {
            const dueDate = inv.due_date ? new Date(inv.due_date) : null;
            return {
              id: inv.id,
              status: inv.status as "draft" | "open",
              is_past_due: inv.status === 'open' && dueDate !== null && dueDate < new Date(),
              amount_due: inv.amount_due,
              currency: inv.currency,
              created: inv.created_at || new Date(),
              due_date: dueDate,
              hosted_invoice_url: inv.hosted_invoice_url,
              product_name: null,
              customer_email: null,
            };
          });
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
            role: m.role || "member",
          })),
          member_count: membersResult.rows.length,
          working_groups: workingGroupResult.rows,
          stakeholders: stakeholdersResult.rows,
          domains: domainsResult.rows,

          // Domain health insights for this org
          domain_health: {
            // Users who have this org's domain but aren't in this org
            misaligned_users: misalignedUsersResult.rows,
            // Potential duplicate orgs with similar names
            similar_orgs: similarOrgsResult.rows,
            // Whether all domains are verified
            has_unverified_domains: domainsResult.rows.some(
              (d: { verified?: boolean }) => !d.verified
            ),
          },

          // Pending Slack users (discovered via domain but not yet linked/members)
          pending_slack_users: pendingSlackUsersResult.rows,
          pending_slack_count: pendingSlackUsersResult.rows.length,

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
          // Accounts needing action: prospects with overdue tasks/invoices/high engagement,
          // OR members with real problems (expiring soon, missing owner)
          query = `
            ${selectFields},
            na.next_step_due_date as next_step_due,
            na.description as next_step_description,
            CASE
              WHEN na.next_step_due_date < CURRENT_DATE THEN 'overdue'
              WHEN na.next_step_due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'due_soon'
              WHEN oi.stripe_invoice_id IS NOT NULL THEN 'open_invoice'
              WHEN o.subscription_current_period_end <= NOW() + INTERVAL '30 days'
                AND ${MEMBER_FILTER_ALIASED} THEN 'expiring_soon'
              WHEN COALESCE(o.engagement_score, 0) >= 50 AND NOT EXISTS (
                SELECT 1 FROM org_stakeholders os WHERE os.organization_id = o.workos_organization_id
              ) THEN 'high_engagement_unowned'
              WHEN EXISTS (
                SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id
              ) AND NOT EXISTS (
                SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id AND om.role = 'owner'
              ) THEN 'missing_owner'
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
                -- Non-members: show if they have action items
                (
                  (${NOT_MEMBER_ALIASED})
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
                )
                OR
                -- Members: show if they have a real problem (expiring soon OR missing owner)
                (
                  ${MEMBER_FILTER_ALIASED}
                  AND (
                    o.subscription_current_period_end <= NOW() + INTERVAL '30 days'
                    OR (
                      -- Has members but no owner role
                      EXISTS (SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id)
                      AND NOT EXISTS (SELECT 1 FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id AND om.role = 'owner')
                    )
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
          // High engagement non-members (engagement >= 50 OR high/very_high interest)
          query = `
            ${selectFields}
            FROM organizations o
            WHERE (${NOT_MEMBER_ALIASED})
            AND (
              COALESCE(o.engagement_score, 0) >= 50
              OR o.interest_level IN ('high', 'very_high')
            )
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
              AND (${NOT_MEMBER_ALIASED})
          `;
          orderBy = ` ORDER BY o.last_activity_at DESC`;
          break;

        case "new_insights":
          // Accounts with recent member activity/insights (extended to 30 days)
          // Joins through organization_memberships to find orgs with recent Slack activity
          query = `
            ${selectFields},
            latest_activity.latest_activity_at as last_insight_at
            FROM organizations o
            INNER JOIN LATERAL (
              SELECT MAX(sm.last_slack_activity_at) as latest_activity_at
              FROM organization_memberships om
              JOIN slack_user_mappings sm ON sm.workos_user_id = om.workos_user_id
              WHERE om.workos_organization_id = o.workos_organization_id
                AND sm.last_slack_activity_at >= NOW() - INTERVAL '30 days'
            ) latest_activity ON latest_activity.latest_activity_at IS NOT NULL
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (${NOT_MEMBER_ALIASED})
          `;
          orderBy = ` ORDER BY latest_activity.latest_activity_at DESC`;
          break;

        case "members":
          // All paying members
          query = `
            ${selectFields}
            FROM organizations o
            WHERE ${MEMBER_FILTER_ALIASED}
          `;
          orderBy = ` ORDER BY o.name ASC`;
          break;

        case "renewals":
          // Members with subscriptions ending soon
          query = `
            ${selectFields}
            FROM organizations o
            WHERE ${MEMBER_FILTER_ALIASED}
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
            WHERE ${MEMBER_FILTER_ALIASED}
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
        case "new_prospects":
          // Recently created non-member accounts
          query = `
            ${selectFields}
            FROM organizations o
            WHERE o.created_at >= NOW() - INTERVAL '14 days'
              AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND (${NOT_MEMBER_ALIASED})
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

        case "most_users":
          // Accounts with the most users (members + Slack-only)
          query = `
            ${selectFields},
            (
              COALESCE((SELECT COUNT(*) FROM organization_memberships om WHERE om.workos_organization_id = o.workos_organization_id), 0) +
              COALESCE((SELECT COUNT(*) FROM slack_user_mappings sm
                WHERE sm.pending_organization_id = o.workos_organization_id
                AND sm.mapping_status = 'unmapped'
                AND sm.workos_user_id IS NULL
                AND sm.slack_is_bot = false
                AND sm.slack_is_deleted = false), 0)
            ) as computed_user_count
            FROM organizations o
            WHERE COALESCE(o.prospect_status, 'prospect') != 'disqualified'
              AND o.is_personal = false
          `;
          orderBy = ` ORDER BY computed_user_count DESC, o.engagement_score DESC NULLS LAST`;
          break;

        case "missing_owner":
          // Organizations with members but no owner role
          query = `
            ${selectFields}
            FROM organizations o
            WHERE EXISTS (
              SELECT 1 FROM organization_memberships om
              WHERE om.workos_organization_id = o.workos_organization_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM organization_memberships om
              WHERE om.workos_organization_id = o.workos_organization_id AND om.role = 'owner'
            )
            AND COALESCE(o.prospect_status, 'prospect') != 'disqualified'
          `;
          orderBy = ` ORDER BY o.name ASC`;
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
      const [stakeholdersResult, domainsResult, slackUserCounts, memberCounts, slackOnlyCounts] =
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

          // Slack-only users (not linked to a WorkOS user but associated with org via pending_organization_id)
          pool.query(
            `
            SELECT pending_organization_id as workos_organization_id, COUNT(*) as count
            FROM slack_user_mappings
            WHERE pending_organization_id = ANY($1)
              AND mapping_status = 'unmapped'
              AND workos_user_id IS NULL
              AND slack_is_bot = false
              AND slack_is_deleted = false
            GROUP BY pending_organization_id
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

      const slackOnlyCountMap = new Map(
        slackOnlyCounts.rows.map((r) => [
          r.workos_organization_id,
          parseInt(r.count),
        ])
      );

      // Transform results
      const accounts = result.rows.map((row) => {
        const memberStatus = deriveOrgTier(row);
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

          // Counts - user_count combines formal members + Slack-only users
          slack_user_count: slackCountMap.get(row.workos_organization_id) || 0,
          member_count: memberCountMap.get(row.workos_organization_id) || 0,
          slack_only_count: slackOnlyCountMap.get(row.workos_organization_id) || 0,
          user_count: (memberCountMap.get(row.workos_organization_id) || 0) +
                      (slackOnlyCountMap.get(row.workos_organization_id) || 0),

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

  // GET /api/admin/activity-feed - Unified activity stream across all sources
  apiRouter.get(
    "/activity-feed",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const pool = getPool();
        const { limit: limitParam, offset: offsetParam, source } = req.query;

        const limit = Math.min(Math.max(parseInt(limitParam as string) || 50, 1), 200);
        const offset = Math.max(parseInt(offsetParam as string) || 0, 0);

        // Build source filter if provided - validate against allowed sources
        const ALLOWED_SOURCES = ['slack', 'email', 'event', 'payment', 'working_group'];
        const sourceFilter = source && typeof source === "string"
          ? source.split(",").map(s => s.trim()).filter(s => ALLOWED_SOURCES.includes(s))
          : null;

        // Unified activity query with multiple sources
        const query = `
          WITH activity_stream AS (
            -- Slack activity
            SELECT
              'slack' as source,
              sa.activity_timestamp as timestamp,
              sa.activity_type as action,
              COALESCE(sm.slack_display_name, sm.slack_real_name, 'Unknown') as actor_name,
              o.name as org_name,
              o.workos_organization_id as org_id,
              NULL as description,
              NULL as metadata
            FROM slack_activities sa
            JOIN slack_user_mappings sm ON sm.slack_user_id = sa.slack_user_id
            LEFT JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
            LEFT JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
            WHERE sa.activity_timestamp > NOW() - INTERVAL '7 days'
              AND sa.activity_type IN ('message', 'thread_reply', 'channel_join')

            UNION ALL

            -- Email contact activity
            SELECT
              'email' as source,
              eca.email_date as timestamp,
              'email_received' as action,
              COALESCE(ec.name, ec.email) as actor_name,
              o.name as org_name,
              o.workos_organization_id as org_id,
              eca.subject as description,
              NULL as metadata
            FROM email_contact_activities eca
            JOIN email_activity_contacts eac ON eac.activity_id = eca.id AND eac.is_primary = true
            JOIN email_contacts ec ON ec.id = eac.contact_id
            LEFT JOIN organizations o ON o.workos_organization_id = ec.organization_id
            WHERE eca.email_date > NOW() - INTERVAL '7 days'

            UNION ALL

            -- Event registrations
            SELECT
              'event' as source,
              COALESCE(er.registered_at, er.created_at) as timestamp,
              CASE
                WHEN er.attended THEN 'attended'
                ELSE er.registration_status
              END as action,
              COALESCE(ec.name, u.first_name || ' ' || u.last_name, ec.email, 'Unknown') as actor_name,
              e.title as org_name,
              NULL as org_id,
              e.title as description,
              NULL as metadata
            FROM event_registrations er
            JOIN events e ON e.id = er.event_id
            LEFT JOIN email_contacts ec ON ec.id = er.email_contact_id
            LEFT JOIN users u ON u.workos_user_id = er.workos_user_id
            WHERE COALESCE(er.registered_at, er.created_at) > NOW() - INTERVAL '7 days'

            UNION ALL

            -- Revenue events (payments)
            SELECT
              'payment' as source,
              re.created_at as timestamp,
              re.revenue_type as action,
              o.name as actor_name,
              o.name as org_name,
              o.workos_organization_id as org_id,
              re.product_name as description,
              jsonb_build_object('amount', re.amount_paid, 'currency', re.currency) as metadata
            FROM revenue_events re
            JOIN organizations o ON o.workos_organization_id = re.workos_organization_id
            WHERE re.created_at > NOW() - INTERVAL '30 days'

            UNION ALL

            -- Working group membership changes
            SELECT
              'working_group' as source,
              wgm.joined_at as timestamp,
              'joined_group' as action,
              o.name as actor_name,
              wg.name as org_name,
              o.workos_organization_id as org_id,
              wg.name as description,
              NULL as metadata
            FROM working_group_memberships wgm
            JOIN working_groups wg ON wg.id = wgm.working_group_id
            JOIN organizations o ON o.workos_organization_id = wgm.workos_organization_id
            WHERE wgm.joined_at > NOW() - INTERVAL '30 days'
              AND wgm.status = 'active'
          )
          SELECT *
          FROM activity_stream
          WHERE timestamp IS NOT NULL
            ${sourceFilter ? `AND source = ANY($3)` : ''}
          ORDER BY timestamp DESC
          LIMIT $1 OFFSET $2
        `;

        const params: (number | string[])[] = [limit, offset];
        if (sourceFilter) {
          params.push(sourceFilter);
        }

        const result = await pool.query(query, params);

        // Format response
        const activities = result.rows.map(row => ({
          source: row.source,
          timestamp: row.timestamp,
          action: row.action,
          actor_name: row.actor_name,
          org_name: row.org_name,
          org_id: row.org_id,
          description: row.description,
          metadata: row.metadata,
        }));

        res.json({
          activities,
          pagination: {
            limit,
            offset,
            has_more: activities.length === limit,
          },
        });
      } catch (error) {
        logger.error({ err: error }, "Error fetching activity feed");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to fetch activity feed",
        });
      }
    }
  );

  /**
   * Convert account type between personal and team
   *
   * PUT /admin/accounts/:id/account-type
   *
   * Personal → Team: Only allowed if account has 0 or 1 members (the owner)
   * Team → Personal: Only allowed if account has exactly 1 member
   */
  apiRouter.put(
    "/accounts/:id/account-type",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      const { is_personal } = req.body;

      if (typeof is_personal !== "boolean") {
        return res.status(400).json({
          error: "Invalid request",
          message: "is_personal must be a boolean",
        });
      }

      try {
        const pool = getPool();

        // Get current org state
        const orgResult = await pool.query(
          `SELECT workos_organization_id, name, is_personal
           FROM organizations
           WHERE workos_organization_id = $1`,
          [id]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({
            error: "Not found",
            message: "Account not found",
          });
        }

        const org = orgResult.rows[0];

        // No change needed
        if (org.is_personal === is_personal) {
          return res.json({
            success: true,
            message: "Account type unchanged",
            is_personal: org.is_personal,
          });
        }

        // Get member count from organization_memberships
        const memberResult = await pool.query(
          `SELECT COUNT(*) as count
           FROM organization_memberships
           WHERE workos_organization_id = $1`,
          [id]
        );
        const memberCount = parseInt(memberResult.rows[0].count);

        // Validate conversion
        if (is_personal && memberCount > 1) {
          return res.status(400).json({
            error: "Cannot convert",
            message: `Cannot convert to personal account: account has ${memberCount} team members. Remove team members first or migrate them to another account.`,
            member_count: memberCount,
          });
        }

        // Update the account type
        await pool.query(
          `UPDATE organizations
           SET is_personal = $1, updated_at = NOW()
           WHERE workos_organization_id = $2`,
          [is_personal, id]
        );

        logger.info(
          { orgId: id, from: org.is_personal, to: is_personal },
          "Account type converted"
        );

        res.json({
          success: true,
          message: is_personal
            ? "Converted to personal account"
            : "Converted to team account",
          is_personal,
        });
      } catch (error) {
        logger.error({ err: error, orgId: id }, "Error converting account type");
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to convert account type",
        });
      }
    }
  );

  /**
   * Migrate members from one account to another
   *
   * POST /admin/accounts/:id/migrate-members
   *
   * Body: { target_org_id: string, user_ids?: string[] }
   *
   * If user_ids is provided, only migrate those users.
   * If user_ids is not provided, migrate all members.
   *
   * This removes users from the source org and adds them to the target org
   * via WorkOS API calls.
   */
  apiRouter.post(
    "/accounts/:id/migrate-members",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const { id: sourceOrgId } = req.params;
      const { target_org_id: targetOrgId, user_ids: userIds } = req.body;

      if (!targetOrgId) {
        return res.status(400).json({
          error: "Invalid request",
          message: "target_org_id is required",
        });
      }

      if (sourceOrgId === targetOrgId) {
        return res.status(400).json({
          error: "Invalid request",
          message: "Source and target accounts must be different",
        });
      }

      try {
        const pool = getPool();

        // Verify both organizations exist
        const orgsResult = await pool.query(
          `SELECT workos_organization_id, name, is_personal
           FROM organizations
           WHERE workos_organization_id IN ($1, $2)`,
          [sourceOrgId, targetOrgId]
        );

        if (orgsResult.rows.length !== 2) {
          return res.status(404).json({
            error: "Not found",
            message: "One or both accounts not found",
          });
        }

        const sourceOrg = orgsResult.rows.find(
          (o) => o.workos_organization_id === sourceOrgId
        );
        const targetOrg = orgsResult.rows.find(
          (o) => o.workos_organization_id === targetOrgId
        );

        // Check if target is personal (can't migrate to personal account)
        if (targetOrg.is_personal) {
          return res.status(400).json({
            error: "Invalid target",
            message:
              "Cannot migrate members to a personal account. Convert it to a team account first.",
          });
        }

        // Get members to migrate
        let membersQuery = `
          SELECT om.workos_user_id, om.workos_membership_id, om.email, om.first_name, om.last_name, om.role
          FROM organization_memberships om
          WHERE om.workos_organization_id = $1
        `;
        const queryParams: (string | string[])[] = [sourceOrgId];

        if (userIds && Array.isArray(userIds) && userIds.length > 0) {
          // Validate all user IDs are non-empty strings
          const validIds = userIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0
          );
          if (validIds.length !== userIds.length) {
            return res.status(400).json({
              error: "Invalid request",
              message: "user_ids must contain only non-empty strings",
            });
          }
          membersQuery += ` AND om.workos_user_id = ANY($2)`;
          queryParams.push(validIds);
        }

        const membersResult = await pool.query(membersQuery, queryParams);
        const members = membersResult.rows;

        if (members.length === 0) {
          return res.status(400).json({
            error: "No members",
            message: "No members found to migrate",
          });
        }

        // Dynamic import of WorkOS client since it may not be available in all environments
        const { workos } = await import("../../auth/workos-client.js");

        if (!workos) {
          return res.status(503).json({
            error: "Service unavailable",
            message: "WorkOS client not configured",
          });
        }

        const results: {
          user_id: string;
          email: string;
          status: "success" | "error";
          error?: string;
        }[] = [];

        for (const member of members) {
          try {
            if (!member.role) {
              logger.warn(
                { userId: member.workos_user_id, sourceOrgId },
                'Member has no cached role, defaulting to member during migration'
              );
            }

            // Add to target org FIRST (if this fails, no state has changed)
            const newMembership =
              await workos.userManagement.createOrganizationMembership({
                organizationId: targetOrgId,
                userId: member.workos_user_id,
                roleSlug: member.role || 'member',
              });

            // Only remove from source org AFTER successful add
            if (member.workos_membership_id) {
              await workos.userManagement.deleteOrganizationMembership(
                member.workos_membership_id
              );
            }

            // Update local cache - remove from source and add to target
            await pool.query(
              `DELETE FROM organization_memberships
               WHERE workos_user_id = $1 AND workos_organization_id = $2`,
              [member.workos_user_id, sourceOrgId]
            );

            // Insert into target org cache
            await pool.query(
              `INSERT INTO organization_memberships
               (workos_user_id, workos_organization_id, workos_membership_id, email, first_name, last_name, role, synced_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
               ON CONFLICT (workos_user_id, workos_organization_id) DO UPDATE SET
               workos_membership_id = EXCLUDED.workos_membership_id,
               role = EXCLUDED.role,
               synced_at = NOW()`,
              [
                member.workos_user_id,
                targetOrgId,
                newMembership.id,
                member.email,
                member.first_name,
                member.last_name,
                member.role || 'member',
              ]
            );

            results.push({
              user_id: member.workos_user_id,
              email: member.email,
              status: "success",
            });
          } catch (memberError: unknown) {
            const errorMessage =
              memberError instanceof Error
                ? memberError.message
                : "Unknown error";
            logger.error(
              {
                err: memberError,
                userId: member.workos_user_id,
                sourceOrgId,
                targetOrgId,
              },
              "Error migrating member"
            );
            results.push({
              user_id: member.workos_user_id,
              email: member.email,
              status: "error",
              error: errorMessage,
            });
          }
        }

        const successCount = results.filter((r) => r.status === "success").length;
        const errorCount = results.filter((r) => r.status === "error").length;

        logger.info(
          {
            sourceOrgId,
            targetOrgId,
            totalMembers: members.length,
            successCount,
            errorCount,
          },
          "Member migration completed"
        );

        res.json({
          success: errorCount === 0,
          message: `Migrated ${successCount} of ${members.length} members`,
          source_org: { id: sourceOrgId, name: sourceOrg.name },
          target_org: { id: targetOrgId, name: targetOrg.name },
          results,
        });
      } catch (error) {
        logger.error(
          { err: error, sourceOrgId, targetOrgId },
          "Error migrating members"
        );
        res.status(500).json({
          error: "Internal server error",
          message: "Unable to migrate members",
        });
      }
    }
  );

  /**
   * Update a member's role in an organization
   * PUT /api/admin/accounts/:orgId/members/:userId/role
   *
   * Note: This endpoint uses userId for lookup (available in the account detail UI),
   * unlike /members/:orgId/memberships/:membershipId which uses membershipId.
   */
  apiRouter.put(
    "/accounts/:orgId/members/:userId/role",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const { orgId, userId } = req.params;
      const { role } = req.body;

      if (!role) {
        return res.status(400).json({ error: "Role is required" });
      }

      // Admin endpoint allows owner assignment (regular endpoints use VALID_ASSIGNABLE_ROLES which excludes owner)
      const ADMIN_ASSIGNABLE_ROLES = ["owner", "admin", "member"] as const;
      if (!ADMIN_ASSIGNABLE_ROLES.includes(role)) {
        return res.status(400).json({
          error: `Invalid role. Must be one of: ${ADMIN_ASSIGNABLE_ROLES.join(", ")}`,
        });
      }

      try {
        const pool = getPool();

        // Get the membership to find the WorkOS membership ID and current role
        const membershipResult = await pool.query(
          `SELECT workos_membership_id, email, first_name, last_name, role
           FROM organization_memberships
           WHERE workos_organization_id = $1 AND workos_user_id = $2`,
          [orgId, userId]
        );

        if (membershipResult.rows.length === 0) {
          return res.status(404).json({ error: "Member not found" });
        }

        const membership = membershipResult.rows[0];
        const previousRole = membership.role || "member";

        if (!membership.workos_membership_id) {
          return res.status(400).json({
            error: "Cannot update role: missing WorkOS membership ID",
          });
        }

        // Validate membership ID format
        const membershipId = membership.workos_membership_id;
        if (!isValidWorkOSMembershipId(membershipId)) {
          logger.error(
            { orgId, userId, membershipId },
            "Invalid WorkOS membership ID format"
          );
          return res.status(400).json({
            error: "Invalid membership data",
            message: "Unable to update role due to invalid membership data. Please contact support.",
          });
        }

        // Update role via WorkOS API
        const { workos } = await import("../../auth/workos-client.js");
        if (!workos) {
          return res.status(500).json({ error: "WorkOS client not configured" });
        }

        // Verify membership belongs to the specified organization via WorkOS
        let existingMembership;
        try {
          existingMembership =
            await workos.userManagement.getOrganizationMembership(membershipId);
        } catch (getMembershipError) {
          logger.error(
            { err: getMembershipError, orgId, userId, membershipId },
            "Failed to get membership from WorkOS"
          );
          return res.status(500).json({
            error: "Unable to verify membership",
            message: "Unable to update role. Please try again or contact support.",
          });
        }

        if (existingMembership.organizationId !== orgId) {
          return res.status(400).json({
            error: "Invalid membership",
            message: "Membership does not belong to this organization",
          });
        }

        // Verify the target role exists in WorkOS for this organization
        try {
          const roles = await workos.organizations.listOrganizationRoles({
            organizationId: orgId,
          });
          const roleExists = roles.data.some((r) => r.slug === role);
          if (!roleExists) {
            logger.warn(
              {
                orgId,
                role,
                availableRoles: roles.data.map((r) => r.slug),
              },
              "Target role does not exist in WorkOS organization"
            );
            return res.status(400).json({
              error: "Role not available",
              message: `The '${role}' role is not configured for this organization. Please contact support to set up the role.`,
            });
          }
        } catch (rolesError) {
          // If we can't list roles, log warning but proceed - the update will fail if role doesn't exist
          logger.warn(
            { err: rolesError, orgId, role },
            "Could not verify role exists - proceeding with update attempt"
          );
        }

        try {
          await workos.userManagement.updateOrganizationMembership(membershipId, {
            roleSlug: role,
          });
        } catch (updateError) {
          const updateErrorMessage =
            updateError instanceof Error ? updateError.message : "Unknown error";

          // Extract WorkOS-specific error details for logging
          const workosErrorDetails =
            updateError && typeof updateError === "object"
              ? {
                  code: (updateError as { code?: string }).code,
                  errors: (updateError as { errors?: unknown }).errors,
                  requestID: (updateError as { requestID?: string }).requestID,
                  rawData: (updateError as { rawData?: unknown }).rawData,
                }
              : undefined;

          logger.error(
            {
              err: updateError,
              errorMessage: updateErrorMessage,
              workosErrorDetails,
              orgId,
              userId,
              membershipId,
              role,
            },
            "Failed to update membership role in WorkOS"
          );

          // Provide more specific error message based on error type
          let userMessage =
            "Unable to update role. Please try again or contact support.";
          if (
            updateErrorMessage.includes("pattern") ||
            updateErrorMessage.includes("validation")
          ) {
            userMessage =
              "Unable to update role due to a configuration issue. Please contact support.";
          }

          return res.status(500).json({
            error: "Unable to update role",
            message: userMessage,
          });
        }

        // Update local cache
        await pool.query(
          `UPDATE organization_memberships
           SET role = $1, updated_at = NOW()
           WHERE workos_organization_id = $2 AND workos_user_id = $3`,
          [role, orgId, userId]
        );

        logger.info(
          {
            orgId,
            userId,
            role,
            previousRole,
            email: membership.email,
            adminEmail: req.user?.email,
          },
          "Updated member role"
        );

        // Record audit log for admin actions
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: req.user?.id || "admin",
          action: "admin_member_role_changed",
          resource_type: "membership",
          resource_id: membershipId,
          details: {
            target_user_id: userId,
            target_email: membership.email,
            old_role: previousRole,
            new_role: role,
            admin_email: req.user?.email,
          },
        });

        res.json({
          success: true,
          message: `Role updated to ${role}`,
          user_id: userId,
          role,
        });
      } catch (error: unknown) {
        // Extract error details for logging
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        const errorDetails =
          error && typeof error === "object" && "rawData" in error
            ? (error as { rawData?: unknown }).rawData
            : undefined;

        logger.error(
          { err: error, errorMessage, errorDetails, orgId, userId, role },
          "Error updating member role"
        );

        // Return a user-friendly error message (never expose internal details)
        return res.status(500).json({
          error: "Internal server error",
          message: "Unable to update member role. Please try again or contact support.",
        });
      }
    }
  );

  // GET /api/admin/accounts/:orgId/registry-activity - Registry edits by org members
  apiRouter.get(
    "/accounts/:orgId/registry-activity",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const { orgId } = req.params;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const pool = getPool();

        const result = await pool.query(
          `SELECT * FROM (
            SELECT 'brand' as entity_type, brand_domain as domain,
              revision_number, editor_user_id, editor_email, editor_name,
              edit_summary, is_rollback, created_at
            FROM brand_revisions
            WHERE editor_user_id IN (
              SELECT workos_user_id FROM organization_memberships
              WHERE workos_organization_id = $1
            )
            UNION ALL
            SELECT 'property' as entity_type, publisher_domain as domain,
              revision_number, editor_user_id, editor_email, editor_name,
              edit_summary, is_rollback, created_at
            FROM property_revisions
            WHERE editor_user_id IN (
              SELECT workos_user_id FROM organization_memberships
              WHERE workos_organization_id = $1
            )
          ) combined
          ORDER BY created_at DESC
          LIMIT $2`,
          [orgId, limit]
        );

        res.json({ edits: result.rows });
      } catch (error) {
        logger.error({ err: error }, "Error fetching registry activity");
        res.status(500).json({ error: "Failed to fetch registry activity" });
      }
    }
  );
}

