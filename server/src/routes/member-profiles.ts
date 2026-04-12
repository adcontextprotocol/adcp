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
import { query, getPool } from "../db/client.js";
import { MemberDatabase } from "../db/member-db.js";
import { BrandDatabase, resolveBrandFromJson } from "../db/brand-db.js";
import { BrandManager } from "../brand-manager.js";
import { OrganizationDatabase } from "../db/organization-db.js";
import { OrgKnowledgeDatabase } from "../db/org-knowledge-db.js";
import { AAO_HOST } from "../config/aao.js";
import { VALID_MEMBER_OFFERINGS } from "../types.js";
import type { MemberBrandInfo } from "../types.js";
import type { CrawlerService } from "../crawler.js";
import { validateCrawlDomain } from "../utils/url-security.js";

const orgKnowledgeDb = new OrgKnowledgeDatabase();

const logger = createLogger("member-profile-routes");

/**
 * Validate slug format and check against reserved keywords
 */
function isValidSlug(slug: string): boolean {
  const reserved = ['admin', 'api', 'auth', 'dashboard', 'members', 'registry', 'onboarding', 'agents', 'brands', 'publishers'];
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
  crawler?: CrawlerService;
}

/**
 * Resolve brand identity from the brand registry for a given domain.
 * Checks hosted_brands first, then discovered_brands.
 */
