/**
 * Organization routes module
 *
 * This module contains organization-related routes extracted from http.ts.
 * Includes organization management, join requests, team management,
 * member invitations, and role management.
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { getPool } from "../db/client.js";
import { createLogger } from "../logger.js";
import {
  requireAuth,
  isDevModeEnabled,
  getDevUser,
} from "../middleware/auth.js";
import { invitationRateLimiter, orgCreationRateLimiter } from "../middleware/rate-limit.js";
import { validateOrganizationName, validateEmail } from "../middleware/validation.js";
import { OrganizationDatabase, CompanyType, RevenueTier } from "../db/organization-db.js";
import { JoinRequestDatabase } from "../db/join-request-db.js";
import { SlackDatabase } from "../db/slack-db.js";
import { getCompanyDomain } from "../utils/email-domain.js";
import {
  createStripeCustomer,
  createCustomerPortalSession,
  getSubscriptionInfo,
} from "../billing/stripe-client.js";
import {
  notifyJoinRequest,
  notifyMemberAdded,
} from "../slack/org-group-dm.js";

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
        message: error instanceof Error ? error.message : 'Unknown error',
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      // Verify user is admin/owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/organizations/:orgId/pending-count - Get count of pending join requests (admin only)
  router.get('/:orgId/pending-count', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is admin/owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/organizations/:orgId/join-requests/:requestId/approve - Approve a join request (admin only)
  router.post('/:orgId/join-requests/:requestId/approve', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, requestId } = req.params;
      const { role = 'member' } = req.body;

      // Validate role - only allow member or admin, not owner
      if (role !== 'member' && role !== 'admin') {
        return res.status(400).json({
          error: 'Invalid role',
          message: 'Role must be either "member" or "admin"',
        });
      }

      // Verify user is admin/owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can approve join requests',
        });
      }

      const joinRequestDb = new JoinRequestDatabase();

      // Get the request
      const request = await joinRequestDb.getRequest(requestId);
      if (!request || request.workos_organization_id !== orgId) {
        return res.status(404).json({
          error: 'Request not found',
          message: 'No pending join request found with this ID',
        });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({
          error: 'Request not pending',
          message: 'This join request has already been processed',
        });
      }

      // Send invitation via WorkOS
      await workos!.userManagement.sendInvitation({
        email: request.user_email,
        organizationId: orgId,
        inviterUserId: user.id,
        roleSlug: role,
      });

      // Mark request as approved
      await joinRequestDb.approveRequest(requestId, user.id);

      logger.info({
        adminId: user.id,
        requestId,
        orgId,
        requesterId: request.workos_user_id,
        email: request.user_email,
      }, 'Join request approved');

      // Record audit log for join request approval
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'join_request_approved',
        resource_type: 'join_request',
        resource_id: requestId,
        details: {
          requester_user_id: request.workos_user_id,
          requester_email: request.user_email,
          role_assigned: role,
        },
      });

      // Notify org admins via Slack group DM (fire-and-forget)
      (async () => {
        try {
          // Get org name and admin emails
          let orgName = 'Organization';
          try {
            const org = await workos!.organizations.getOrganization(orgId);
            orgName = org.name;
          } catch {
            // Org may not exist
          }

          // Get org admins/owners
          const orgMemberships = await workos!.userManagement.listOrganizationMemberships({
            organizationId: orgId,
          });
          const adminEmails: string[] = [];
          for (const membership of orgMemberships.data) {
            if (membership.role?.slug === 'admin' || membership.role?.slug === 'owner') {
              try {
                const adminUser = await workos!.userManagement.getUser(membership.userId);
                if (adminUser.email) {
                  adminEmails.push(adminUser.email);
                }
              } catch {
                // Skip if can't fetch user
              }
            }
          }

          if (adminEmails.length > 0) {
            await notifyMemberAdded({
              orgId,
              orgName,
              adminEmails,
              memberEmail: request.user_email,
              memberFirstName: request.first_name || undefined,
              memberLastName: request.last_name || undefined,
              role,
            });
          }
        } catch (err) {
          logger.warn({ err, orgId }, 'Failed to notify admins of new member');
        }
      })();

      res.json({
        success: true,
        message: `Invitation sent to ${request.user_email}`,
      });
    } catch (error) {
      logger.error({ err: error }, 'Approve join request error:');

      // Check for specific WorkOS errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('already a member')) {
        return res.status(400).json({
          error: 'User already a member',
          message: 'This user is already a member of the organization',
        });
      }
      if (errorMessage.includes('pending invitation')) {
        return res.status(400).json({
          error: 'Invitation exists',
          message: 'There is already a pending invitation for this user',
        });
      }

      res.status(500).json({
        error: 'Failed to approve join request',
        message: errorMessage,
      });
    }
  });

  // POST /api/organizations/:orgId/join-requests/:requestId/reject - Reject a join request (admin only)
  router.post('/:orgId/join-requests/:requestId/reject', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, requestId } = req.params;
      const { reason } = req.body;

      // Verify user is admin/owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can reject join requests',
        });
      }

      const joinRequestDb = new JoinRequestDatabase();

      // Get the request
      const request = await joinRequestDb.getRequest(requestId);
      if (!request || request.workos_organization_id !== orgId) {
        return res.status(404).json({
          error: 'Request not found',
          message: 'No pending join request found with this ID',
        });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({
          error: 'Request not pending',
          message: 'This join request has already been processed',
        });
      }

      // Mark request as rejected
      await joinRequestDb.rejectRequest(requestId, user.id, reason);

      logger.info({
        adminId: user.id,
        requestId,
        orgId,
        requesterId: request.workos_user_id,
        reason,
      }, 'Join request rejected');

      // Record audit log for join request rejection
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'join_request_rejected',
        resource_type: 'join_request',
        resource_id: requestId,
        details: {
          requester_user_id: request.workos_user_id,
          requester_email: request.user_email,
          reason: reason || null,
        },
      });

      res.json({
        success: true,
        message: 'Join request rejected',
      });
    } catch (error) {
      logger.error({ err: error }, 'Reject join request error:');
      res.status(500).json({
        error: 'Failed to reject join request',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      // Verify user is a member of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Get domains from database
      const pool = getPool();
      const result = await pool.query(
        `SELECT domain, verified, is_primary
         FROM organization_domains
         WHERE workos_organization_id = $1
         ORDER BY is_primary DESC, domain ASC`,
        [orgId]
      );

      res.json({
        domains: result.rows.map(r => ({
          domain: r.domain,
          verified: r.verified,
          is_primary: r.is_primary,
        })),
      });
    } catch (error) {
      logger.error({ err: error }, 'Get org domains error:');
      res.status(500).json({
        error: 'Failed to get domains',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/organizations/:orgId/domain-users - Get Slack users from verified domains not in org (admin only)
  router.get('/:orgId/domain-users', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is admin/owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can view domain users',
        });
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

      // Get current org members' emails
      const allMemberships = await workos!.userManagement.listOrganizationMemberships({
        organizationId: orgId,
      });
      const memberEmails = new Set<string>();
      for (const membership of allMemberships.data) {
        try {
          const memberUser = await workos!.userManagement.getUser(membership.userId);
          if (memberUser.email) {
            memberEmails.add(memberUser.email.toLowerCase());
          }
        } catch {
          // Skip if can't fetch user
        }
      }

      // Get Slack users from these domains who aren't members
      const domainUsers: Array<{
        slack_email: string;
        slack_real_name: string | null;
        slack_display_name: string | null;
      }> = [];

      const slackUsersResult = await pool.query(
        `SELECT slack_email, slack_real_name, slack_display_name
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
          domainUsers.push({
            slack_email: row.slack_email,
            slack_real_name: row.slack_real_name,
            slack_display_name: row.slack_display_name,
          });
        }
      }

      res.json({ users: domainUsers });
    } catch (error) {
      logger.error({ err: error }, 'Get domain users error:');
      res.status(500).json({
        error: 'Failed to get domain users',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/organizations/:orgId/domain-verification-link - Generate WorkOS portal link for domain verification
  router.post('/:orgId/domain-verification-link', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is member of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Generate portal link for domain verification
      const { link } = await workos!.portal.generateLink({
        organization: orgId,
        intent: 'domain_verification' as any,
      });

      logger.info({ organizationId: orgId, userId: user.id }, 'Generated domain verification portal link');

      res.json({ link });
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate domain verification link');
      res.status(500).json({
        error: 'Failed to generate domain verification link',
        message: error instanceof Error ? error.message : 'Unknown error',
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
      const { organization_name, is_personal, company_type, revenue_tier } = req.body;

      // Validate required fields
      if (!organization_name) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'organization_name is required',
        });
      }

      // Validate organization name format
      const nameValidation = validateOrganizationName(organization_name);
      if (!nameValidation.valid) {
        return res.status(400).json({
          error: 'Invalid organization name',
          message: nameValidation.error,
        });
      }

      // Validate company_type if provided
      const validCompanyTypes = ['brand', 'publisher', 'agency', 'adtech', 'other'];
      if (company_type && !validCompanyTypes.includes(company_type)) {
        return res.status(400).json({
          error: 'Invalid company type',
          message: `company_type must be one of: ${validCompanyTypes.join(', ')}`,
        });
      }

      // Validate revenue_tier if provided
      const validRevenueTiers = ['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'];
      if (revenue_tier && !validRevenueTiers.includes(revenue_tier)) {
        return res.status(400).json({
          error: 'Invalid revenue tier',
          message: `revenue_tier must be one of: ${validRevenueTiers.join(', ')}`,
        });
      }

      // Use trimmed name for consistency
      const trimmedName = organization_name.trim();

      logger.info({ organization_name: trimmedName, is_personal, company_type, revenue_tier }, 'Creating WorkOS organization');

      let workosOrgId: string;
      let workosOrgName: string;

      // Dev mode: skip WorkOS calls and generate a mock org ID
      const isDevUser = isDevModeEnabled() && getDevUser(req);
      if (isDevUser) {
        workosOrgId = `org_dev_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        workosOrgName = trimmedName;
        logger.info({ orgId: workosOrgId, name: trimmedName, devUser: user.email }, 'DEV MODE: Mock organization created (no WorkOS)');
      } else {
        // Create WorkOS Organization
        const workosOrg = await workos!.organizations.createOrganization({
          name: trimmedName,
        });
        workosOrgId = workosOrg.id;
        workosOrgName = workosOrg.name;

        logger.info({ orgId: workosOrgId, name: trimmedName }, 'WorkOS organization created');

        // Add user as organization owner (since they created it)
        await workos!.userManagement.createOrganizationMembership({
          userId: user.id,
          organizationId: workosOrgId,
          roleSlug: 'owner',
        });

        logger.info({ userId: user.id, orgId: workosOrgId }, 'User added as organization owner');
      }

      // Create organization record in our database
      const orgRecord = await orgDb.createOrganization({
        workos_organization_id: workosOrgId,
        name: trimmedName,
        is_personal: is_personal || false,
        company_type: company_type || undefined,
        revenue_tier: revenue_tier || undefined,
      });

      logger.info({
        orgId: workosOrgId,
        company_type: orgRecord.company_type,
        revenue_tier: orgRecord.revenue_tier,
      }, 'Organization record created in database');

      // Record audit log for organization creation
      await orgDb.recordAuditLog({
        workos_organization_id: workosOrgId,
        workos_user_id: user.id,
        action: 'organization_created',
        resource_type: 'organization',
        resource_id: workosOrgId,
        details: {
          name: trimmedName,
          is_personal: is_personal || false,
          company_type: company_type || null,
          revenue_tier: revenue_tier || null,
        },
      });

      // Record ToS and Privacy Policy acceptance
      const tosAgreement = await orgDb.getCurrentAgreementByType('terms_of_service');
      const privacyAgreement = await orgDb.getCurrentAgreementByType('privacy_policy');

      if (tosAgreement) {
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id: user.id,
          email: user.email,
          agreement_type: 'terms_of_service',
          agreement_version: tosAgreement.version,
          ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
          user_agent: req.headers['user-agent'] || 'unknown',
          workos_organization_id: workosOrgId,
        });
      }

      if (privacyAgreement) {
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id: user.id,
          email: user.email,
          agreement_type: 'privacy_policy',
          agreement_version: privacyAgreement.version,
          ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
          user_agent: req.headers['user-agent'] || 'unknown',
          workos_organization_id: workosOrgId,
        });
      }

      res.json({
        success: true,
        organization: {
          id: workosOrgId,
          name: workosOrgName,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Create organization error');

      // Provide more helpful error messages for common WorkOS errors
      let errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('state should not be empty')) {
        errorMessage = 'WorkOS configuration error: Organizations require additional setup in WorkOS Dashboard. Please contact support or check your WorkOS settings.';
      }

      res.status(500).json({
        error: 'Failed to create organization',
        message: errorMessage,
      });
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
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      const membership = memberships.data[0];
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Only owners and admins can rename
      const roleSlug = (membership as any).role?.slug || (membership as any).roleSlug;
      if (roleSlug !== 'owner' && roleSlug !== 'admin') {
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

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'organization_renamed',
        resource_type: 'organization',
        resource_id: orgId,
        details: { new_name: trimmedName },
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PATCH /api/organizations/:orgId/settings - Update organization settings (company_type, revenue_tier)
  router.patch('/:orgId/settings', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { company_type, revenue_tier } = req.body;

      // Verify user is member of this organization with owner or admin role
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      const membership = memberships.data[0];
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Only owners and admins can update settings
      const roleSlug = (membership as any).role?.slug || (membership as any).roleSlug;
      if (roleSlug !== 'owner' && roleSlug !== 'admin') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only organization owners and admins can update settings',
        });
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

      // Validate company_type if provided
      const validCompanyTypes = ['brand', 'publisher', 'agency', 'adtech', 'other'];
      if (company_type !== undefined && company_type !== null && !validCompanyTypes.includes(company_type)) {
        return res.status(400).json({
          error: 'Invalid company type',
          message: `company_type must be one of: ${validCompanyTypes.join(', ')}`,
        });
      }

      // Validate revenue_tier if provided
      const validRevenueTiers = ['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'];
      if (revenue_tier !== undefined && revenue_tier !== null && !validRevenueTiers.includes(revenue_tier)) {
        return res.status(400).json({
          error: 'Invalid revenue tier',
          message: `revenue_tier must be one of: ${validRevenueTiers.join(', ')}`,
        });
      }

      // Build updates object with properly typed values
      const updates: {
        company_type?: CompanyType | null;
        revenue_tier?: RevenueTier | null;
      } = {};
      if (company_type !== undefined) {
        updates.company_type = company_type as CompanyType | null;
      }
      if (revenue_tier !== undefined) {
        updates.revenue_tier = revenue_tier as RevenueTier | null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error: 'No updates provided',
          message: 'Provide company_type or revenue_tier to update',
        });
      }

      // Update in our database
      await orgDb.updateOrganization(orgId, updates);

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'organization_settings_updated',
        resource_type: 'organization',
        resource_id: orgId,
        details: updates,
      });

      logger.info({ orgId, updates, userId: user.id }, 'Organization settings updated');

      res.json({
        success: true,
        company_type: company_type !== undefined ? company_type : org.company_type,
        revenue_tier: revenue_tier !== undefined ? revenue_tier : org.revenue_tier,
      });
    } catch (error) {
      logger.error({ err: error }, 'Update organization settings error');
      res.status(500).json({
        error: 'Failed to update organization settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/organizations/:orgId - Delete own workspace (owner only)
  // Cannot delete if workspace has any payment history
  router.delete('/:orgId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { confirmation } = req.body;

      // Verify user is owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      const membership = memberships.data[0];
      if (!membership) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Only owners can delete
      const roleSlug = (membership as any).role?.slug || (membership as any).roleSlug;
      if (roleSlug !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only the organization owner can delete the workspace',
        });
      }

      // Get organization from database
      const pool = getPool();
      const orgResult = await pool.query(
        'SELECT workos_organization_id, name, stripe_customer_id FROM organizations WHERE workos_organization_id = $1',
        [orgId]
      );

      if (orgResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Organization not found',
          message: 'The specified organization does not exist',
        });
      }

      const org = orgResult.rows[0];

      // Check if organization has any payment history
      const revenueResult = await pool.query(
        'SELECT COUNT(*) as count FROM revenue_events WHERE workos_organization_id = $1',
        [orgId]
      );

      const hasPayments = parseInt(revenueResult.rows[0].count) > 0;

      if (hasPayments) {
        return res.status(400).json({
          error: 'Cannot delete paid workspace',
          message: 'This workspace has payment history and cannot be deleted. Please contact support if you need to remove this workspace.',
          has_payments: true,
        });
      }

      // Check for active Stripe subscription
      if (org.stripe_customer_id) {
        const subscriptionInfo = await getSubscriptionInfo(org.stripe_customer_id);
        if (subscriptionInfo && (subscriptionInfo.status === 'active' || subscriptionInfo.status === 'past_due')) {
          return res.status(400).json({
            error: 'Cannot delete workspace with active subscription',
            message: 'This workspace has an active subscription. Please cancel the subscription first before deleting the workspace.',
            has_active_subscription: true,
            subscription_status: subscriptionInfo.status,
          });
        }
      }

      // Require confirmation by typing the organization name
      if (!confirmation || confirmation !== org.name) {
        return res.status(400).json({
          error: 'Confirmation required',
          message: `To delete this workspace, please provide the exact name "${org.name}" in the confirmation field.`,
          requires_confirmation: true,
          organization_name: org.name,
        });
      }

      // Record audit log before deletion (while org still exists)
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'organization_deleted',
        resource_type: 'organization',
        resource_id: orgId,
        details: { name: org.name, deleted_by: 'self_service', user_email: user.email },
      });

      // Delete from WorkOS
      try {
        await workos!.organizations.deleteOrganization(orgId);
        logger.info({ orgId, name: org.name, userId: user.id }, 'Deleted organization from WorkOS');
      } catch (workosError) {
        logger.warn({ err: workosError, orgId }, 'Failed to delete organization from WorkOS - continuing with local deletion');
      }

      // Delete from local database (cascades to related tables)
      await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [orgId]);

      logger.info({ orgId, name: org.name, userId: user.id, userEmail: user.email }, 'User deleted their own organization');

      res.json({
        success: true,
        message: `Workspace "${org.name}" has been deleted`,
        deleted_org_id: orgId,
      });
    } catch (error) {
      logger.error({ err: error }, 'Delete organization error');
      res.status(500).json({
        error: 'Failed to delete organization',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // =========================================================================
  // BILLING
  // =========================================================================

  // POST /api/organizations/:orgId/billing/portal - Create Customer Portal session
  router.post('/:orgId/billing/portal', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is member of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
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

      // Create Stripe customer if needed
      let stripeCustomerId = org.stripe_customer_id;
      if (!stripeCustomerId) {
        logger.info({ orgId }, 'Creating Stripe customer for organization');
        stripeCustomerId = await createStripeCustomer({
          email: user.email,
          name: org.name,
          metadata: {
            workos_organization_id: orgId,
          },
        });

        if (!stripeCustomerId) {
          return res.status(500).json({
            error: 'Failed to create billing account',
            message: 'Could not create Stripe customer',
          });
        }

        // Save Stripe customer ID
        await orgDb.setStripeCustomerId(orgId, stripeCustomerId);
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      // Verify user is member of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Ensure organization exists in local DB (on-demand sync from WorkOS)
      let org = await orgDb.getOrganization(orgId);
      if (!org) {
        try {
          const workosOrg = await workos!.organizations.getOrganization(orgId);
          if (workosOrg) {
            org = await orgDb.createOrganization({
              workos_organization_id: workosOrg.id,
              name: workosOrg.name,
            });
            logger.info({ orgId, name: workosOrg.name }, 'On-demand synced organization from WorkOS for pending agreement');
          }
        } catch (syncError) {
          logger.warn({ orgId, err: syncError }, 'Failed to sync organization from WorkOS');
        }
      }

      if (!org) {
        return res.status(404).json({
          error: 'Organization not found',
          message: 'Could not find or sync organization',
        });
      }

      // Store pending agreement info in organization record
      // This will be used by webhook when subscription is created
      await orgDb.updateOrganization(orgId, {
        pending_agreement_version: agreement_version,
        pending_agreement_accepted_at: agreement_accepted_at ? new Date(agreement_accepted_at) : new Date(),
      });

      logger.info({
        orgId,
        userId: user.id,
        version: agreement_version
      }, 'Pending agreement info stored (will be recorded on payment success)');

      res.json({
        success: true,
        agreement_version,
        accepted_at: new Date().toISOString(),
      });

    } catch (error) {
      logger.error({ err: error }, 'Accept membership agreement error:');
      res.status(500).json({
        error: 'Failed to record agreement acceptance',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/organizations/:orgId/convert-to-team - Convert personal workspace to team
  router.post('/:orgId/convert-to-team', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is owner of this organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (memberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      const userRole = memberships.data[0].role?.slug || 'member';
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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
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
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Get all members of the organization
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        organizationId: orgId,
        statuses: ['active', 'pending'],
      });

      // Get all mapped WorkOS user IDs from Slack
      const slackDb = new SlackDatabase();
      const mappedWorkosUserIds = await slackDb.getMappedWorkosUserIds();

      // Fetch user details for each membership
      const members = await Promise.all(
        memberships.data.map(async (membership) => {
          try {
            const memberUser = await workos!.userManagement.getUser(membership.userId);
            return {
              id: membership.id,
              user_id: membership.userId,
              email: memberUser.email,
              first_name: memberUser.firstName || null,
              last_name: memberUser.lastName || null,
              role: membership.role?.slug || 'member',
              status: membership.status,
              created_at: membership.createdAt,
              slack_linked: mappedWorkosUserIds.has(membership.userId),
            };
          } catch (error) {
            // User might have been deleted
            logger.warn({ membershipId: membership.id, userId: membership.userId }, 'Failed to fetch user for membership');
            return {
              id: membership.id,
              user_id: membership.userId,
              email: 'Unknown',
              first_name: null,
              last_name: null,
              role: membership.role?.slug || 'member',
              status: membership.status,
              created_at: membership.createdAt,
              slack_linked: false,
            };
          }
        })
      );

      // Get pending invitations for this organization
      const invitations = await workos!.userManagement.listInvitations({
        organizationId: orgId,
      });

      const pendingInvitations = invitations.data
        .filter(inv => inv.state === 'pending')
        .map(inv => ({
          id: inv.id,
          email: inv.email,
          state: inv.state,
          expires_at: inv.expiresAt,
          created_at: inv.createdAt,
          inviter_user_id: inv.inviterUserId,
        }));

      res.json({
        members,
        pending_invitations: pendingInvitations,
      });
    } catch (error) {
      logger.error({ err: error }, 'List organization members error');
      res.status(500).json({
        error: 'Failed to list organization members',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/organizations/:orgId/invitations - Invite a new member
  router.post('/:orgId/invitations', requireAuth, invitationRateLimiter, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;
      const { email, role } = req.body;

      if (!email) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'email is required',
        });
      }

      // Validate email format
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        return res.status(400).json({
          error: 'Invalid email',
          message: emailValidation.error,
        });
      }

      // Validate role if provided
      const validRoles = ['member', 'admin', 'owner'];
      if (role && !validRoles.includes(role)) {
        return res.status(400).json({
          error: 'Invalid role',
          message: `Role must be one of: ${validRoles.join(', ')}`,
        });
      }

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Check user's role - only admins or owners can invite
      const userRole = userMemberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can invite new members',
        });
      }

      // Send invitation via WorkOS
      const invitation = await workos!.userManagement.sendInvitation({
        email,
        organizationId: orgId,
        inviterUserId: user.id,
        roleSlug: role || 'member',
      });

      logger.info({ orgId, email, inviterId: user.id }, 'Invitation sent');

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'member_invited',
        resource_type: 'invitation',
        resource_id: invitation.id,
        details: { email, role: role || 'member' },
      });

      res.json({
        success: true,
        invitation: {
          id: invitation.id,
          email: invitation.email,
          state: invitation.state,
          expires_at: invitation.expiresAt,
          accept_invitation_url: invitation.acceptInvitationUrl,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Send invitation error');

      // Check for specific WorkOS errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('already a member')) {
        return res.status(400).json({
          error: 'User already a member',
          message: 'This user is already a member of the organization',
        });
      }
      if (errorMessage.includes('pending invitation')) {
        return res.status(400).json({
          error: 'Invitation already exists',
          message: 'An invitation has already been sent to this email address',
        });
      }

      res.status(500).json({
        error: 'Failed to send invitation',
        message: errorMessage,
      });
    }
  });

  // DELETE /api/organizations/:orgId/invitations/:invitationId - Revoke an invitation
  router.delete('/:orgId/invitations/:invitationId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, invitationId } = req.params;

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Check user's role - only admins or owners can revoke invitations
      const userRole = userMemberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can revoke invitations',
        });
      }

      // Verify invitation belongs to this organization
      const invitation = await workos!.userManagement.getInvitation(invitationId);
      if (invitation.organizationId !== orgId) {
        return res.status(404).json({
          error: 'Invitation not found',
          message: 'This invitation does not belong to this organization',
        });
      }

      // Revoke the invitation
      await workos!.userManagement.revokeInvitation(invitationId);

      logger.info({ orgId, invitationId, revokerId: user.id }, 'Invitation revoked');

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'invitation_revoked',
        resource_type: 'invitation',
        resource_id: invitationId,
        details: { email: invitation.email },
      });

      res.json({
        success: true,
        message: 'Invitation revoked successfully',
      });
    } catch (error) {
      logger.error({ err: error }, 'Revoke invitation error');
      res.status(500).json({
        error: 'Failed to revoke invitation',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/organizations/:orgId/invitations/:invitationId/resend - Resend an invitation
  router.post('/:orgId/invitations/:invitationId/resend', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, invitationId } = req.params;

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Check user's role - only admins or owners can resend invitations
      const userRole = userMemberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can resend invitations',
        });
      }

      // Get the invitation to verify it belongs to this org
      const invitation = await workos!.userManagement.getInvitation(invitationId);
      if (invitation.organizationId !== orgId) {
        return res.status(404).json({
          error: 'Invitation not found',
          message: 'This invitation does not belong to this organization',
        });
      }

      // Revoke the old invitation and send a new one
      await workos!.userManagement.revokeInvitation(invitationId);
      const newInvitation = await workos!.userManagement.sendInvitation({
        email: invitation.email,
        organizationId: orgId,
        inviterUserId: user.id,
        roleSlug: 'member', // Default to member role on resend
      });

      logger.info({ orgId, email: invitation.email, inviterId: user.id }, 'Invitation resent');

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'invitation_resent',
        resource_type: 'invitation',
        resource_id: newInvitation.id,
        details: { email: invitation.email, old_invitation_id: invitationId },
      });

      res.json({
        success: true,
        message: 'Invitation resent successfully',
        invitation: {
          id: newInvitation.id,
          email: newInvitation.email,
          state: newInvitation.state,
          expires_at: newInvitation.expiresAt,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Resend invitation error');
      res.status(500).json({
        error: 'Failed to resend invitation',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PATCH /api/organizations/:orgId/members/:membershipId - Update member role
  router.patch('/:orgId/members/:membershipId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, membershipId } = req.params;
      const { role } = req.body;

      if (!role) {
        return res.status(400).json({
          error: 'Missing required field',
          message: 'role is required',
        });
      }

      // Validate role
      const validRoles = ['member', 'admin', 'owner'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          error: 'Invalid role',
          message: `Role must be one of: ${validRoles.join(', ')}`,
        });
      }

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Check user's role - only owners can change roles
      const userRole = userMemberships.data[0].role?.slug || 'member';
      if (userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only owners can change member roles',
        });
      }

      // Get the target membership
      const membership = await workos!.userManagement.getOrganizationMembership(membershipId);
      if (membership.organizationId !== orgId) {
        return res.status(404).json({
          error: 'Member not found',
          message: 'This member does not belong to this organization',
        });
      }

      // Cannot change own role
      if (membership.userId === user.id) {
        return res.status(400).json({
          error: 'Cannot change own role',
          message: 'You cannot change your own role',
        });
      }

      // Update the role
      const updatedMembership = await workos!.userManagement.updateOrganizationMembership(
        membershipId,
        { roleSlug: role }
      );

      logger.info({ orgId, membershipId, newRole: role, changedBy: user.id }, 'Member role updated');

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'member_role_changed',
        resource_type: 'membership',
        resource_id: membershipId,
        details: {
          target_user_id: membership.userId,
          old_role: membership.role?.slug || 'member',
          new_role: role,
        },
      });

      res.json({
        success: true,
        membership: {
          id: updatedMembership.id,
          user_id: updatedMembership.userId,
          role: updatedMembership.role?.slug || 'member',
          status: updatedMembership.status,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Update member role error');
      res.status(500).json({
        error: 'Failed to update member role',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/organizations/:orgId/members/:membershipId - Remove a member
  router.delete('/:orgId/members/:membershipId', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId, membershipId } = req.params;

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Check user's role - only admins or owners can remove members
      const userRole = userMemberships.data[0].role?.slug || 'member';
      if (userRole !== 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only admins and owners can remove members',
        });
      }

      // Get the target membership
      const membership = await workos!.userManagement.getOrganizationMembership(membershipId);
      if (membership.organizationId !== orgId) {
        return res.status(404).json({
          error: 'Member not found',
          message: 'This member does not belong to this organization',
        });
      }

      // Cannot remove self
      if (membership.userId === user.id) {
        return res.status(400).json({
          error: 'Cannot remove self',
          message: 'You cannot remove yourself from the organization',
        });
      }

      // Only owners can remove admins
      const targetRole = membership.role?.slug || 'member';
      if (targetRole === 'admin' && userRole !== 'owner') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          message: 'Only owners can remove admins',
        });
      }

      // Cannot remove owners
      if (targetRole === 'owner') {
        return res.status(400).json({
          error: 'Cannot remove owner',
          message: 'Organization owners cannot be removed',
        });
      }

      // Get user info for audit log before deletion
      let removedUserEmail = 'Unknown';
      try {
        const removedUser = await workos!.userManagement.getUser(membership.userId);
        removedUserEmail = removedUser.email;
      } catch {
        // User might already be deleted
      }

      // Delete the membership
      await workos!.userManagement.deleteOrganizationMembership(membershipId);

      logger.info({ orgId, membershipId, removedBy: user.id }, 'Member removed');

      // Record audit log
      await orgDb.recordAuditLog({
        workos_organization_id: orgId,
        workos_user_id: user.id,
        action: 'member_removed',
        resource_type: 'membership',
        resource_id: membershipId,
        details: {
          removed_user_id: membership.userId,
          removed_user_email: removedUserEmail,
          removed_role: targetRole,
        },
      });

      res.json({
        success: true,
        message: 'Member removed successfully',
      });
    } catch (error) {
      logger.error({ err: error }, 'Remove member error');
      res.status(500).json({
        error: 'Failed to remove member',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // GET /api/organizations/:orgId/roles - List available roles for the organization
  router.get('/:orgId/roles', requireAuth, async (req, res) => {
    try {
      const user = req.user!;
      const { orgId } = req.params;

      // Verify user is member of this organization
      const userMemberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
        organizationId: orgId,
      });

      if (userMemberships.data.length === 0) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You are not a member of this organization',
        });
      }

      // Get available roles from WorkOS
      const roles = await workos!.organizations.listOrganizationRoles({ organizationId: orgId });

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
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
