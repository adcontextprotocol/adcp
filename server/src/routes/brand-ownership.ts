/**
 * Brand ownership status route (#4741).
 *
 * Public read endpoint that surfaces whether a brand is community-hosted,
 * verified-owned, or awaiting adoption. Drives the badge + claim/manage CTAs
 * on /brand/view/{domain}.
 *
 * Trust model:
 *  - Anonymous callers get status + owner display name only.
 *  - Authenticated callers additionally get can_claim / can_manage hints.
 *  - The actual claim flow still runs through /api/me/member-profile/brand-claim/*
 *    where DNS proves ownership; this endpoint never grants edit authority.
 */

import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { BrandDatabase } from '../db/brand-db.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { canonicalizeBrandDomain } from '../services/identifier-normalization.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-ownership');

const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type BrandOwnershipStatus = 'verified' | 'orphaned' | 'community';

export interface BrandOwnershipResponse {
  domain: string;
  status: BrandOwnershipStatus;
  owner: { name: string } | null;
  can_manage: boolean;
  can_claim: boolean;
  claim_url: string | null;
  manage_url: string | null;
  authenticated: boolean;
}

export function createBrandOwnershipRouter(config: { brandDb: BrandDatabase; orgDb?: OrganizationDatabase }): Router {
  const router = Router();
  const { brandDb } = config;
  const orgDb = config.orgDb ?? new OrganizationDatabase();

  // GET /api/brands/:domain/ownership
  router.get('/brands/:domain/ownership', optionalAuth, async (req: Request, res: Response) => {
    let domain: string;
    try {
      domain = canonicalizeBrandDomain(decodeURIComponent(req.params.domain));
    } catch {
      return res.status(400).json({ error: 'Invalid domain' });
    }
    if (!domainPattern.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain' });
    }

    try {
      const brand = await brandDb.getDiscoveredBrandByDomain(domain);
      const user = (req as any).user as { id: string } | undefined;

      const verified = !!brand && brand.domain_verified === true && !!brand.workos_organization_id;
      const orphaned = !!brand && brand.manifest_orphaned === true;
      const status: BrandOwnershipStatus = verified ? 'verified' : orphaned ? 'orphaned' : 'community';

      let ownerName: string | null = null;
      let ownerOrgId: string | null = null;
      if (verified && brand?.workos_organization_id) {
        ownerOrgId = brand.workos_organization_id;
        try {
          const org = await orgDb.getOrganization(ownerOrgId);
          ownerName = org?.name ?? null;
        } catch (err) {
          logger.warn({ err, domain, ownerOrgId }, 'Failed to resolve owner org name');
        }
      }

      let canManage = false;
      let canClaim = false;
      if (user?.id) {
        let userOrgId: string | null = null;
        try {
          userOrgId = await resolvePrimaryOrganization(user.id);
        } catch (err) {
          logger.warn({ err, userId: user.id }, 'Failed to resolve user primary org');
        }
        if (verified) {
          canManage = !!userOrgId && userOrgId === ownerOrgId;
          canClaim = false;
        } else {
          canManage = false;
          canClaim = true;
        }
      }

      const builderUrl = `/brand/builder?domain=${encodeURIComponent(domain)}`;
      const body: BrandOwnershipResponse = {
        domain,
        status,
        owner: ownerName ? { name: ownerName } : null,
        can_manage: canManage,
        can_claim: canClaim,
        manage_url: canManage ? builderUrl : null,
        claim_url: canClaim ? builderUrl : null,
        authenticated: !!user?.id,
      };
      return res.json(body);
    } catch (error) {
      logger.error({ err: error, domain }, 'Failed to resolve brand ownership');
      return res.status(500).json({ error: 'Failed to resolve brand ownership' });
    }
  });

  return router;
}
