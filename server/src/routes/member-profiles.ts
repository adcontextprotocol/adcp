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
import { OrganizationDatabase, hasApiAccess, readMembershipTierFromClient, resolveMembershipTier } from "../db/organization-db.js";
import { OrgKnowledgeDatabase } from "../db/org-knowledge-db.js";
import { autoLinkByVerifiedDomain } from "../db/membership-db.js";
import { AAO_HOST } from "../config/aao.js";
import { VALID_MEMBER_OFFERINGS, isValidAgentVisibility } from "../types.js";
import type { MemberBrandInfo, AgentVisibility, AgentConfig } from "../types.js";
import type { CrawlerService } from "../crawler.js";
import { validateCrawlDomain } from "../utils/url-security.js";
import { canonicalizeBrandDomain } from "../services/identifier-normalization.js";
import { updateBrandIdentity, BrandIdentityError } from "../services/brand-identity.js";
import { createEscalation } from "../db/escalation-db.js";
import { recordProfilePublishedIfNeeded } from "../services/profile-publish-event.js";
import { gateAgentVisibilityForCaller, type VisibilityWarning } from "../services/agent-visibility-gate.js";

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
 * Skips orphaned manifests — when a prior owner relinquished, the manifest
 * is preserved for adoption but should not surface on member-facing reads
 * until a new claim adopts (or clears) it. See updateBrandIdentity.
 */
