/**
 * Member profile routes module
 *
 * This module contains member profile-related routes extracted from http.ts.
 * Includes profile CRUD operations for both authenticated users and admins.
 */

import { Router } from "express";
import { WorkOS } from "@workos-inc/node";
import { createLogger } from "../logger.js";
import {
  requireAuth,
  requireAdmin,
  isDevModeEnabled,
  DEV_USERS,
} from "../middleware/auth.js";
import { query } from "../db/client.js";
import { MemberDatabase } from "../db/member-db.js";
import { BrandDatabase } from "../db/brand-db.js";
import { BrandManager } from "../brand-manager.js";
import { OrganizationDatabase } from "../db/organization-db.js";
import { OrgKnowledgeDatabase } from "../db/org-knowledge-db.js";
import { AAO_HOST } from "../config/aao.js";
import { VALID_MEMBER_OFFERINGS } from "../types.js";
import type { MemberBrandInfo } from "../types.js";

const orgKnowledgeDb = new OrgKnowledgeDatabase();

const logger = createLogger("member-profile-routes");

/**
 * Validate slug format and check against reserved keywords
 */
function isValidSlug(slug: string): boolean {
  const reserved = ['admin', 'api', 'auth', 'dashboard', 'members', 'registry', 'onboarding'];
  if (reserved.includes(slug.toLowerCase())) {
    return false;
  }
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug.toLowerCase());
}

export interface MemberProfileRoutesConfig {
  workos: WorkOS | null;
  memberDb: MemberDatabase;
  brandDb: BrandDatabase;
  orgDb: OrganizationDatabase;
  invalidateMemberContextCache: () => void;
}

/**
 * Resolve brand identity from the brand registry for a given domain.
 * Checks hosted_brands first, then discovered_brands.
 */
async function resolveBrand(brandDb: BrandDatabase, domain: string): Promise<MemberBrandInfo | undefined> {
  const hosted = await brandDb.getHostedBrandByDomain(domain);
  if (hosted) {
    const bj = hosted.brand_json as Record<string, unknown>;
    // house_portfolio: read from brands[0]
    const brands = bj.brands as Array<Record<string, unknown>> | undefined;
    const primaryBrand = brands?.[0];
    const logos = primaryBrand?.logos as Array<Record<string, unknown>> | undefined;
    const colors = primaryBrand?.colors as Record<string, unknown> | undefined;
    return {
      domain,
      logo_url: logos?.[0]?.url as string | undefined,
      brand_color: colors?.primary as string | undefined,
      verified: hosted.domain_verified,
    };
  }

  const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
  if (discovered) {
    const manifest = discovered.brand_manifest as Record<string, unknown> | undefined;
    // house_portfolio: logos are in brands[0].logos; fall back to top-level logos for other structures
    const brands = manifest?.brands as Array<Record<string, unknown>> | undefined;
    const primaryBrand = brands?.[0];
    const logos = (primaryBrand?.logos ?? manifest?.logos) as Array<Record<string, unknown>> | undefined;
    const colors = (primaryBrand?.colors ?? manifest?.colors) as Record<string, unknown> | undefined;
    return {
      domain,
      logo_url: logos?.[0]?.url as string | undefined,
      brand_color: colors?.primary as string | undefined,
      verified: true, // discovered brands have live brand.json
    };
  }

  return undefined;
}

/**
 * Create member profile routes
 * Returns a router for user profile routes (/api/me/member-profile)
 */