async function resolveBrand(brandDb: BrandDatabase, domain: string): Promise<MemberBrandInfo | undefined> {
  const hosted = await brandDb.getHostedBrandByDomain(domain);
  if (hosted) {
    return resolveBrandFromJson(domain, hosted.brand_json as Record<string, unknown>, hosted.domain_verified);
  }
  const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
  if (discovered?.brand_manifest) {
    return resolveBrandFromJson(domain, discovered.brand_manifest as Record<string, unknown>, true);
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
      const devUser = isDevModeEnabled() ? Object.values(DEV_USERS).find(du => du.id === user.id) : null;
      const devOrgId = devUser ? (requestedOrgId?.startsWith('org_dev_') ? requestedOrgId : (devUser.organizationId || 'org_dev_company_001')) : null;
      if (devUser && devOrgId) {
        const localOrg = await orgDb.getOrganization(devOrgId);
        if (!localOrg) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist',
          });
        }
        const profile = await memberDb.getProfileByOrgId(devOrgId);
        if (profile?.primary_brand_domain) {
          profile.resolved_brand = await resolveBrand(brandDb, profile.primary_brand_domain);
        }
        logger.info({ userId: user.id, orgId: devOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed (dev mode)');
        return res.json({
          profile: profile || null,
          organization_id: devOrgId,
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

      // Validate tagline length
      if (tagline && typeof tagline === 'string' && tagline.length > 200) {
        return res.status(400).json({
          error: 'Invalid tagline',
          message: 'Tagline must be 200 characters or fewer',
        });
      }

      // Validate slug format and reserved words
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          error: 'Invalid slug',
          message: 'Slug must contain only lowercase letters, numbers, and hyphens, cannot start or end with a hyphen, and cannot be a reserved keyword (admin, api, auth, dashboard, members, registry, onboarding, agents, brands, publishers)',
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

      // Validate tagline length
      if (updates.tagline && typeof updates.tagline === 'string' && updates.tagline.length > 200) {
        return res.status(400).json({
          error: 'Invalid tagline',
          message: 'Tagline must be 200 characters or fewer',
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
      delete updates.is_founding_member; // Only admins can set founding status

      const profile = await memberDb.updateProfileByOrgId(targetOrgId, updates);

      // Trigger crawl for new/updated publisher domains (fire-and-forget)
      if (config.crawler && updates.publishers && Array.isArray(updates.publishers)) {
        const existingDomains = new Set(
          (existingProfile.publishers || []).map((p: { domain?: string }) => p.domain?.toLowerCase().trim()).filter(Boolean)
        );
        const MAX_AUTO_CRAWL = 5;
        let crawlCount = 0;
        for (const pub of updates.publishers) {
          if (crawlCount >= MAX_AUTO_CRAWL) break;
          if (pub.domain && pub.is_public) {
            validateCrawlDomain(pub.domain).then(domain => {
              if (!existingDomains.has(domain)) {
                config.crawler!.crawlSingleDomain(domain).catch(err => {
                  logger.warn({ err, domain }, 'Auto-crawl for new publisher domain failed');
                });
              }
            }).catch(() => {
              // Domain failed validation (private IP, invalid format) — skip silently
            });
            crawlCount++;
          }
        }
      }

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
      });
    }
  });

  // POST /api/me/agents/:index/publish - Add agent to brand.json
  router.post('/agents/:index/publish', requireAuth, async (req, res) => {
    try {
      const index = parseInt(req.params.index);
      if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [req.user!.id]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) return res.status(400).json({ error: 'No organization associated' });

      const memberDb = new MemberDatabase();
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!profile.primary_brand_domain) {
        return res.status(400).json({ error: 'Set your primary brand domain first' });
      }

      const agents = profile.agents || [];
      if (index >= agents.length) return res.status(404).json({ error: 'Agent not found at index' });
      const agent = agents[index];

      const domain = profile.primary_brand_domain;
      const brandDb = new BrandDatabase();

      // Check if brand is self-hosted (has authoritative brand.json)
      const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
      const isSelfHosted = discovered?.source_type === 'brand_json';

      if (isSelfHosted) {
        // Can't write to their file — return snippet to copy
        const snippet = {
          type: agent.type || 'brand',
          url: agent.url,
          id: agent.name || agent.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/g, '_').slice(0, 50),
          ...(agent.name ? { description: agent.name } : {}),
        };

        // Mark as public (intent — will be verified via check endpoint)
        agents[index] = { ...agent, is_public: true };
        await memberDb.updateProfileByOrgId(orgId, { agents });

        return res.json({
          action: 'snippet',
          message: 'Add this to the agents array in your brand.json',
          snippet,
        });
      }

      // Community/hosted brand — write agent into manifest
      const agentEntry = {
        type: agent.type || 'brand',
        url: agent.url,
        id: agent.name || agent.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/g, '_').slice(0, 50),
        ...(agent.name ? { description: agent.name } : {}),
      };

      // Get current agents from manifest, add/replace by URL
      const manifest = (discovered?.brand_manifest as Record<string, unknown>) || {};
      const currentAgents = Array.isArray(manifest.agents) ? manifest.agents as Array<{ type: string; url: string; id: string; description?: string }> : [];
      const updatedAgents = [...currentAgents.filter(a => a.url !== agent.url), agentEntry];

      await brandDb.updateManifestAgents(domain, updatedAgents, {
        user_id: req.user!.id,
        email: req.user!.email,
        name: req.user!.firstName ? `${req.user!.firstName} ${req.user!.lastName || ''}`.trim() : undefined,
        summary: `Published ${agent.type || 'brand'} agent to brand.json`,
      });

      // Update is_public cache
      agents[index] = { ...agent, is_public: true };
      await memberDb.updateProfileByOrgId(orgId, { agents });

      return res.json({ action: 'published', message: 'Agent published to brand.json' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to publish agent');
      return res.status(500).json({ error: 'Failed to publish agent' });
    }
  });

  // DELETE /api/me/agents/:index/publish - Remove agent from brand.json
  router.delete('/agents/:index/publish', requireAuth, async (req, res) => {
    try {
      const index = parseInt(req.params.index);
      if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [req.user!.id]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) return res.status(400).json({ error: 'No organization associated' });

      const memberDb = new MemberDatabase();
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!profile.primary_brand_domain) return res.status(400).json({ error: 'No primary brand domain' });

      const agents = profile.agents || [];
      if (index >= agents.length) return res.status(404).json({ error: 'Agent not found at index' });
      const agent = agents[index];

      const domain = profile.primary_brand_domain;
      const brandDb = new BrandDatabase();
      const discovered = await brandDb.getDiscoveredBrandByDomain(domain);

      if (discovered && discovered.source_type !== 'brand_json') {
        // Community brand — remove agent from manifest
        const manifest = (discovered.brand_manifest as Record<string, unknown>) || {};
        const currentAgents = Array.isArray(manifest.agents) ? manifest.agents as Array<{ type: string; url: string; id: string }> : [];
        const updatedAgents = currentAgents.filter(a => a.url !== agent.url);

        await brandDb.updateManifestAgents(domain, updatedAgents, {
          user_id: req.user!.id,
          email: req.user!.email,
          name: req.user!.firstName ? `${req.user!.firstName} ${req.user!.lastName || ''}`.trim() : undefined,
          summary: `Removed ${agent.type || 'brand'} agent from brand.json`,
        });
      }

      // Update is_public cache
      agents[index] = { ...agent, is_public: false };
      await memberDb.updateProfileByOrgId(orgId, { agents });

      return res.json({ action: 'unpublished', message: 'Agent removed from brand.json' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to unpublish agent');
      return res.status(500).json({ error: 'Failed to unpublish agent' });
    }
  });

  // POST /api/me/agents/:index/check - Check if agent appears in self-hosted brand.json
  router.post('/agents/:index/check', requireAuth, async (req, res) => {
    try {
      const index = parseInt(req.params.index);
      if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const userRow = await query<{ primary_organization_id: string | null }>(
        'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
        [req.user!.id]
      );
      const orgId = userRow.rows[0]?.primary_organization_id;
      if (!orgId) return res.status(400).json({ error: 'No organization associated' });

      const memberDb = new MemberDatabase();
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!profile.primary_brand_domain) return res.status(400).json({ error: 'No primary brand domain' });

      const agents = profile.agents || [];
      if (index >= agents.length) return res.status(404).json({ error: 'Agent not found at index' });
      const agent = agents[index];

      const domain = profile.primary_brand_domain;
      const brandManager = new BrandManager();

      let found = false;
      try {
        const result = await brandManager.validateDomain(domain);
        if (result.valid && result.raw_data) {
          const data = result.raw_data as Record<string, unknown>;
          const brandAgents = Array.isArray(data.agents) ? data.agents as Array<{ url?: string }> : [];

          const brands = Array.isArray(data.brands) ? data.brands as Array<{ agents?: Array<{ url?: string }> }> : [];
          const allAgents = [...brandAgents, ...brands.flatMap(b => b.agents || [])];

          found = allAgents.some(a => a.url === agent.url);
        }
      } catch {
        // Fetch failed — agent not verifiable
      }

      // Update cache
      agents[index] = { ...agent, is_public: found };
      await memberDb.updateProfileByOrgId(orgId, { agents });

      return res.json({
        found,
        checked_at: new Date().toISOString(),
        domain,
        agent_url: agent.url,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to check agent in brand.json');
      return res.status(500).json({ error: 'Failed to check agent' });
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

      // Extract the AAO pointer URL from whichever location it appears
      let pointerUrl: string | undefined;
      if (result.valid && result.raw_data && typeof result.raw_data === 'object') {
        const raw = result.raw_data as Record<string, unknown>;
        if (result.variant === 'authoritative_location' && typeof raw.authoritative_location === 'string') {
          pointerUrl = raw.authoritative_location;
        } else if (typeof raw.adcp_member === 'object' && raw.adcp_member !== null) {
          const member = raw.adcp_member as Record<string, unknown>;
          if (typeof member.authoritative_location === 'string') {
            pointerUrl = member.authoritative_location;
          }
        }
      }

      if (pointerUrl) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(pointerUrl);
        } catch {
          logger.warn({ domain, pointerUrl }, 'Invalid URL in brand.json authoritative_location');
          return res.json({ domain, verified: false, variant: result.variant ?? null, reason: 'invalid_pointer_url' });
        }
        if (parsedUrl.protocol === 'https:' &&
            parsedUrl.hostname === AAO_HOST &&
            parsedUrl.pathname === `/brands/${domain}/brand.json`) {
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
        return res.json({ domain, verified: false, variant: result.variant ?? null, reason: 'pointer_mismatch' });
      }

      return res.json({ domain, verified: false, variant: result.variant ?? null });
    } catch (error) {
      logger.error({ err: error }, 'Failed to verify brand domain');
      return res.status(500).json({ error: 'Failed to verify brand domain' });
    }
  });

  // PUT /api/me/member-profile/brand-identity - Update logo URL and brand color inline
  router.put('/brand-identity', requireAuth, async (req, res) => {
    const startTime = Date.now();
    logger.info({ userId: req.user?.id, org: req.query.org }, 'PUT /api/me/member-profile/brand-identity started');
    try {
      const user = req.user!;
      const requestedOrgId = req.query.org as string | undefined;
      const { logo_url, brand_color } = req.body;

      // Validate inputs
      if (!logo_url && !brand_color) {
        return res.status(400).json({
          error: 'Missing fields',
          message: 'Provide at least one of logo_url or brand_color.',
        });
      }

      if (logo_url) {
        try {
          const parsed = new URL(logo_url);
          if (parsed.protocol !== 'https:') {
            return res.status(400).json({ error: 'Invalid logo URL', message: 'logo_url must use HTTPS.' });
          }
        } catch {
          return res.status(400).json({ error: 'Invalid logo URL', message: 'logo_url must be a valid URL.' });
        }
        if (logo_url.length > 2000) {
          return res.status(400).json({ error: 'Invalid logo URL', message: 'logo_url must be 2000 characters or less.' });
        }
      }

      if (brand_color && !/^#[0-9a-fA-F]{6}$/.test(brand_color)) {
        return res.status(400).json({ error: 'Invalid brand color', message: 'brand_color must be a hex color (e.g., #FF5733).' });
      }

      // Auth: resolve target org (same pattern as /visibility route)
      const isDevUserProfile = isDevModeEnabled() && Object.values(DEV_USERS).some(du => du.id === user.id) && requestedOrgId?.startsWith('org_dev_');
      let targetOrgId: string;

      if (isDevUserProfile) {
        const localOrg = await orgDb.getOrganization(requestedOrgId!);
        if (!localOrg) {
          return res.status(404).json({ error: 'Organization not found', message: 'The requested organization does not exist' });
        }
        targetOrgId = requestedOrgId!;
      } else {
        const memberships = await workos!.userManagement.listOrganizationMemberships({ userId: user.id });
        if (memberships.data.length === 0) {
          return res.status(404).json({ error: 'No organization', message: 'User is not a member of any organization' });
        }
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({ error: 'Not authorized', message: 'User is not a member of the requested organization' });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }
      }

      const profile = await memberDb.getProfileByOrgId(targetOrgId);

      // Resolve org name for brand_json (profile display_name if available, else org table)
      let displayName: string;
      if (profile?.display_name) {
        displayName = profile.display_name;
      } else {
        const org = await orgDb.getOrganization(targetOrgId);
        if (!org?.name) {
          return res.status(404).json({ error: 'Organization not found', message: 'Could not resolve your organization.' });
        }
        displayName = org.name;
      }

      // Derive brand domain: profile fields first, then logo URL hostname
      let brandDomain = profile?.primary_brand_domain;
      if (!brandDomain && profile?.contact_website) {
        try { brandDomain = new URL(profile.contact_website).hostname; } catch { /* ignore */ }
      }
      if (!brandDomain && logo_url) {
        try {
          const candidate = new URL(logo_url).hostname;
          const existingBrand = await brandDb.getHostedBrandByDomain(candidate);
          if (!existingBrand || !existingBrand.workos_organization_id || existingBrand.workos_organization_id === targetOrgId) {
            brandDomain = candidate;
          }
        } catch { /* ignore */ }
      }
      if (!brandDomain) {
        return res.status(400).json({
          error: 'No brand domain',
          message: 'Provide a logo URL hosted on your own domain so we can determine your brand domain.',
        });
      }
      brandDomain = brandDomain.toLowerCase();

      // Transaction: update/create hosted brand + link profile if it exists
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Read inside transaction with row lock to prevent concurrent insert race
        const existingResult = await client.query(
          'SELECT * FROM hosted_brands WHERE brand_domain = $1 FOR UPDATE',
          [brandDomain]
        );
        const existing = existingResult.rows[0] || null;

        // Ownership check: don't let one org overwrite another org's brand
        if (existing && existing.workos_organization_id && existing.workos_organization_id !== targetOrgId) {
          throw Object.assign(new Error('This brand domain is managed by another organization.'), { statusCode: 403 });
        }

        if (existing) {
          const bj = { ...(existing.brand_json as Record<string, unknown>) };
          const brands = (bj.brands as Array<Record<string, unknown>> | undefined) ?? [];
          if (brands.length > 0) {
            const primaryBrand = { ...brands[0] };
            if (logo_url) {
              const logos = (primaryBrand.logos as Array<Record<string, unknown>> | undefined) ?? [];
              primaryBrand.logos = logos.length > 0
                ? [{ ...logos[0], url: logo_url }, ...logos.slice(1)]
                : [{ url: logo_url }];
            }
            if (brand_color) {
              primaryBrand.colors = { ...(primaryBrand.colors as Record<string, unknown> || {}), primary: brand_color };
            }
            bj.brands = [primaryBrand, ...brands.slice(1)];
          } else {
            bj.brands = [{
              id: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
              names: [{ en: displayName }],
              logos: logo_url ? [{ url: logo_url }] : [],
              colors: brand_color ? { primary: brand_color } : {},
            }];
          }
          await client.query(
            'UPDATE hosted_brands SET brand_json = $1, workos_organization_id = COALESCE(workos_organization_id, $3), updated_at = NOW() WHERE id = $2',
            [JSON.stringify(bj), existing.id, targetOrgId]
          );
        } else {
          const brandJson = {
            house: { domain: brandDomain, name: displayName },
            brands: [{
              id: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
              names: [{ en: displayName }],
              logos: logo_url ? [{ url: logo_url }] : [],
              colors: brand_color ? { primary: brand_color } : {},
            }],
          };
          await client.query(
            `INSERT INTO hosted_brands (workos_organization_id, brand_domain, brand_json, is_public)
             VALUES ($1, $2, $3, $4)`,
            [targetOrgId, brandDomain, JSON.stringify(brandJson), true]
          );
        }

        // Link brand domain back to profile if profile exists and doesn't have one
        if (profile && !profile.primary_brand_domain) {
          await client.query(
            'UPDATE member_profiles SET primary_brand_domain = $1, updated_at = NOW() WHERE id = $2',
            [brandDomain, profile.id]
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const resolvedBrand = await resolveBrand(brandDb, brandDomain);
      invalidateMemberContextCache();

      const duration = Date.now() - startTime;
      logger.info({ profileId: profile?.id, orgId: targetOrgId, brandDomain, durationMs: duration }, 'Brand identity updated');

      res.json({ brand: resolvedBrand, brand_domain: brandDomain });
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const statusCode = error?.statusCode || 500;
      logger.error({ err: error, durationMs: duration }, 'Update brand identity error');
      res.status(statusCode).json({ error: 'Failed to update brand identity' });
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
      });
    }
  });

  return router;
}
