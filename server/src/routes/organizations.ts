import { respondToAdminAuthorizationError } from '../auth/admin-authorization-response.js';
/**
 * Organization routes module
 *
 * This module contains organization-related routes extracted from http.ts.
 * Includes organization management, join requests, team management,
 * member invitations, and role management.
 */

import { Router, type Request } from "express";
import { excludeOrganizationAuthorizationObservation } from "../middleware/organization-authorization-observer.js";
import { registerOrganizationMembershipMutations } from "./organization-membership-mutations.js";
import { WorkOS } from "@workos-inc/node";
import { getPool, query } from "../db/client.js";
import { createLogger } from "../logger.js";
import {
  requireAuth,
  isDevModeEnabled,
  getDevUser,
} from "../middleware/auth.js";
import { orgCreationRateLimiter } from "../middleware/rate-limit.js";
import { invalidateMembershipCache } from "../db/org-filters.js";
import { validateOrganizationName } from "../middleware/validation.js";
import { OrganizationDatabase, CompanyType, RevenueTier, VALID_REVENUE_TIERS, getSeatUsage, getSeatLimits, resolveMembershipTier, listSeatUpgradeRequests, type Organization } from "../db/organization-db.js";
import { COMPANY_TYPE_VALUES } from "../config/company-types.js";
import { JoinRequestDatabase } from "../db/join-request-db.js";
import * as referralDb from "../db/referral-codes-db.js";
import { SlackDatabase } from "../db/slack-db.js";
import { getCompanyDomain } from "../utils/email-domain.js";
import { resolveUserOrgMembership } from "../utils/resolve-user-org-membership.js";
import {
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
} from "../addie/admin-status-lookup.js";
import {
  createStripeCustomer,
  createCustomerPortalSession,
} from "../billing/stripe-client.js";
import { emailPrefsDb } from "../db/email-preferences-db.js";
import { performCreateOrganization } from "../services/organization-bootstrap.js";
import { collectWorkOSPages } from "../services/workos-pagination.js";
import { canManageOrganizationBilling } from "../billing/billing-authorization.js";
import { getAuthorizationEnforcementWorkos } from "../auth/workos-client.js";
import {
  evaluateOrganizationAuthorizationCanary,
  ORGANIZATION_AUTHORIZATION_BOUNDARIES,
  recordOrganizationAuthorizationCanaryDecision,
} from "../middleware/organization-authorization-canary.js";

const logger = createLogger("organization-routes");

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

// Instantiate database classes
const orgDb = new OrganizationDatabase();

/**
 * Create organization routes
 * Returns a router for API routes (/api/organizations/*)
 */