export function createMemberProfileRouter(config: MemberProfileRoutesConfig): Router {
  const { workos, memberDb, brandDb, orgDb, invalidateMemberContextCache } = config;
  const router = Router();

  // GET /api/me/member-profile - Get current user's organization's member profile
  router.get('/', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id, org: req.query.org }, 'GET /api/me/member-profile started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;

      // Dev mode: handle dev organizations without WorkOS
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        const profile = await memberDb.getProfileByOrgId(requestedOrgId!);
        if (profile?.primary_brand_domain) {
          profile.resolved_brand = await resolveBrand(brandDb, profile.primary_brand_domain);
        }
        logger.info({ userId: user.id, orgId: requestedOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed (dev mode)');
        return res.json({
          profile: profile || null,
          organization_id: requestedOrgId,
          organization_name: localOrg.name,
        });
      }

      // Get user's organization memberships
      const memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
      });

      if (memberships.data.length === 0) {
        logger.info({ userId: user.id, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile: no organization');
        return res.status(404).json({
          error: 'No organization',
          message: 'User is not a member of any organization',
        });
      }

      // Determine which org to use
      let targetOrgId: string;
      if (requestedOrgId) {
        // Verify user is a member of the requested org
        const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
        if (!isMember) {
          logger.info({ userId: user.id, requestedOrgId, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile: not authorized');
          return res.status(403).json({
            error: 'Not authorized',
            message: 'User is not a member of the requested organization',
          });
        }
        targetOrgId = requestedOrgId;
      } else {
        // Default to first org
        targetOrgId = memberships.data[0].organizationId;
      }

      const profile = await memberDb.getProfileByOrgId(targetOrgId);
      if (profile?.primary_brand_domain) {
        profile.resolved_brand = await resolveBrand(brandDb, profile.primary_brand_domain);
      }

      // Get org name from WorkOS
      const org = await workos!.organizations.getOrganization(targetOrgId);

      logger.info({ userId: user.id, orgId: targetOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed');
      res.json({
        profile: profile || null,
        organization_id: targetOrgId,
        organization_name: org.name,
      });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile error');
      res.status(500).json({
        error: 'Failed to get member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/me/member-profile - Create member profile for current user's organization
  router.post('/', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id, org: req.query.org }, 'POST /api/me/member-profile started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;
      const {
        display_name,
        slug,
        tagline,
        description,
        primary_brand_domain,
        contact_email,
        contact_website,
        contact_phone,
        linkedin_url,
        twitter_url,
        offerings,
        agents,
        headquarters,
        markets,
        tags,
        is_public,
        show_in_carousel,
      } = req.body;

      // Validate required fields
      if (!display_name || !slug) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'display_name and slug are required',
        });
      }

      // Validate slug format and reserved words
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          error: 'Invalid slug',
          message: 'Slug must contain only lowercase letters, numbers, and hyphens, cannot start or end with a hyphen, and cannot be a reserved keyword (admin, api, auth, dashboard, members, registry, onboarding)',
        });
      }

      // Dev mode: handle dev organizations without WorkOS
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      let targetOrgId: string;

      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        targetOrgId = requestedOrgId!;
        logger.info({ userId: user.id, orgId: targetOrgId }, 'POST /api/me/member-profile: dev mode bypass');
      } else {
        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        if (requestedOrgId) {
          // Verify user is admin/owner of the requested org
          const membership = memberships.data.find(m => m.organizationId === requestedOrgId);
          if (!membership) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          const role = membership.role?.slug || 'member';
          if (role !== 'admin' && role !== 'owner') {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'Only admins and owners can create member profiles',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }
      }

      // Check if profile already exists
      const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
      if (existingProfile) {
        return res.status(409).json({
          error: 'Profile already exists',
          message: 'Organization already has a member profile. Use PUT to update.',
        });
      }

      // Check slug availability
      const slugAvailable = await memberDb.isSlugAvailable(slug);
      if (!slugAvailable) {
        return res.status(409).json({
          error: 'Slug not available',
          message: 'This slug is already taken. Please choose a different one.',
        });
      }

      // Validate offerings if provided
      if (offerings && Array.isArray(offerings)) {
        const invalidOfferings = offerings.filter((o: string) => !VALID_MEMBER_OFFERINGS.includes(o as any));
        if (invalidOfferings.length > 0) {
          return res.status(400).json({
            error: 'Invalid offerings',
            message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${VALID_MEMBER_OFFERINGS.join(', ')}`,
          });
        }
      }

      const profile = await memberDb.createProfile({
        workos_organization_id: targetOrgId,
        display_name,
        slug,
        tagline,
        description,
        primary_brand_domain: primary_brand_domain || null,
        contact_email,
        contact_website,
        contact_phone,
        linkedin_url,
        twitter_url,
        offerings: offerings || [],
        agents: agents || [],
        headquarters,
        markets: markets || [],
        tags: tags || [],
        is_public: is_public ?? false,
        show_in_carousel: show_in_carousel ?? false,
      });

      // Write user-reported org knowledge (fire-and-forget)
      const knowledgeWrites: Promise<unknown>[] = [];
      const userId = user.id;

      if (tagline) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'description',
          value: tagline,
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile creation',
        }));
      }

      if (description) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'company_focus',
          value: description,
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile creation',
        }));
      }

      if (offerings && Array.isArray(offerings) && offerings.length > 0) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'interest',
          value: offerings.join(', '),
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile offerings',
        }));
      }

      if (knowledgeWrites.length > 0) {
        Promise.all(knowledgeWrites).catch(err => {
          logger.warn({ err, orgId: targetOrgId }, 'Failed to write profile data to org_knowledge');
        });
      }

      // Invalidate Addie's member context cache - organization profile created
      invalidateMemberContextCache();

      logger.info({ profileId: profile.id, orgId: targetOrgId, slug, durationMs: Date.now() - startTime }, 'POST /api/me/member-profile completed');

      res.status(201).json({ profile });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'POST /api/me/member-profile error');
      res.status(500).json({
        error: 'Failed to create member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/me/member-profile - Update current user's organization's member profile
  router.put('/', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id }, 'PUT /api/me/member-profile started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;
      const updates = req.body;

      // Dev mode: handle dev organizations without WorkOS
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      let targetOrgId: string;

      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        targetOrgId = requestedOrgId!;
        logger.info({ userId: user.id, orgId: targetOrgId }, 'PUT /api/me/member-profile: dev mode bypass');
      } else {
        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        if (requestedOrgId) {
          // Verify user is a member of the requested org
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }
      }

      // Check if profile exists
      const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
      if (!existingProfile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: 'No member profile exists for your organization. Use POST to create one.',
        });
      }

      // Validate offerings if provided
      if (updates.offerings && Array.isArray(updates.offerings)) {
        const invalidOfferings = updates.offerings.filter((o: string) => !VALID_MEMBER_OFFERINGS.includes(o as any));
        if (invalidOfferings.length > 0) {
          return res.status(400).json({
            error: 'Invalid offerings',
            message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${VALID_MEMBER_OFFERINGS.join(', ')}`,
          });
        }
      }

      // Remove fields that shouldn't be updated directly
      delete updates.id;
      delete updates.workos_organization_id;
      delete updates.slug; // Slug changes not allowed via this endpoint
      delete updates.created_at;
      delete updates.updated_at;
      delete updates.featured; // Only admins can set featured

      const profile = await memberDb.updateProfileByOrgId(targetOrgId, updates);

      // Write user-reported org knowledge (fire-and-forget)
      const knowledgeWrites: Promise<unknown>[] = [];
      const userId = user.id;

      if (updates.tagline) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'description',
          value: updates.tagline,
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile update',
        }));
      }

      if (updates.description) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'company_focus',
          value: updates.description,
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile update',
        }));
      }

      if (updates.offerings && Array.isArray(updates.offerings) && updates.offerings.length > 0) {
        knowledgeWrites.push(orgKnowledgeDb.setKnowledge({
          workos_organization_id: targetOrgId,
          attribute: 'interest',
          value: updates.offerings.join(', '),
          source: 'user_reported',
          confidence: 'high',
          set_by_user_id: userId,
          set_by_description: 'Member profile offerings',
        }));
      }

      if (knowledgeWrites.length > 0) {
        Promise.all(knowledgeWrites).catch(err => {
          logger.warn({ err, orgId: targetOrgId }, 'Failed to write profile data to org_knowledge');
        });
      }

      // Invalidate Addie's member context cache - organization profile updated
      invalidateMemberContextCache();

      const duration = Date.now() - startTime;
      logger.info({ profileId: profile?.id, orgId: targetOrgId, durationMs: duration }, 'Member profile updated');

      res.json({ profile });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, durationMs: duration }, 'Update member profile error');
      res.status(500).json({
        error: 'Failed to update member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // POST /api/me/member-profile/verify-brand - Check if member's domain pointer is live and mark verified
  router.post('/verify-brand', requireAuth, async (req, res) => {
    try {
      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [req.user!.id]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) {
        return res.status(400).json({ error: 'No organization associated with this account' });
      }

      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile?.primary_brand_domain) {
        return res.status(400).json({ error: 'No brand domain configured' });
      }

      const domain = profile.primary_brand_domain;
      const brandManager = new BrandManager();
      const result = await brandManager.validateDomain(domain, { skipCache: true });

      if (result.valid && result.variant === 'authoritative_location') {
        const data = result.raw_data as { authoritative_location: string };
        try {
          const url = new URL(data.authoritative_location);
          if (url.hostname === AAO_HOST &&
              url.pathname === `/brands/${domain}/brand.json`) {
            const hosted = await brandDb.getHostedBrandByDomain(domain);
            if (!hosted) {
              return res.json({ domain, verified: false, reason: 'no_hosted_brand' });
            }
            // Block if another org already holds a verified claim on this domain
            if (hosted.domain_verified && hosted.workos_organization_id && hosted.workos_organization_id !== orgId) {
              return res.status(403).json({ error: 'This domain is verified by another organization' });
            }
            // Proof of domain control: transfer ownership and mark verified
            await brandDb.updateHostedBrand(hosted.id, {
              domain_verified: true,
              workos_organization_id: orgId,
            });
            return res.json({ domain, verified: true });
          }
        } catch {
          // Invalid URL in authoritative_location
        }
      }

      return res.json({ domain, verified: false, variant: result.variant ?? null });
    } catch (error) {
      logger.error({ err: error }, 'Failed to verify brand domain');
      return res.status(500).json({ error: 'Failed to verify brand domain' });
    }
  });

  // PUT /api/me/member-profile/visibility - Update visibility only (with subscription check)
  router.put('/visibility', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id }, 'PUT /api/me/member-profile/visibility started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;
      const { is_public, show_in_carousel } = req.body;

      // Dev mode: handle dev organizations without WorkOS
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      let targetOrgId: string;

      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        targetOrgId = requestedOrgId!;
        logger.info({ userId: user.id, orgId: targetOrgId }, 'PUT /api/me/member-profile/visibility: dev mode bypass');
      } else {
        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }
      }

      // Check if profile exists
      const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
      if (!existingProfile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: 'No member profile exists for your organization.',
        });
      }

      // Check subscription status before allowing visibility toggle
      // Only allow public profiles for paying members
      // Uses orgDb.hasActiveSubscription which checks both Stripe AND local DB
      // (handles invoice-based memberships like Founding Members)
      if (is_public === true && !isDevModeEnabled()) {
        if (!await orgDb.hasActiveSubscription(targetOrgId)) {
          return res.status(402).json({
            error: 'Subscription required',
            message: 'An active subscription is required to make your profile public.',
          });
        }
      }

      // Update only visibility fields
      const updates: { is_public?: boolean; show_in_carousel?: boolean } = {};
      if (typeof is_public === 'boolean') updates.is_public = is_public;
      if (typeof show_in_carousel === 'boolean') updates.show_in_carousel = show_in_carousel;

      const profile = await memberDb.updateProfileByOrgId(targetOrgId, updates);

      // Invalidate Addie's member context cache
      invalidateMemberContextCache();

      const duration = Date.now() - startTime;
      logger.info({ profileId: profile?.id, orgId: targetOrgId, updates, durationMs: duration }, 'Member profile visibility updated');

      res.json({ profile });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, durationMs: duration }, 'Update member profile visibility error');
      res.status(500).json({
        error: 'Failed to update profile visibility',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/me/member-profile - Delete current user's organization's member profile
  router.delete('/', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id, org: req.query.org }, 'DELETE /api/me/member-profile started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;

      // Dev mode: handle dev organizations without WorkOS
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      let targetOrgId: string;

      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        targetOrgId = requestedOrgId!;
        logger.info({ userId: user.id, orgId: targetOrgId }, 'DELETE /api/me/member-profile: dev mode bypass');
      } else {
        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        if (requestedOrgId) {
          // Verify user is admin/owner of the requested org
          const membership = memberships.data.find(m => m.organizationId === requestedOrgId);
          if (!membership) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          const role = membership.role?.slug || 'member';
          if (role !== 'admin' && role !== 'owner') {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'Only admins and owners can delete member profiles',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }
      }

      // Check if profile exists
      const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
      if (!existingProfile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: 'No member profile exists for your organization.',
        });
      }

      // Delete the profile
      await memberDb.deleteProfile(existingProfile.id);

      // Invalidate Addie's member context cache - organization profile deleted
      invalidateMemberContextCache();

      logger.info({ profileId: existingProfile.id, orgId: targetOrgId, durationMs: Date.now() - startTime }, 'DELETE /api/me/member-profile completed');

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'DELETE /api/me/member-profile error');
      res.status(500).json({
        error: 'Failed to delete member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}

/**
 * Create admin member profile routes
 * Returns a router for admin profile routes (/api/admin/member-profiles)
 */
export function createAdminMemberProfileRouter(config: MemberProfileRoutesConfig): Router {
  const { memberDb, invalidateMemberContextCache } = config;
  const router = Router();

  // GET /api/admin/member-profiles - List all member profiles (admin)
  router.get('/', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { is_public, search, limit, offset } = req.query;

      const profiles = await memberDb.listProfiles({
        is_public: is_public === 'true' ? true : is_public === 'false' ? false : undefined,
        search: search as string,
        limit: limit ? parseInt(limit as string, 10) : 100,
        offset: offset ? parseInt(offset as string, 10) : 0,
      });

      res.json({ profiles });
    } catch (error) {
      logger.error({ err: error }, 'Admin list member profiles error');
      res.status(500).json({
        error: 'Failed to list member profiles',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // PUT /api/admin/member-profiles/:id - Update any member profile (admin)
  router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Validate offerings if provided
      if (updates.offerings && Array.isArray(updates.offerings)) {
        const invalidOfferings = updates.offerings.filter((o: string) => !VALID_MEMBER_OFFERINGS.includes(o as any));
        if (invalidOfferings.length > 0) {
          return res.status(400).json({
            error: 'Invalid offerings',
            message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${VALID_MEMBER_OFFERINGS.join(', ')}`,
          });
        }
      }

      // Remove fields that shouldn't be updated
      delete updates.id;
      delete updates.workos_organization_id;
      delete updates.created_at;
      delete updates.updated_at;

      const profile = await memberDb.updateProfile(id, updates);

      if (!profile) {
        return res.status(404).json({
          error: 'Profile not found',
          message: `No member profile found with ID: ${id}`,
        });
      }

      // Invalidate Addie's member context cache - organization profile updated by admin
      invalidateMemberContextCache();

      logger.info({ profileId: id, adminUpdate: true }, 'Member profile updated by admin');

      res.json({ profile });
    } catch (error) {
      logger.error({ err: error }, 'Admin update member profile error');
      res.status(500).json({
        error: 'Failed to update member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // DELETE /api/admin/member-profiles/:id - Delete any member profile (admin)
  router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      const deleted = await memberDb.deleteProfile(id);

      if (!deleted) {
        return res.status(404).json({
          error: 'Profile not found',
          message: `No member profile found with ID: ${id}`,
        });
      }

      // Invalidate Addie's member context cache - organization profile deleted by admin
      invalidateMemberContextCache();

      logger.info({ profileId: id, adminDelete: true }, 'Member profile deleted by admin');

      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Admin delete member profile error');
      res.status(500).json({
        error: 'Failed to delete member profile',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