async function resolveBrand(brandDb: BrandDatabase, domain: string): Promise<MemberBrandInfo | undefined> {
  const brand = await brandDb.getDiscoveredBrandByDomain(domain);
  if (brand?.manifest_orphaned) return undefined;
  if (brand?.brand_manifest) {
    return resolveBrandFromJson(domain, brand.brand_manifest as Record<string, unknown>, brand.domain_verified ?? false);
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
          has_api_access: hasApiAccess(resolveMembershipTier(localOrg)),
        });
      }

      // Get user's organization memberships
      let memberships = await workos!.userManagement.listOrganizationMemberships({
        userId: user.id,
      });

      // Auto-link: if no memberships, check for verified domain match
      if (memberships.data.length === 0) {
        const linked = await autoLinkByVerifiedDomain(workos!, user.id, user.email);
        if (linked) {
          // Re-fetch memberships after auto-link
          memberships = await workos!.userManagement.listOrganizationMemberships({
            userId: user.id,
          });
        }
      }

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
      const localOrg = await orgDb.getOrganization(targetOrgId);

      logger.info({ userId: user.id, orgId: targetOrgId, hasProfile: !!profile, durationMs: Date.now() - startTime }, 'GET /api/me/member-profile completed');
      res.json({
        profile: profile || null,
        organization_id: targetOrgId,
        organization_name: org.name,
        has_api_access: hasApiAccess(resolveMembershipTier(localOrg)),
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
        let memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        // Auto-link: if no memberships, check for verified domain match
        if (memberships.data.length === 0) {
          const linked = await autoLinkByVerifiedDomain(workos!, user.id, user.email);
          if (linked) {
            memberships = await workos!.userManagement.listOrganizationMemberships({
              userId: user.id,
            });
          }
        }

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

      // Gate agent visibility on create using the same helper the PUT
      // path uses. Without this, an Explorer-tier user creating their
      // first profile can land `visibility: 'public'` directly in the
      // JSONB — subsequent readers filter strictly on `=== 'public'`
      // with no tier re-check, so the entry stays public forever.
      const createOrgForTier = await orgDb.getOrganization(targetOrgId);
      const createCallerHasApi = hasApiAccess(resolveMembershipTier(createOrgForTier));
      const { agents: gatedAgents, warnings: createWarnings } =
        gateAgentVisibilityForCaller(agents, createCallerHasApi);

      // Same tier gate for the profile-level `is_public` flag. The
      // `/visibility` PUT route gates this through hasActiveSubscription
      // (line 1343), but the POST create and PUT bulk-update paths
      // previously accepted the raw body value — same smuggle class as
      // the agent-visibility bug this PR fixes.
      let effectiveIsPublic = is_public === true;
      if (effectiveIsPublic && !isDevModeEnabled()) {
        if (!(await orgDb.hasActiveSubscription(targetOrgId))) {
          effectiveIsPublic = false;
          createWarnings.push({
            code: 'visibility_downgraded',
            agent_url: 'profile',
            requested: 'public',
            applied: 'members_only',
            reason: 'tier_required',
            message: 'Making the profile publicly visible requires an active paid membership; stored as private instead.',
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
        agents: gatedAgents,
        headquarters,
        markets: markets || [],
        tags: tags || [],
        is_public: effectiveIsPublic,
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

      // Record publish event if the profile was created already public
      await recordProfilePublishedIfNeeded(targetOrgId, false, profile.is_public, user.id);

      // Invalidate Addie's member context cache - organization profile created
      invalidateMemberContextCache();

      logger.info({ profileId: profile.id, orgId: targetOrgId, slug, durationMs: Date.now() - startTime }, 'POST /api/me/member-profile completed');

      res.status(201).json({
        profile,
        ...(createWarnings.length ? { warnings: createWarnings } : {}),
      });
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
        let memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        // Auto-link: if no memberships, check for verified domain match
        if (memberships.data.length === 0) {
          const linked = await autoLinkByVerifiedDomain(workos!, user.id, user.email);
          if (linked) {
            memberships = await workos!.userManagement.listOrganizationMemberships({
              userId: user.id,
            });
          }
        }

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

      // Enforce the tier gate on agent visibility so bulk-profile updates
      // cannot bypass the per-agent PATCH. Non-API-access callers may only
      // set 'private' or 'members_only' on any agent in the array; when
      // they send 'public' we downgrade and tell them we did. Shared with
      // the POST create path via gateAgentVisibilityForCaller.
      let warnings: VisibilityWarning[] = [];
      if (Array.isArray(updates.agents)) {
        const localOrgForTier = await orgDb.getOrganization(targetOrgId);
        const callerHasApi = hasApiAccess(resolveMembershipTier(localOrgForTier));
        const gated = gateAgentVisibilityForCaller(updates.agents, callerHasApi);
        updates.agents = gated.agents;
        warnings = gated.warnings;
      }

      // Same gate for the profile-level `is_public` flag. The dedicated
      // `/visibility` PUT route already gates this; the bulk-profile
      // update path previously forwarded the raw body value, reopening
      // the same smuggle a non-paying caller could use on POST create.
      if (updates.is_public === true && !isDevModeEnabled()) {
        if (!(await orgDb.hasActiveSubscription(targetOrgId))) {
          updates.is_public = false;
          warnings.push({
            code: 'visibility_downgraded',
            agent_url: 'profile',
            requested: 'public',
            applied: 'members_only',
            reason: 'tier_required',
            message: 'Making the profile publicly visible requires an active paid membership; left as private.',
          });
        }
      }

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

      // Record publish event if this update flipped is_public from false/null to true
      await recordProfilePublishedIfNeeded(
        targetOrgId,
        existingProfile.is_public,
        profile?.is_public,
        user.id
      );

      // Invalidate Addie's member context cache - organization profile updated
      invalidateMemberContextCache();

      const duration = Date.now() - startTime;
      logger.info({ profileId: profile?.id, orgId: targetOrgId, durationMs: duration, warnings: warnings.length }, 'Member profile updated');

      res.json({ profile, ...(warnings.length ? { warnings } : {}) });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, durationMs: duration }, 'Update member profile error');
      res.status(500).json({
        error: 'Failed to update member profile',
      });
    }
  });

  /**
   * Apply a visibility change to the agent at `index` for the given org.
   * Handles brand.json manifest writes for public → community brands and
   * emits the snippet shape for self-hosted brands. Returns a result
   * payload that the route wrapper shapes into the response body.
   *
   * Caller must have already gated on tier when target === 'public'.
   *
   * The member_profiles row is locked with `SELECT ... FOR UPDATE` and
   * the visibility update is committed in the same transaction so we
   * cannot lose a concurrent PATCH or a concurrent downgrade demote.
   */
  async function applyAgentVisibility(
    orgId: string,
    index: number,
    target: AgentVisibility,
    actor: { user_id: string; email: string; name?: string }
  ): Promise<
    | { status: 404; body: { error: string } }
    | { status: 400; body: { error: string } }
    | { status: 403; body: { error: string; message: string } }
    | { status: 200; body: Record<string, unknown> }
  > {
    const pool = getPool();
    const client = await pool.connect();

    // Computed inside the tx, applied outside after the profile COMMIT.
    // The brand.json manifest write (`brandDb.updateManifestAgents`) is
    // against an external-ish surface (separate connection, different
    // table, different consumers). Keeping it inside the tx means a
    // manifest write that succeeds followed by a failed COMMIT orphans
    // the manifest entry — the exact drift the `/check` endpoint
    // exists to detect (#2825, mirror of the demote path's rewrite
    // in #2822). So we stage the manifest work during the tx, commit
    // the JSONB change, then execute manifest + log a structured
    // drift event on post-commit failure.
    type ManifestOp =
      | { kind: 'add'; domain: string; updatedAgents: Array<{ type: string; url: string; id: string; description?: string }>; summary: string }
      | { kind: 'remove'; domain: string; updatedAgents: Array<{ type: string; url: string; id: string }>; summary: string };
    let manifestOp: ManifestOp | null = null;
    let snippet: { type: string; url: string; id: string; description?: string } | undefined;
    let finalTarget: AgentVisibility = target;

    try {
      await client.query('BEGIN');

      const profileRow = await client.query(
        `SELECT id, agents, primary_brand_domain
         FROM member_profiles
         WHERE workos_organization_id = $1
         FOR UPDATE`,
        [orgId]
      );
      if (profileRow.rowCount === 0) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'Profile not found' } };
      }

      // Re-read tier INSIDE the transaction when the caller is trying
      // to publish. The outer `requireApiAccessTier` check is a
      // fast-fail for UX, but it reads the org row before this tx
      // starts — a concurrent Stripe downgrade webhook can commit
      // between the outer check and this UPDATE, letting a `public`
      // write land on an org that's no longer API-access. Reading the
      // tier-relevant columns here closes that window: if the org was
      // downgraded after our outer check, we see the new state and
      // ROLLBACK. The Stripe demote path locks member_profiles via
      // FOR UPDATE, so it can't interleave past our own lock.
      if (target === 'public') {
        const currentTier = await readMembershipTierFromClient(client, orgId);
        if (!hasApiAccess(currentTier)) {
          await client.query('ROLLBACK');
          return {
            status: 403,
            body: {
              error: 'tier_required',
              message: 'Publicly listing an agent requires Professional tier or higher.',
            },
          };
        }
      }
      const row = profileRow.rows[0] as { id: string; agents: unknown; primary_brand_domain: string | null };
      const parsedAgents = typeof row.agents === 'string'
        ? JSON.parse(row.agents)
        : Array.isArray(row.agents) ? row.agents : [];
      const agents: AgentConfig[] = (parsedAgents as unknown[]).map((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        const v = o.visibility;
        const visibility: AgentVisibility =
          v === 'private' || v === 'members_only' || v === 'public'
            ? v
            : o.is_public === true ? 'public' : 'private';
        return {
          url: String(o.url ?? ''),
          visibility,
          ...(typeof o.name === 'string' ? { name: o.name } : {}),
          ...(typeof o.type === 'string' ? { type: o.type as AgentConfig['type'] } : {}),
        };
      });

      if (index >= agents.length) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'Agent not found at index' } };
      }
      const agent = agents[index];

      // Only the public path needs to reach out to brand.json, so the
      // brand-domain requirement is scoped to `target === 'public'`.
      if (target === 'public') {
        if (!row.primary_brand_domain) {
          await client.query('ROLLBACK');
          return { status: 400, body: { error: 'Set your primary brand domain first' } };
        }
        try {
          const parsed = new URL(agent.url);
          if (parsed.protocol !== 'https:') {
            await client.query('ROLLBACK');
            return { status: 400, body: { error: 'Agent URL must use HTTPS' } };
          }
        } catch {
          await client.query('ROLLBACK');
          return { status: 400, body: { error: 'Agent URL is not a valid URL' } };
        }
      }

      const domain = row.primary_brand_domain;
      const discovered = domain ? await brandDb.getDiscoveredBrandByDomain(domain) : null;
      const isSelfHosted = discovered?.source_type === 'brand_json';

      // Sanitize the brand.json `id`: always derive from the URL so
      // user-controlled `name` can never poison consumers of brand.json.
      const safeId = agent.url
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]/gi, '_')
        .toLowerCase()
        .slice(0, 50);
      const agentEntry = {
        type: agent.type || 'brand',
        url: agent.url,
        id: safeId,
        ...(agent.name ? { description: agent.name } : {}),
      };

      if (target === 'public' && domain) {
        if (isSelfHosted) {
          snippet = agentEntry;
        } else {
          const manifest = (discovered?.brand_manifest as Record<string, unknown>) || {};
          const currentAgents = Array.isArray(manifest.agents)
            ? manifest.agents as Array<{ type: string; url: string; id: string; description?: string }>
            : [];
          manifestOp = {
            kind: 'add',
            domain,
            updatedAgents: [...currentAgents.filter(a => a.url !== agent.url), agentEntry],
            summary: `Published ${agent.type || 'brand'} agent to brand.json`,
          };
        }
      } else if (domain && discovered && !isSelfHosted) {
        const manifest = (discovered.brand_manifest as Record<string, unknown>) || {};
        const currentAgents = Array.isArray(manifest.agents)
          ? manifest.agents as Array<{ type: string; url: string; id: string }>
          : [];
        if (currentAgents.some(a => a.url === agent.url)) {
          manifestOp = {
            kind: 'remove',
            domain,
            updatedAgents: currentAgents.filter(a => a.url !== agent.url),
            summary: `Removed ${agent.type || 'brand'} agent from brand.json`,
          };
        }
      }

      agents[index] = { ...agent, visibility: target };
      await client.query(
        `UPDATE member_profiles
         SET agents = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(agents), row.id]
      );
      await client.query('COMMIT');
      finalTarget = target;
    } catch (err) {
      // Safe to attempt rollback whether we got here before or after
      // a successful COMMIT — pg no-ops a ROLLBACK on a finished tx
      // and the .catch swallows any driver noise.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      // Don't let a release() failure mask whatever the try block threw
      // (e.g. a COMMIT error we actually want to surface to the caller).
      try {
        client.release();
      } catch (releaseErr) {
        logger.warn({ err: releaseErr, orgId }, 'pg client release failed');
      }
    }

    // Profile JSONB is committed. Apply the manifest change outside
    // the tx — if this throws, the JSONB is already authoritative and
    // the `/check` endpoint's drift detection will surface the
    // divergence. Logging as structured drift so reconciliation can
    // pick it up automatically.
    if (manifestOp) {
      try {
        await brandDb.updateManifestAgents(manifestOp.domain, manifestOp.updatedAgents, {
          ...actor,
          summary: manifestOp.summary,
        });
      } catch (manifestErr) {
        // Narrow the error shape. pg driver errors and other library
        // errors can carry `error.query` / `error.parameters` that
        // pino's default err-serializer would emit — keep diagnostic
        // logs free of raw SQL + parameter values.
        const errPayload = manifestErr instanceof Error
          ? { message: manifestErr.message, name: manifestErr.name }
          : { message: String(manifestErr) };
        logger.warn(
          {
            err: errPayload,
            domain: manifestOp.domain,
            orgId,
            agentIndex: index,
            target: finalTarget,
            kind: manifestOp.kind,
            event: 'brand_json_drift',
          },
          'Profile visibility committed but brand.json manifest write failed — /check will surface as drift',
        );
      }
    }

    if (finalTarget === 'public' && snippet) {
      return {
        status: 200,
        body: {
          action: 'snippet',
          message: 'Add this to the agents array in your brand.json',
          visibility: finalTarget,
          snippet,
        },
      };
    }
    return {
      status: 200,
      body: {
        action: finalTarget === 'public' ? 'published' : finalTarget === 'private' ? 'unpublished' : 'members_only',
        message:
          finalTarget === 'public'
            ? 'Agent published to brand.json'
            : finalTarget === 'members_only'
              ? 'Agent is visible to members with API access'
              : 'Agent removed from brand.json',
        visibility: finalTarget,
      },
    };
  }

  /**
   * Resolve the primary organization for the authenticated user, or send
   * the appropriate error response. Returns null when the response has
   * already been sent.
   */
  async function resolveUserOrgId(req: any, res: any): Promise<string | null> {
    const userRow = await query<{ primary_organization_id: string | null }>(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      [req.user!.id]
    );
    const orgId = userRow.rows[0]?.primary_organization_id;
    if (!orgId) {
      res.status(400).json({ error: 'No organization associated' });
      return null;
    }
    return orgId;
  }

  /**
   * Require the caller's organization to hold an API-access membership
   * tier (Professional and above). Returns true when the gate passes; in
   * the failure case, the response has already been sent.
   */
  async function requireApiAccessTier(orgId: string, res: any): Promise<boolean> {
    const org = await orgDb.getOrganization(orgId);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return false;
    }
    if (!hasApiAccess(resolveMembershipTier(org))) {
      res.status(403).json({
        error: 'tier_required',
        message: 'Publicly listing an agent requires Professional tier or higher.',
      });
      return false;
    }
    return true;
  }

  // POST /api/me/agents/:index/publish - Set agent visibility to public
  router.post('/agents/:index/publish', requireAuth, async (req, res) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const orgId = await resolveUserOrgId(req, res);
      if (!orgId) return;
      if (!(await requireApiAccessTier(orgId, res))) return;

      const result = await applyAgentVisibility(orgId, index, 'public', {
        user_id: req.user!.id,
        email: req.user!.email,
        name: req.user!.firstName ? `${req.user!.firstName} ${req.user!.lastName || ''}`.trim() : undefined,
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logger.error({ err: error }, 'Failed to publish agent');
      return res.status(500).json({ error: 'Failed to publish agent' });
    }
  });

  // DELETE /api/me/agents/:index/publish - Set agent visibility to private
  router.delete('/agents/:index/publish', requireAuth, async (req, res) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const orgId = await resolveUserOrgId(req, res);
      if (!orgId) return;

      const result = await applyAgentVisibility(orgId, index, 'private', {
        user_id: req.user!.id,
        email: req.user!.email,
        name: req.user!.firstName ? `${req.user!.firstName} ${req.user!.lastName || ''}`.trim() : undefined,
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logger.error({ err: error }, 'Failed to unpublish agent');
      return res.status(500).json({ error: 'Failed to unpublish agent' });
    }
  });

  // PATCH /api/me/agents/:index/visibility - Set agent visibility to any tier
  router.patch('/agents/:index/visibility', requireAuth, async (req, res) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const target = (req.body ?? {}).visibility;
      if (!isValidAgentVisibility(target)) {
        return res.status(400).json({
          error: 'Invalid visibility',
          valid: ['private', 'members_only', 'public'],
        });
      }

      const orgId = await resolveUserOrgId(req, res);
      if (!orgId) return;
      if (target === 'public' && !(await requireApiAccessTier(orgId, res))) return;

      const result = await applyAgentVisibility(orgId, index, target, {
        user_id: req.user!.id,
        email: req.user!.email,
        name: req.user!.firstName ? `${req.user!.firstName} ${req.user!.lastName || ''}`.trim() : undefined,
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logger.error({ err: error }, 'Failed to update agent visibility');
      return res.status(500).json({ error: 'Failed to update agent visibility' });
    }
  });

  // POST /api/me/agents/:index/check - Verify public agent is present in brand.json
  router.post('/agents/:index/check', requireAuth, async (req, res) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid agent index' });

      const orgId = await resolveUserOrgId(req, res);
      if (!orgId) return;

      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      if (!profile.primary_brand_domain) return res.status(400).json({ error: 'No primary brand domain' });

      const agents = profile.agents || [];
      if (index >= agents.length) return res.status(404).json({ error: 'Agent not found at index' });
      const agent = agents[index];

      const domain = profile.primary_brand_domain;

      // Validate domain is safe to fetch (SSRF protection)
      try {
        await validateCrawlDomain(domain);
      } catch (e) {
        return res.status(400).json({ error: `Invalid domain: ${(e as Error).message}` });
      }

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

      // /check is a report-only endpoint: it surfaces drift between the
      // stored visibility intent and what the authoritative brand.json
      // actually lists. It does NOT mutate visibility — callers should use
      // PATCH /agents/:index/visibility to resolve drift.
      const expectedPublic = agent.visibility === 'public';
      const drift: 'synced' | 'missing_from_brand_json' | 'present_in_brand_json' =
        expectedPublic && !found
          ? 'missing_from_brand_json'
          : !expectedPublic && found
            ? 'present_in_brand_json'
            : 'synced';

      return res.json({
        found,
        checked_at: new Date().toISOString(),
        domain,
        agent_url: agent.url,
        visibility: agent.visibility,
        drift,
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
          // Proof of domain control: claim ownership and mark verified.
          // If the brand is orphaned (prior owner relinquished), atomically
          // clear the orphan flag and reset the prior manifest — otherwise
          // the new owner silently inherits the prior org's visual identity.
          // The orphan-aware path is the only safe route for claim+verify;
          // updateHostedBrand by itself doesn't touch the orphan columns.
          if (hosted.manifest_orphaned) {
            await brandDb.claimOrphanedHostedBrand(hosted.id, orgId);
          } else {
            await brandDb.updateHostedBrand(hosted.id, {
              domain_verified: true,
              workos_organization_id: orgId,
            });
          }
          return res.json({ domain, verified: true, claimed_orphaned: !!hosted.manifest_orphaned });
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
      const { logo_url, brand_color, adopt_prior_manifest } = req.body;

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

      // Resolve display name: profile if available, else org name
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

      // If no brand domain on file, fall back to the logo URL hostname (only if
      // the candidate domain isn't already owned by another org)
      let fallbackDomainHint: string | undefined;
      if (!profile?.primary_brand_domain && !profile?.contact_website && logo_url) {
        try {
          const candidate = canonicalizeBrandDomain(new URL(logo_url).hostname);
          const existingBrand = await brandDb.getHostedBrandByDomain(candidate);
          if (!existingBrand || !existingBrand.workos_organization_id || existingBrand.workos_organization_id === targetOrgId) {
            fallbackDomainHint = candidate;
          }
        } catch { /* ignore */ }
      }

      let result;
      try {
        result = await updateBrandIdentity({
          workosOrganizationId: targetOrgId,
          displayName,
          profile: profile ?? null,
          logoUrl: logo_url,
          brandColor: brand_color,
          fallbackDomainHint,
          // Preserve undefined so the service can require an explicit decision
          // when the brand is orphaned. Booleans only — anything else is a
          // bad-request shape, but we let the service treat it as undefined.
          adoptPriorManifest: typeof adopt_prior_manifest === 'boolean' ? adopt_prior_manifest : undefined,
        });
      } catch (err: any) {
        if (err instanceof BrandIdentityError) {
          if (err.code === 'orphan_manifest_decision_required') {
            // Force the caller to pick adopt-or-clear before we apply the write.
            // The response carries the prior owner's org id so a UI / agent can
            // surface the choice ("this domain was previously registered by
            // {prior_org} — adopt their identity, or start fresh?").
            const meta = err.meta as { brandDomain: string; priorOwnerOrgId: string | null };
            return res.status(409).json({
              error: 'Orphan manifest decision required',
              code: 'orphan_manifest_decision_required',
              message: err.message,
              brand_domain: meta.brandDomain,
              prior_owner_org_id: meta.priorOwnerOrgId,
            });
          }
          if (err.isCrossOrgOwnership()) {
            // Convert the bare 403 into a routed escalation so an admin can
            // resolve via transfer_brand_ownership instead of the user dead-ending.
            // Categorized as sensitive_topic because the dispute may involve
            // trademark or commercial claims; the framing stays neutral so an
            // admin reading it doesn't anchor to either party.
            const { brandDomain, currentOwnerOrgId } = err.meta;
            const callerName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
            // Resolve the incumbent org's display name so the queue summary
            // names both parties — admins shouldn't have to open the ticket
            // to find out who's being claimed against.
            const incumbentOrg = await orgDb.getOrganization(currentOwnerOrgId).catch(() => null);
            const incumbentName = incumbentOrg?.name ?? currentOwnerOrgId;
            const escalation = await createEscalation({
              workos_user_id: user.id,
              user_email: user.email,
              user_display_name: callerName,
              category: 'sensitive_topic',
              priority: 'normal',
              summary: `Brand ownership review: ${brandDomain} — claim by ${displayName} vs current owner ${incumbentName}`,
              original_request: `Update brand identity for ${brandDomain} (logo=${logo_url ?? 'unchanged'}, color=${brand_color ?? 'unchanged'}).`,
              addie_context: `Caller: ${callerName} <${user.email}>, org ${targetOrgId} (${displayName}). Current owner org: ${currentOwnerOrgId} (${incumbentName}). Could be an acquisition, naming overlap, or someone backfilling on behalf of the registered org — verify intent before adjudicating. Resolve via transfer_brand_ownership if the claim checks out, or close as won't-do if not.`,
            }).catch(escalErr => {
              logger.error({ err: escalErr, brandDomain }, 'Failed to file brand-ownership escalation');
              return null;
            });
            return res.status(409).json({
              error: 'Brand domain is managed by another organization',
              message: escalation
                ? 'We filed a ticket so the team can review.'
                : 'We could not file a ticket automatically — please email support@agenticadvertising.org.',
              escalation_id: escalation?.id ?? null,
              brand_domain: brandDomain,
            });
          }
          return res.status(err.statusCode).json({ error: 'Invalid request', message: err.message });
        }
        throw err;
      }

      const resolvedBrand = await resolveBrand(brandDb, result.brandDomain);
      invalidateMemberContextCache();

      const duration = Date.now() - startTime;
      logger.info({ profileId: profile?.id, orgId: targetOrgId, brandDomain: result.brandDomain, claimedOrphanedBrand: result.claimedOrphanedBrand, keptPriorManifest: result.keptPriorManifest, durationMs: duration }, 'Brand identity updated');

      res.json({
        brand: resolvedBrand,
        brand_domain: result.brandDomain,
        claimed_orphaned_brand: result.claimedOrphanedBrand ?? false,
        kept_prior_manifest: result.keptPriorManifest ?? false,
      });
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

      // Record publish event if this flipped is_public from false/null to true
      await recordProfilePublishedIfNeeded(
        targetOrgId,
        existingProfile.is_public,
        profile?.is_public,
        user.id
      );

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