export function createOrganizationsRouter(): Router {
  const router = Router();
  registerOrganizationMembershipMutations(router);

  // =========================================================================
  // ORGANIZATION SEARCH & DISCOVERY
  // =========================================================================

  // GET /api/organizations/search - Search for organizations by name
  // Used in the "find your company" feature during onboarding
  router.get('/search', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const query = (req.query.q as string) || '';

      if (!query || query.trim().length < 2) {
        return res.json({ organizations: [], user_domain: getCompanyDomain(user.email) });
      }

      const joinRequestDb = new JoinRequestDatabase();

      // Get user's current org memberships to exclude
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
      });
      const userOrgIds = userMemberships.data.map(m => m.organizationId);

      // Get user's pending join requests
      const pendingRequests = await joinRequestDb.getUserPendingRequests(user.id);
      const pendingOrgIds = new Set(pendingRequests.map(r => r.workos_organization_id));

      // Search organizations
      const results = await orgDb.searchOrganizations({
        query: query.trim(),
        excludeOrgIds: userOrgIds,
        limit: 10,
      });

      // Get admin contact info for each org (masked)
      const orgsWithAdmins = await Promise.all(
        results.map(async (org) => {
          let adminContact: string | null = null;
          try {
            const memberships = await workos!.userManagement.listOrganizationMemberships({
              organizationId: org.workos_organization_id,
            });

            // Find an admin or owner
            const adminMembership = memberships.data.find(m => {
              const role = m.role?.slug || 'member';
              return role === 'admin' || role === 'owner';
            });

            if (adminMembership) {
              const adminUser = await workos!.userManagement.getUser(adminMembership.userId);
              // Mask the email: "j***@company.com"
              const email = adminUser.email;
              const [local, domain] = email.split('@');
              adminContact = `${local[0]}***@${domain}`;
            }
          } catch (error) {
            logger.debug({ orgId: org.workos_organization_id, err: error }, 'Could not get admin contact');
          }

          return {
            organization_id: org.workos_organization_id,
            name: org.name,
            company_type: org.company_type,
            logo_url: org.logo_url,
            tagline: org.tagline,
            admin_contact: adminContact,
            request_pending: pendingOrgIds.has(org.workos_organization_id),
          };
        })
      );

      res.json({
        organizations: orgsWithAdmins,
        user_domain: getCompanyDomain(user.email),
      });
    } catch (error) {
      logger.error({ err: error }, 'Organization search error:');
      res.status(500).json({
        error: 'Failed to search organizations',
      });
    }
  });

  // GET /api/organizations/:orgId/admins - Get admin contact info for an organization
  // Used to show who to contact when requesting to join
  router.get('/:orgId/admins', requireAuth, async (req, res) => {
    try {
      const { orgId } = req.params;

      // Get org memberships
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        organizationId: orgId,
      });

      // Find admins and owners
      const adminMemberships = memberships.data.filter(m => {
        const role = m.role?.slug || 'member';
        return role === 'admin' || role === 'owner';
      });

      // Get user details and mask emails
      const admins = await Promise.all(
        adminMemberships.map(async (m) => {
          const adminUser = await workos!.userManagement.getUser(m.userId);
          const email = adminUser.email;
          const [local, domain] = email.split('@');
          const maskedEmail = `${local[0]}***@${domain}`;

          return {
            first_name: adminUser.firstName || null,
            masked_email: maskedEmail,
            role: m.role?.slug || 'admin',
          };
        })
      );

      res.json({ admins });
    } catch (error) {
      logger.error({ err: error, orgId: req.params.orgId }, 'Get org admins error:');
      res.status(500).json({
        error: 'Failed to get organization admins',
      });
    }
  });

  // =========================================================================
  // JOIN REQUESTS
  // =========================================================================

  // GET /api/organizations/:orgId/join-requests - Get pending join requests for an org (admin only)
  router.get('/:orgId/join-requests', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary: ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUESTS_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
        minimumRole: 'admin',
      });

      let userRole: string;
      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUESTS_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
        userRole = canaryDecision.membership.role;
      } else {
        // Kill-switch/default path: retain the shipped canonical-user decision.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
        userRole = membership.role;
      }

      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can view join requests',
        });
      }

      const joinRequestDb = new JoinRequestDatabase();
      const requests = await joinRequestDb.getOrganizationPendingRequests(orgId);

      res.json({
        requests: requests.map(r => ({
          id: r.id,
          user_email: r.user_email,
          first_name: r.first_name,
          last_name: r.last_name,
          status: r.status,
          created_at: r.created_at,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'Get org join requests error:');
      res.status(500).json({
        error: 'Failed to get join requests',
      });
    }
  });

  // GET /api/organizations/:orgId/pending-count - Get count of pending join requests (admin only)
  router.get('/:orgId/pending-count', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary:
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUEST_COUNT_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
      });

      let userRole: string;
      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_PENDING_JOIN_REQUEST_COUNT_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
        userRole = canaryDecision.membership.role;
      } else {
        // Kill-switch/default path: retain the shipped canonical-user decision.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
        userRole = membership.role;
      }

      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.json({ count: 0 }); // Non-admins see 0
      }

      const joinRequestDb = new JoinRequestDatabase();
      const count = await joinRequestDb.getPendingRequestCount(orgId);

      res.json({ count });
    } catch (error) {
      logger.error({ err: error }, 'Get pending count error:');
      res.status(500).json({
        error: 'Failed to get pending count',
      });
    }
  });

  // =========================================================================
  // DOMAIN MANAGEMENT
  // =========================================================================

  // GET /api/organizations/:orgId/domains - Get verified domains for an org
  router.get('/:orgId/domains', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary: ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_DOMAINS_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
      });

      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_DOMAINS_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
      } else {
        // Kill-switch/default path: retain the shipped canonical-user decision.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
      }

      // Get domains, both auto-provision settings, and any inferred
      // subsidiary brands in one round trip. Inferred subsidiaries — high-
      // confidence brand-registry rows whose house_domain matches one of
      // this org's verified domains — are what an owner gives access to
      // when they enable hierarchical auto-provisioning, so the UI shows
      // them in the same surface as the toggle.
      //
      // Hierarchy classification (parent + self) is also returned so owners
      // can see how the brand registry has classified their org and dispute
      // it if wrong. Without visibility, the auto-provision toggle is a
      // black box: an owner can't tell whether enabling it would inherit
      // employees from the right parent or grant access via a stale edge.
      const pool = getPool();
      const [domainsResult, settingResult, subsidiariesResult, selfBrandResult] = await Promise.all([
        pool.query(
          `SELECT domain, verified, is_primary
           FROM organization_domains
           WHERE workos_organization_id = $1
           ORDER BY is_primary DESC, domain ASC`,
          [orgId]
        ),
        pool.query<{
          auto_provision_verified_domain: boolean;
          auto_provision_brand_hierarchy_children: boolean;
          auto_provision_hierarchy_enabled_at: Date | null;
        }>(
          `SELECT
             auto_provision_verified_domain,
             auto_provision_brand_hierarchy_children,
             auto_provision_hierarchy_enabled_at
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        ),
        pool.query<{ domain: string; brand_name: string | null; source: string | null; last_validated: Date | null }>(
          `SELECT db.domain, db.brand_name, db.source_type AS source, db.last_validated
           FROM brands db
           WHERE db.house_domain IN (
                   SELECT od.domain FROM organization_domains od
                   WHERE od.workos_organization_id = $1 AND od.verified = true
                 )
             AND db.brand_manifest->'classification'->>'confidence' = 'high'
             AND COALESCE(db.last_validated, db.discovered_at, db.created_at)
                 > NOW() - INTERVAL '180 days'
           ORDER BY db.domain ASC`,
          [orgId]
        ),
        // Self + parent classification: pull the brands row whose domain is
        // any of this org's verified domains, plus the parent (if house_domain
        // is set) in one query via LATERAL.
        pool.query<{
          self_domain: string;
          self_brand_name: string | null;
          self_house_domain: string | null;
          self_confidence: string | null;
          self_source: string | null;
          self_last_validated: Date | null;
          parent_domain: string | null;
          parent_brand_name: string | null;
          parent_source: string | null;
          parent_last_validated: Date | null;
        }>(
          // Tenant-scoped ORDER BY: the is_primary lookup must filter by
          // workos_organization_id, otherwise an org that shares a verified
          // domain with another tenant could pick the wrong row's primary
          // flag. Self-loop guard on the parent join: a malformed brand row
          // pointing house_domain at its own domain would otherwise render
          // "you are a child of yourself".
          `SELECT
             db.domain AS self_domain,
             db.brand_name AS self_brand_name,
             db.house_domain AS self_house_domain,
             db.brand_manifest->'classification'->>'confidence' AS self_confidence,
             db.source_type AS self_source,
             db.last_validated AS self_last_validated,
             parent.domain AS parent_domain,
             parent.brand_name AS parent_brand_name,
             parent.source_type AS parent_source,
             parent.last_validated AS parent_last_validated
           FROM brands db
           LEFT JOIN brands parent
             ON parent.domain = db.house_domain
            AND parent.domain != db.domain
           WHERE db.domain IN (
                   SELECT od.domain FROM organization_domains od
                   WHERE od.workos_organization_id = $1 AND od.verified = true
                 )
           ORDER BY (
             SELECT is_primary FROM organization_domains od
             WHERE od.domain = db.domain
               AND od.workos_organization_id = $1
             LIMIT 1
           ) DESC NULLS LAST
           LIMIT 1`,
          [orgId]
        ),
      ]);

      const setting = settingResult.rows[0];
      const selfRow = selfBrandResult.rows[0];
      const hierarchyClassification = selfRow
        ? {
            self: {
              domain: selfRow.self_domain,
              brand_name: selfRow.self_brand_name,
              confidence: selfRow.self_confidence,
              source: selfRow.self_source,
              last_validated: selfRow.self_last_validated,
            },
            parent: selfRow.parent_domain
              ? {
                  domain: selfRow.parent_domain,
                  brand_name: selfRow.parent_brand_name,
                  source: selfRow.parent_source,
                  last_validated: selfRow.parent_last_validated,
                }
              : null,
          }
        : null;

      res.json({
        domains: domainsResult.rows.map(r => ({
          domain: r.domain,
          verified: r.verified,
          is_primary: r.is_primary,
        })),
        auto_provision_verified_domain: setting?.auto_provision_verified_domain ?? true,
        auto_provision_brand_hierarchy_children: setting?.auto_provision_brand_hierarchy_children ?? false,
        auto_provision_hierarchy_enabled_at: setting?.auto_provision_hierarchy_enabled_at ?? null,
        hierarchy_classification: hierarchyClassification,
        inferred_subsidiaries: subsidiariesResult.rows.map(r => ({
          domain: r.domain,
          brand_name: r.brand_name,
          source: r.source,
          last_validated: r.last_validated,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'Get org domains error:');
      res.status(500).json({
        error: 'Failed to get domains',
      });
    }
  });

  // POST /api/organizations/:orgId/brand-classification-report - Record that
  // a member flagged a brand-registry classification as wrong on the team page.
  // Writes a structured audit row so we have a triage queue + can detect
  // "10 different members reported the same domain". Doesn't block the user
  // — they're also opening a mailto in parallel, so this is fire-and-forget
  // best-effort.
  router.post('/:orgId/brand-classification-report', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { kind, subject_domain } = req.body ?? {};

      const VALID_KINDS = ['parent', 'self', 'child'];
      if (!VALID_KINDS.includes(kind)) {
        return res.status(400).json({ error: 'Invalid kind', message: `kind must be one of: ${VALID_KINDS.join(', ')}` });
      }
      if (typeof subject_domain !== 'string' || subject_domain.length === 0 || subject_domain.length > 253) {
        return res.status(400).json({ error: 'Invalid subject_domain' });
      }

      // Member of the org can flag — broader than admin/owner, since the
      // report is informational and the corrective action is admin-side.
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({ error: 'Access denied', message: 'You are not a member of this organization' });
      }

      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'brand_classification_report_filed',
        resource_type: 'brand',
        resource_id: subject_domain.toLowerCase(),
        details: {
          kind,
          subject_domain: subject_domain.toLowerCase(),
          reported_by_email: user.email,
        },
      });

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Brand classification report error');
      res.status(500).json({ error: 'Failed to record report' });
    }
  });

  // GET /api/organizations/:orgId/domain-users - Get Slack users from verified domains not in org (admin only)
  router.get('/:orgId/domain-users', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary: ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_DOMAIN_USERS_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
        minimumRole: 'admin',
      });

      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_DOMAIN_USERS_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
      } else {
        // Kill-switch/default path: preserve the shipped resolver and responses exactly.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        const userRole = membership.role;
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can view domain users',
          });
        }
      }

      // Get verified domains for this org
      const pool = getPool();
      const domainsResult = await pool.query(
        `SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND verified = true`,
        [orgId]
      );

      if (domainsResult.rows.length === 0) {
        return res.json({ users: [] });
      }

      const domains = domainsResult.rows.map(r => r.domain.toLowerCase());

      // Get current org members' emails (paginate to get all)
      const memberEmails = new Set<string>();
      let after: string | undefined;
      do {
        const membershipsPage = await workos!.userManagement.listOrganizationMemberships({
          organizationId: orgId,
          after,
          limit: 100,
        });
        for (const membership of membershipsPage.data) {
          try {
            const memberUser = await workos!.userManagement.getUser(membership.userId);
            if (memberUser.email) {
              memberEmails.add(memberUser.email.toLowerCase());
            }
          } catch {
            // Skip if can't fetch user
          }
        }
        after = membershipsPage.listMetadata?.after ?? undefined;
      } while (after);

      // Get pending join request emails for this org
      const joinRequestsResult = await pool.query(
        `SELECT LOWER(user_email) as email FROM organization_join_requests
         WHERE workos_organization_id = $1 AND status = 'pending'`,
        [orgId]
      );
      const pendingJoinRequestEmails = new Set(joinRequestsResult.rows.map(r => r.email));

      // Get pending invitation emails from WorkOS
      const pendingInvitationEmails = new Set<string>();
      try {
        const invitations = await workos!.userManagement.listInvitations({
          organizationId: orgId,
        });
        for (const inv of invitations.data) {
          if (inv.state === 'pending' && inv.email) {
            pendingInvitationEmails.add(inv.email.toLowerCase());
          }
        }
      } catch {
        // Continue without invitation filtering if API fails
      }

      // Get Slack users from these domains who aren't members, with WorkOS user info
      const domainUsers: Array<{
        slack_email: string;
        slack_real_name: string | null;
        slack_display_name: string | null;
        workos_user_id: string | null;
      }> = [];

      const slackUsersResult = await pool.query(
        `SELECT slack_email, slack_real_name, slack_display_name, workos_user_id
         FROM slack_user_mappings
         WHERE slack_is_bot = false
           AND slack_is_deleted = false
           AND slack_email IS NOT NULL
           AND LOWER(SPLIT_PART(slack_email, '@', 2)) = ANY($1)
         ORDER BY slack_real_name NULLS LAST, slack_display_name NULLS LAST`,
        [domains]
      );

      for (const row of slackUsersResult.rows) {
        if (row.slack_email && !memberEmails.has(row.slack_email.toLowerCase())) {
          const emailLower = row.slack_email.toLowerCase();
          const hasPendingJoinRequest = pendingJoinRequestEmails.has(emailLower);
          const hasPendingInvitation = pendingInvitationEmails.has(emailLower);

          // Skip users who already have pending join requests or invitations
          if (hasPendingJoinRequest || hasPendingInvitation) {
            continue;
          }

          domainUsers.push({
            slack_email: row.slack_email,
            slack_real_name: row.slack_real_name,
            slack_display_name: row.slack_display_name,
            workos_user_id: row.workos_user_id,
          });
        }
      }

      res.json({ users: domainUsers });
    } catch (error) {
      logger.error({ err: error }, 'Get domain users error:');
      res.status(500).json({
        error: 'Failed to get domain users',
      });
    }
  });

  // POST /api/organizations/:orgId/domain-users/add - Directly add a domain user to org (admin only)

  // POST /api/organizations/:orgId/domain-verification-link - Generate WorkOS portal link for domain verification
  router.post('/:orgId/domain-verification-link', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Domain verification changes organization-wide identity and automatic
      // membership behavior. Keep it aligned with the canonical domain
      // add/verify routes: owners and admins only.
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }
      if (membership.role !== 'owner' && membership.role !== 'admin') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only owners and admins can verify organization domains',
        });
      }

      // Check if organization is personal (cannot claim domains)
      const localOrg = await orgDb.getOrganization(orgId);
      if (localOrg?.is_personal) {
        return res.status(400).json({
          error: 'Personal workspace',
          message: 'Personal workspaces cannot claim corporate domains. Convert to a team workspace first.',
        });
      }

      // Generate portal link for domain verification
      const { link } = await workos!.adminPortal.generateLink({
        organization: orgId,
        intent: 'domain_verification' as any,
      });

      logger.info({ organizationId: orgId, userId: user.id }, 'Generated domain verification portal link');

      res.json({ link });
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate domain verification link');
      res.status(500).json({
        error: 'Failed to generate domain verification link',
      });
    }
  });

  // =========================================================================
  // ORGANIZATION CRUD
  // =========================================================================

  // POST /api/organizations - Create a new organization
  router.post('/', requireAuth, orgCreationRateLimiter, async (req, res) => {
    try {
      const user = req.user!;
      const { organization_name, is_personal, company_type, revenue_tier, marketing_opt_in } = req.body;

      // `membership_tier` and `corporate_domain` are NOT accepted from caller
      // input. Tier is owned exclusively by the Stripe webhook (any value
      // stamped here would only be overwritten on the first subscription
      // sync, but in the gap it would leak tier-gated UI state to a caller
      // who never paid). The corporate domain is always derived from the
      // authenticated user's email — accepting it as a field invited
      // confusing 400s when a caller's value disagreed with their email,
      // and gave nothing back when it agreed.
      if (req.body && (req.body.membership_tier !== undefined || req.body.corporate_domain !== undefined)) {
        logger.warn(
          {
            userId: user.id,
            sentMembershipTier: req.body.membership_tier !== undefined,
            sentCorporateDomain: req.body.corporate_domain !== undefined,
          },
          'POST /api/organizations: caller supplied no-longer-accepted fields; ignoring',
        );
      }

      const outcome = await performCreateOrganization(
        {
          user: { id: user.id, email: user.email },
          organization_name,
          is_personal: !!is_personal,
          company_type,
          revenue_tier,
          marketing_opt_in,
          isDevUser: !!(isDevModeEnabled() && getDevUser(req)),
          requestContext: {
            ip: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
            userAgent: (req.headers['user-agent'] as string) || 'unknown',
          },
        },
        { workos, orgDb },
      );

      switch (outcome.kind) {
        case 'onboarding_disabled':
          return res.status(403).json({
            error: 'organization_onboarding_disabled',
            message: 'Organization creation and adoption are temporarily unavailable.',
          });
        case 'created':
          return res.json({
            success: true,
            organization: { id: outcome.orgId, name: outcome.name },
          });
        case 'adopted':
          return res.status(200).json({
            id: outcome.orgId,
            name: outcome.name,
            adopted: true,
          });
        case 'org_limit_reached':
          return res.status(400).json({
            error: 'Organization limit reached',
            message: 'You have reached the maximum number of organizations. Please contact support if you need more.',
          });
        case 'personal_workspace_exists':
          return res.status(409).json({
            error: 'Personal workspace exists',
            message: 'You already have a personal workspace.',
          });
        case 'missing_organization_name':
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'organization_name is required',
          });
        case 'invalid_organization_name':
          return res.status(400).json({
            error: 'Invalid organization name',
            message: outcome.message,
          });
        case 'invalid_company_type':
          return res.status(400).json({
            error: 'Invalid company type',
            message: `company_type must be one of: ${COMPANY_TYPE_VALUES.join(', ')}`,
          });
        case 'invalid_revenue_tier':
          return res.status(400).json({
            error: 'Invalid revenue tier',
            message: `revenue_tier must be one of: ${VALID_REVENUE_TIERS.join(', ')}`,
          });
        case 'corporate_email_required':
          return res.status(400).json({
            error: 'Corporate email required',
            message: 'To register a company, you must be signed in with a corporate email address. Personal email domains (Gmail, Yahoo, etc.) cannot be used for company registration.',
          });
        case 'domain_taken':
          return res.status(409).json({
            error: 'Organization exists',
            message: `An organization for ${outcome.domain} already exists: "${outcome.existingOrgName}". Please search for it and request to join instead of creating a new one.`,
            existing_org_id: outcome.existingOrgId,
            existing_org_name: outcome.existingOrgName,
          });
      }
    } catch (error) {
      logger.error({ err: error }, 'Create organization error');

      // Provide more helpful error messages for common WorkOS errors
      const errorMessage = error instanceof Error ? error.message : '';

      if (errorMessage.includes('state should not be empty')) {
        res.status(500).json({
          error: 'Failed to create organization',
          message: 'WorkOS configuration error: Organizations require additional setup in WorkOS Dashboard. Please contact support or check your WorkOS settings.',
        });
      } else {
        res.status(500).json({
          error: 'Failed to create organization',
          message: 'An internal error occurred while creating the organization.',
        });
      }
    }
  });

  // PUT /api/organizations/:orgId - Update organization (rename)
  router.put('/:orgId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { name } = req.body;

      // Validate name is provided
      if (!name) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'name is required',
        });
      }

      // Validate organization name format
      const nameValidation = validateOrganizationName(name);
      if (!nameValidation.valid) {
        return res.status(400).json({
          error: 'Invalid organization name',
          message: nameValidation.error,
        });
      }

      const trimmedName = name.trim();

      // Verify user is member of this organization with owner or admin role
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Only owners and admins can rename
      const userRole = membership.role;
      if (userRole !== 'owner' && userRole !== 'admin') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only organization owners and admins can rename the organization',
        });
      }

      // Update in WorkOS
      const updatedOrg = await workos!.organizations.updateOrganization({
        organization: orgId,
        name: trimmedName,
      });

      // Update in our database
      await orgDb.updateOrganization(orgId, { name: trimmedName });

      // Record audit log. Tag dev-bypass writes so post-incident triage can
      // distinguish them from real-user writes.
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'organization_renamed',
        resource_type: 'organization',
        resource_id: orgId,
        details: {
          new_name: trimmedName,
          ...(membership.via_dev_bypass ? { auth_method: 'dev-bypass' } : {}),
        },
      });

      logger.info({ orgId, newName: trimmedName, userId: user.id }, 'Organization renamed');

      res.json({
        success: true,
        organization: {
          id: updatedOrg.id,
          name: updatedOrg.name,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Update organization error');
      res.status(500).json({
        error: 'Failed to update organization',
      });
    }
  });

  // PATCH /api/organizations/:orgId/settings - Update organization settings
  // (company_type, revenue_tier, auto_provision_verified_domain,
  //  auto_provision_brand_hierarchy_children)
  router.patch('/:orgId/settings', requireAuth, async (req, res) => {
    try {
      const user = Object.freeze({ id: req.user!.id });
      const principal = Object.freeze({
        id: req.user!.authWorkosUserId ?? req.user!.id,
        email: req.user!.email,
      });
      const isStaticAdminApiKey =
        (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey === true;
      const { orgId } = req.params;

      // Verify user is member of this organization with owner or admin role
      const membership = await resolveUserOrgMembership(workos, principal.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Only owners and admins can update settings
      const userRole = membership.role;
      if (userRole !== 'owner' && userRole !== 'admin') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only organization owners and admins can update settings',
        });
      }

      // Resolve the privilege-grant capability from trusted authority before
      // request fields decide which settings to write. Preserve ordinary
      // settings updates when only the separate platform lookup is unavailable.
      let canChangeAutoProvision = userRole === 'owner' || isStaticAdminApiKey;
      let autoProvisionLookupError: AAOAdminLookupUnavailableError | undefined;
      if (!canChangeAutoProvision) {
        try {
          canChangeAutoProvision = await isAuthenticatedUserAAOAdmin(principal);
        } catch (error) {
          if (!(error instanceof AAOAdminLookupUnavailableError)) throw error;
          autoProvisionLookupError = error;
        }
      }

      // Check if organization is personal (cannot have company type/revenue tier)
      const org = await orgDb.getOrganization(orgId);
      if (!org) {
        return res.status(404).json({
          error: 'Organization not found',
          message: 'The requested organization does not exist',
        });
      }

      if (org.is_personal) {
        return res.status(400).json({
          error: 'Invalid operation',
          message: 'Personal workspaces cannot have company type or revenue tier',
        });
      }

      const {
        company_type,
        revenue_tier,
        auto_provision_verified_domain,
        auto_provision_brand_hierarchy_children,
      } = req.body;

      // Validate company_type if provided
      if (company_type !== undefined && company_type !== null && !COMPANY_TYPE_VALUES.includes(company_type)) {
        return res.status(400).json({
          error: 'Invalid company type',
          message: `company_type must be one of: ${COMPANY_TYPE_VALUES.join(', ')}`,
        });
      }

      // Validate revenue_tier if provided
      if (revenue_tier !== undefined && revenue_tier !== null && !VALID_REVENUE_TIERS.includes(revenue_tier as any)) {
        return res.status(400).json({
          error: 'Invalid revenue tier',
          message: `revenue_tier must be one of: ${VALID_REVENUE_TIERS.join(', ')}`,
        });
      }

      // Validate auto_provision_verified_domain if provided
      if (auto_provision_verified_domain !== undefined && typeof auto_provision_verified_domain !== 'boolean') {
        return res.status(400).json({
          error: 'Invalid auto_provision_verified_domain',
          message: 'auto_provision_verified_domain must be a boolean',
        });
      }

      // Validate auto_provision_brand_hierarchy_children if provided
      if (
        auto_provision_brand_hierarchy_children !== undefined &&
        typeof auto_provision_brand_hierarchy_children !== 'boolean'
      ) {
        return res.status(400).json({
          error: 'Invalid auto_provision_brand_hierarchy_children',
          message: 'auto_provision_brand_hierarchy_children must be a boolean',
        });
      }

      // Both auto-provision flags are privilege grants — turning either on
      // widens org membership in a way an admin shouldn't be able to do
      // unilaterally (admins can promote auto-joined members to admin under
      // the role-cap policy). Restrict to owner-only. AAO super-admin (or
      // the static admin API key for internal tooling) can override.
      if (!canChangeAutoProvision) {
        if (
          auto_provision_verified_domain !== undefined
          || auto_provision_brand_hierarchy_children !== undefined
        ) {
          if (autoProvisionLookupError) throw autoProvisionLookupError;
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only owners can change auto-provisioning settings',
          });
        }
      }

      // Build updates object with properly typed values
      const updates: {
        company_type?: CompanyType | null;
        revenue_tier?: RevenueTier | null;
        auto_provision_verified_domain?: boolean;
        auto_provision_brand_hierarchy_children?: boolean;
      } = {};
      if (company_type !== undefined) {
        updates.company_type = company_type as CompanyType | null;
      }
      if (revenue_tier !== undefined) {
        updates.revenue_tier = revenue_tier as RevenueTier | null;
      }
      if (auto_provision_verified_domain !== undefined) {
        updates.auto_provision_verified_domain = auto_provision_verified_domain;
      }
      if (auto_provision_brand_hierarchy_children !== undefined) {
        updates.auto_provision_brand_hierarchy_children = auto_provision_brand_hierarchy_children;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error: 'No updates provided',
          message: 'Provide company_type, revenue_tier, auto_provision_verified_domain, or auto_provision_brand_hierarchy_children to update',
        });
      }

      // Update in our database
      await orgDb.updateOrganization(orgId, updates);

      // Record audit log. Tag dev-bypass writes so post-incident triage can
      // distinguish them from real-user writes (the synthetic user_dev_*
      // IDs aren't resolvable via WorkOS). Capture IP + UA from main.
      const rawUA = req.get('user-agent');
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'organization_settings_updated',
        resource_type: 'organization',
        resource_id: orgId,
        details: {
          ip_address: req.ip ?? null,
          user_agent: rawUA ? rawUA.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512) : null,
          ...req.staticAdminAuditDetails,
          ...updates,
          ...(membership.via_dev_bypass ? { auth_method: 'dev-bypass' } : {}),
        },
      });

      logger.info({ orgId, updates, userId: user.id }, 'Organization settings updated');

      res.json({
        success: true,
        company_type: company_type !== undefined ? company_type : org.company_type,
        revenue_tier: revenue_tier !== undefined ? revenue_tier : org.revenue_tier,
        auto_provision_verified_domain: auto_provision_verified_domain !== undefined
          ? auto_provision_verified_domain
          : org.auto_provision_verified_domain,
        auto_provision_brand_hierarchy_children: auto_provision_brand_hierarchy_children !== undefined
          ? auto_provision_brand_hierarchy_children
          : org.auto_provision_brand_hierarchy_children,
      });
    } catch (error) {
      if (respondToAdminAuthorizationError(error, res)) return;
      logger.error({ err: error }, 'Update organization settings error');
      res.status(500).json({
        error: 'Failed to update organization settings',
      });
    }
  });

  // #6827: deletion is unavailable until a durable lifecycle journal and exact
  // reconciliation contract exist. Return before auth (which can hydrate local
  // identity/cache state), authority/subscription reads, audit or provider work.
  // This generic response exposes no organization data and has no role bypass.
  router.delete('/:orgId', excludeOrganizationAuthorizationObservation, (_req, res) => {
    return res.status(503).json({
      error: 'organization_deletion_unavailable',
      message: 'Organization deletion is temporarily unavailable.',
    });
  });

  // =========================================================================
  // BILLING
  // =========================================================================

  // POST /api/organizations/:orgId/billing/portal - Create Customer Portal session
  router.post('/:orgId/billing/portal', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // The Stripe Customer Portal can change payment methods, tiers, and
      // cancellation. Bind that authority to an active owner/admin role in
      // this exact organization before any database or Stripe work.
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!canManageOrganizationBilling(membership, orgId)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Only organization owners and admins can manage billing',
        });
      }

      // Get organization from database
      const org = await orgDb.getOrganization(orgId);
      if (!org) {
        return res.status(404).json({
          error: 'Organization not found',
          message: 'Organization not found in database',
        });
      }

      // Refuse to open the customer portal for an org that has never had a
      // subscription. The portal manages an *existing* subscription — it
      // does not initiate one. Sabarish/Voise Tech opened the portal four
      // times before realizing they couldn't pay through it; the silent
      // dead end looks broken to a customer.
      //
      // We only block when subscription_status is NULL — never had a sub.
      // past_due / unpaid / incomplete / trialing / canceled all benefit
      // from the portal: that's where users update a card, retry a failed
      // charge, or restart a canceled sub. Blocking those would replace
      // one dead end with another.
      if (!org.subscription_status) {
        return res.status(400).json({
          error: 'No subscription on file',
          message: 'The billing portal manages an existing subscription. Start one from the membership page first.',
          membership_url: '/dashboard/membership',
        });
      }

      // Re-resolve immediately before the first operation that can call
      // Stripe. A cached/earlier owner role must not survive a concurrent
      // demotion or membership revocation.
      const currentMembership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!canManageOrganizationBilling(currentMembership, orgId)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Only organization owners and admins can manage billing',
        });
      }

      // Create Stripe customer if needed (row-level lock prevents duplicate creation)
      const stripeCustomerId = await orgDb.getOrCreateStripeCustomer(orgId, () =>
        createStripeCustomer({
          email: user.email,
          name: org.name,
          metadata: { workos_organization_id: orgId },
        })
      );

      if (!stripeCustomerId) {
        return res.status(500).json({
          error: 'Failed to create billing account',
          message: 'Could not create Stripe customer',
        });
      }

      // Create Customer Portal session
      const returnUrl = `${req.protocol}://${req.get('host')}/dashboard`;
      const portalUrl = await createCustomerPortalSession(stripeCustomerId, returnUrl);

      if (!portalUrl) {
        return res.status(500).json({
          error: 'Failed to create portal session',
          message: 'Could not create Stripe Customer Portal session',
        });
      }

      res.json({
        success: true,
        portal_url: portalUrl,
      });
    } catch (error) {
      logger.error({ err: error }, 'Create portal session error');
      res.status(500).json({
        error: 'Failed to create portal session',
      });
    }
  });

  // POST /api/organizations/:orgId/pending-agreement - Store pending agreement info
  // This is called when user checks the agreement checkbox, before payment
  // Actual acceptance is recorded in webhook when payment succeeds
  router.post('/:orgId/pending-agreement', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { agreement_version, agreement_accepted_at } = req.body;

      if (!agreement_version) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'agreement_version is required',
        });
      }

      // Reject forged/stale versions. Caller must echo back the version
      // currently published by getCurrentAgreementByType — anything else and
      // we'd stamp the org with a string we don't control as the contract of
      // record (security review on PR for #4565/#4573).
      const submittedVersion = String(agreement_version).trim();
      const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
      if (!currentAgreement || submittedVersion !== currentAgreement.version) {
        return res.status(400).json({
          error: 'Agreement version mismatch',
          message:
            'The membership agreement has changed. Please reload and accept the current version.',
          current_version: currentAgreement?.version ?? null,
        });
      }

      // Verify user is member of this organization
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Ensure organization exists in local DB (on-demand sync from WorkOS).
      // ensureOrganizationExists mirrors the WorkOS domain list into
      // organization_domains + email_domain so the row is reachable by
      // findPayingOrgForDomain / resolveOrgByDomain — otherwise this path
      // produces the same orphan class the orphan-org audit catches.
      let org: Organization | null = null;
      try {
        org = await orgDb.ensureOrganizationExists(workos!, orgId);
      } catch (syncError) {
        logger.warn({ orgId, err: syncError }, 'Failed to sync organization from WorkOS');
      }

      if (!org) {
        return res.status(404).json({
          error: 'Organization not found',
          message: 'Could not find or sync organization',
        });
      }

      // Store pending agreement info in organization record using the
      // server-validated version (not the raw client string) so the audit
      // record is canonical.
      await orgDb.updateOrganization(orgId, {
        pending_agreement_version: currentAgreement.version,
        pending_agreement_accepted_at: agreement_accepted_at ? new Date(agreement_accepted_at) : new Date(),
        pending_agreement_user_id: user.id,
      });

      logger.info({
        orgId,
        userId: user.id,
        version: currentAgreement.version
      }, 'Pending agreement info stored (will be recorded on payment success)');

      res.json({
        success: true,
        agreement_version: currentAgreement.version,
        accepted_at: new Date().toISOString(),
      });

    } catch (error) {
      logger.error({ err: error }, 'Accept membership agreement error:');
      res.status(500).json({
        error: 'Failed to record agreement acceptance',
      });
    }
  });

  // POST /api/organizations/:orgId/convert-to-team - Convert personal workspace to team
  router.post('/:orgId/convert-to-team', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is owner of this organization
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = membership.role;
      if (userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only owners can convert a workspace to a team',
        });
      }

      // Check if already a team
      const localOrg = await orgDb.getOrganization(orgId);
      if (!localOrg?.is_personal) {
        return res.status(400).json({
          error: 'Already a team',
          message: 'This workspace is already a team workspace',
        });
      }

      // Convert to team by setting is_personal to false
      await orgDb.updateOrganization(orgId, { is_personal: false });

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'convert_to_team',
        resource_type: 'organization',
        resource_id: orgId,
        details: {
          previous_state: 'personal',
          new_state: 'team',
        },
      });

      logger.info({ orgId, userId: user.id }, 'Personal workspace converted to team');

      res.json({
        success: true,
        message: 'Workspace converted to team successfully',
      });
    } catch (error) {
      logger.error({ err: error }, 'Convert to team error');
      res.status(500).json({
        error: 'Failed to convert workspace',
      });
    }
  });

  // POST /api/organizations/:orgId/convert-to-individual - Convert team workspace to individual
  router.post('/:orgId/convert-to-individual', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is owner of this organization
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = membership.role;
      if (userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only owners can convert a workspace to individual',
        });
      }

      // Check if already individual
      const localOrg = await orgDb.getOrganization(orgId);
      if (localOrg?.is_personal) {
        return res.status(400).json({
          error: 'Already individual',
          message: 'This workspace is already an individual workspace',
        });
      }

      // Check team member count - can't convert if there are multiple members
      // Use pagination but exit early once we find more than 1 member
      let totalMembers = 0;
      let memberAfter: string | undefined;
      do {
        const membershipsPage = await workos!.userManagement.listOrganizationMemberships({
          organizationId: orgId,
          after: memberAfter,
          limit: 100,
        });
        totalMembers += membershipsPage.data.length;
        if (totalMembers > 1) break; // Early exit - no need to count further
        memberAfter = membershipsPage.listMetadata?.after ?? undefined;
      } while (memberAfter);

      if (totalMembers > 1) {
        return res.status(400).json({
          error: 'Has team members',
          message: `Cannot convert to individual account: this workspace has ${totalMembers} team members. Remove other team members first.`,
          member_count: totalMembers,
        });
      }

      // Convert to individual by setting is_personal to true
      await orgDb.updateOrganization(orgId, { is_personal: true });

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'convert_to_individual',
        resource_type: 'organization',
        resource_id: orgId,
        details: {
          previous_state: 'team',
          new_state: 'personal',
        },
      });

      logger.info({ orgId, userId: user.id }, 'Team workspace converted to individual');

      res.json({
        success: true,
        message: 'Workspace converted to individual successfully',
      });
    } catch (error) {
      logger.error({ err: error }, 'Convert to individual error');
      res.status(500).json({
        error: 'Failed to convert workspace',
      });
    }
  });

  // First-owner recovery requires a separate explicit, consented operation.
  router.post('/:orgId/claim', requireAuth, async (_req, res) => {
    return res.status(403).json({
      error: 'organization_onboarding_disabled',
      message: 'Organization claiming is temporarily unavailable.',
    });
  });

  // =========================================================================
  // TEAM MANAGEMENT
  // =========================================================================

  // GET /api/organizations/:orgId/members - List organization members
  router.get('/:orgId/members', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Dev mode: return mock member list for dev orgs
      const devUserForMembers = isDevModeEnabled() ? getDevUser(req) : null;
      if (devUserForMembers && orgId.startsWith('org_dev_')) {
        return res.json([
          {
            id: 'membership_dev_001',
            user_id: devUserForMembers.id,
            email: devUserForMembers.email,
            first_name: devUserForMembers.firstName,
            last_name: devUserForMembers.lastName,
            role: 'owner',
            status: 'active',
            created_at: new Date().toISOString(),
          },
        ]);
      }

      // Verify user is member of this organization
      const callerMembership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!callerMembership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const requestingUserRole = callerMembership.role;

      // Get all members of the organization (paginate to handle orgs with >100 members)
      // Fetch first page to get type inference, then paginate if needed
      let membershipsPage = await workos!.userManagement.listOrganizationMemberships({
        organizationId: orgId,
        statuses: ['active', 'pending'],
        limit: 100,
      });
      const allMemberships = [...membershipsPage.data];
      while (membershipsPage.listMetadata?.after) {
        membershipsPage = await workos!.userManagement.listOrganizationMemberships({
          organizationId: orgId,
          statuses: ['active', 'pending'],
          after: membershipsPage.listMetadata.after,
          limit: 100,
        });
        allMemberships.push(...membershipsPage.data);
      }

      // Get all mapped WorkOS user IDs from Slack
      const slackDb = new SlackDatabase();
      const mappedWorkosUserIds = await slackDb.getMappedWorkosUserIds();

      // Bulk-fetch local membership data and user-set names in parallel
      const [localMembersResult, localUsersResult] = await Promise.all([
        query<{
          workos_user_id: string;
          seat_type: string;
          first_name: string | null;
          last_name: string | null;
          role: string | null;
        }>(
          'SELECT workos_user_id, seat_type, first_name, last_name, role FROM organization_memberships WHERE workos_organization_id = $1',
          [orgId]
        ),
        query<{
          workos_user_id: string;
          first_name: string | null;
          last_name: string | null;
        }>(
          'SELECT workos_user_id, first_name, last_name FROM users WHERE workos_user_id = ANY($1)',
          [allMemberships.map(m => m.userId)]
        ),
      ]);
      const localMemberMap = new Map(localMembersResult.rows.map(r => [r.workos_user_id, r]));
      const localUserMap = new Map(localUsersResult.rows.map(r => [r.workos_user_id, r]));

      // Fetch user details for each membership
      const members = await Promise.all(
        allMemberships.map(async (membership) => {
          const localMember = localMemberMap.get(membership.userId);
          const localUser = localUserMap.get(membership.userId);
          try {
            const memberUser = await workos!.userManagement.getUser(membership.userId);
            // Prefer local user names > local membership names > WorkOS names
            const firstName = localUser?.first_name ?? localMember?.first_name ?? memberUser.firstName ?? null;
            const lastName = localUser?.last_name ?? localMember?.last_name ?? memberUser.lastName ?? null;
            return {
              id: membership.id,
              user_id: membership.userId,
              email: memberUser.email,
              first_name: firstName,
              last_name: lastName,
              role: membership.role?.slug || localMember?.role || 'member',
              status: membership.status,
              created_at: membership.createdAt,
              slack_linked: mappedWorkosUserIds.has(membership.userId),
              seat_type: localMember?.seat_type ?? 'community_only',
            };
          } catch (error) {
            // User might have been deleted
            logger.warn({ membershipId: membership.id, userId: membership.userId }, 'Failed to fetch user for membership');
            return {
              id: membership.id,
              user_id: membership.userId,
              email: 'Unknown',
              first_name: localUser?.first_name ?? localMember?.first_name ?? null,
              last_name: localUser?.last_name ?? localMember?.last_name ?? null,
              role: membership.role?.slug || localMember?.role || 'member',
              status: membership.status,
              created_at: membership.createdAt,
              slack_linked: false,
              seat_type: localMember?.seat_type ?? 'community_only',
            };
          }
        })
      );

      // Get pending invitations for this organization
      const invitations = await collectWorkOSPages((after) =>
        workos!.userManagement.listInvitations({
          organizationId: orgId,
          limit: 100,
          after,
        })
      );

      // Fetch seat types for pending invitations
      const invSeatResult = await query<{ email: string; seat_type: string }>(
        'SELECT email, seat_type FROM invitation_seat_types WHERE workos_organization_id = $1',
        [orgId]
      );
      const invSeatMap = new Map(invSeatResult.rows.map(r => [r.email.toLowerCase(), r.seat_type]));

      const pendingInvitations = invitations
        .filter(inv => inv.state === 'pending')
        .map(inv => ({
          id: inv.id,
          email: inv.email,
          state: inv.state,
          expires_at: inv.expiresAt,
          created_at: inv.createdAt,
          inviter_user_id: inv.inviterUserId,
          seat_type: invSeatMap.get(inv.email.toLowerCase()) || 'community_only',
        }));

      // Include seat usage and limits only for admins/owners
      const isAdmin = requestingUserRole === 'admin' || requestingUserRole === 'owner';
      let seatInfo: { seat_usage?: { contributor: number; community_only: number }; seat_limits?: { contributor: number; community: number } } = {};
      if (isAdmin) {
        const seatUsage = await getSeatUsage(orgId);
        const localOrg = await orgDb.getOrganization(orgId);
        seatInfo = {
          seat_usage: seatUsage,
          seat_limits: getSeatLimits(resolveMembershipTier(localOrg)),
        };
      }

      res.json({
        members,
        pending_invitations: pendingInvitations,
        ...seatInfo,
      });
    } catch (error) {
      logger.error({ err: error }, 'List organization members error');
      res.status(500).json({
        error: 'Failed to list organization members',
      });
    }
  });

  // GET /api/organizations/:orgId/roles - List available roles for the organization
  router.get('/:orgId/roles', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary: ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_ROLES_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
      });

      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_ROLES_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
      } else {
        // Kill-switch/default path: retain the shipped canonical-user decision.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }
      }

      // Get available roles from WorkOS
      const roles = await workos!.authorization.listOrganizationRoles(orgId);

      res.json({
        roles: roles.data.map(role => ({
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'List organization roles error');

      // If roles aren't configured, return default roles
      if (error instanceof Error && error.message.includes('not found')) {
        return res.json({
          roles: [
            { slug: 'owner', name: 'Owner', description: 'Full access to all organization settings' },
            { slug: 'admin', name: 'Admin', description: 'Can manage members and settings' },
            { slug: 'member', name: 'Member', description: 'Standard member access' },
          ],
        });
      }

      res.status(500).json({
        error: 'Failed to list roles',
      });
    }
  });

  // =========================================================================
  // REFERRAL CODES
  // =========================================================================

  // POST /api/organizations/:orgId/referral-codes - Create a referral code
  // Each code is single-use and expires in 30 days.
  router.post('/:orgId/referral-codes', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { target_org_id } = req.body;

      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }

      if (!isDevModeEnabled()) {
        if (!await orgDb.hasActiveSubscription(orgId)) {
          return res.status(402).json({ error: 'An active membership is required to create referral codes' });
        }
      }

      // Look up target org name when a prospect org is specified
      let target_company_name: string | undefined;
      if (target_org_id) {
        const pool = getPool();
        const orgResult = await pool.query<{ name: string; prospect_status: string | null }>(
          `SELECT name, prospect_status FROM organizations WHERE workos_organization_id = $1`,
          [target_org_id]
        );
        if (orgResult.rows.length === 0) {
          return res.status(400).json({ error: 'Target organization not found' });
        }
        if (!orgResult.rows[0].prospect_status) {
          return res.status(400).json({ error: 'Target organization is not a prospect' });
        }
        target_company_name = orgResult.rows[0].name;
      }

      // Hardcode: single-use, 30-day expiry
      const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const code = await referralDb.createReferralCode({
        referrer_org_id: orgId,
        referrer_user_id: user.id,
        referrer_user_name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
        referrer_user_email: user.email,
        target_company_name,
        target_org_id: target_org_id || undefined,
        max_uses: 1,
        expires_at,
      });

      // Add creator as "interested" stakeholder on the target prospect (best-effort)
      if (target_org_id) {
        const pool = getPool();
        const notes = `Created referral code ${code.code}`;
        const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
        pool.query(
          `INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
           VALUES ($1, $2, $3, $4, 'interested', $5)
           ON CONFLICT (organization_id, user_id) DO NOTHING`,
          [target_org_id, user.id, userName, user.email || null, notes]
        ).catch(err => logger.warn({ err }, 'Failed to add stakeholder on referral code creation'));
      }

      res.json({ referral_code: code });
    } catch (error) {
      logger.error({ err: error }, 'Error creating referral code');
      res.status(500).json({ error: 'Failed to create referral code' });
    }
  });

  // GET /api/organizations/:orgId/referral-codes - List codes and referral activity
  router.get('/:orgId/referral-codes', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      const canaryDecision = await evaluateOrganizationAuthorizationCanary({
        boundary: ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_REFERRAL_CODES_READ,
        principal: user,
        organizationId: orgId,
        getWorkos: getAuthorizationEnforcementWorkos,
        minimumRole: 'member',
      });

      if (canaryDecision.enforced) {
        recordOrganizationAuthorizationCanaryDecision(
          ORGANIZATION_AUTHORIZATION_BOUNDARIES.ORGANIZATION_REFERRAL_CODES_READ,
          canaryDecision,
        );
        if (canaryDecision.status === 'unavailable') {
          return res.status(503).json({
            error: 'Authorization temporarily unavailable',
            message: 'Organization access could not be verified. Please retry.',
          });
        }
        if (canaryDecision.status === 'forbidden') {
          return res.status(403).json({ error: 'You are not a member of this organization' });
        }
      } else {
        // Kill-switch/default path: retain the shipped canonical-user decision.
        const membership = await resolveUserOrgMembership(workos, user.id, orgId);
        if (!membership) {
          return res.status(403).json({ error: 'You are not a member of this organization' });
        }
      }

      const rows = await referralDb.listReferralCodes(orgId);

      // Group referrals under their codes
      const codesMap = new Map<number, {
        code: string;
        target_company_name: string | null;
        discount_percent: number | null;
        max_uses: number | null;
        used_count: number;
        status: string;
        expires_at: Date | null;
        created_at: Date;
        referrals: Array<{
          referred_org_id: string | null;
          referred_org_name: string | null;
          referred_org_membership_tier: string | null;
          converted_at: Date | null;
          referred_at: Date | null;
        }>;
      }>();

      for (const row of rows) {
        if (!codesMap.has(row.code_id)) {
          codesMap.set(row.code_id, {
            code: row.code,
            target_company_name: row.target_company_name,
            discount_percent: row.discount_percent,
            max_uses: row.max_uses,
            used_count: row.used_count,
            status: row.code_status,
            expires_at: row.expires_at,
            created_at: row.code_created_at,
            referrals: [],
          });
        }

        if (row.referral_id) {
          codesMap.get(row.code_id)!.referrals.push({
            referred_org_id: row.referred_org_id,
            referred_org_name: row.referred_org_name,
            referred_org_membership_tier: row.referred_org_membership_tier,
            converted_at: row.converted_at,
            referred_at: row.referred_at,
          });
        }
      }

      res.json({ referral_codes: Array.from(codesMap.values()) });
    } catch (error) {
      logger.error({ err: error }, 'Error listing referral codes');
      res.status(500).json({ error: 'Failed to list referral codes' });
    }
  });

  // DELETE /api/organizations/:orgId/referral-codes/:codeId - Revoke a referral code
  router.delete('/:orgId/referral-codes/:codeId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, codeId } = req.params;

      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({ error: 'You are not a member of this organization' });
      }

      const revoked = await referralDb.revokeReferralCode(parseInt(codeId, 10), orgId);

      if (!revoked) {
        return res.status(404).json({ error: 'Referral code not found or already revoked' });
      }

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Error revoking referral code');
      res.status(500).json({ error: 'Failed to revoke referral code' });
    }
  });

  // =========================================================================
  // SEAT UPGRADE REQUESTS
  // =========================================================================

  // GET /api/organizations/:orgId/seat-requests - List seat upgrade requests
  router.get('/:orgId/seat-requests', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is a member of this org
      const membership = await resolveUserOrgMembership(workos, user.id, orgId);
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = membership.role;
      const isAdmin = userRole === 'admin' || userRole === 'owner';

      // Admins see all pending requests; members see their own
      const requests = isAdmin
        ? await listSeatUpgradeRequests(orgId, { status: 'pending' })
        : await listSeatUpgradeRequests(orgId, { userId: user.id });

      res.json({ requests });
    } catch (error) {
      logger.error({ err: error }, 'List seat upgrade requests error');
      res.status(500).json({ error: 'Failed to list seat upgrade requests' });
    }
  });

  return router;
}
