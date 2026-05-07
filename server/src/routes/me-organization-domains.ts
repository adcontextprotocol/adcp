/**
 * Member-facing self-service for the org's linked domains.
 *
 * Mirrors the admin Set-Primary affordance from `admin-account-detail.html`
 * but scoped to the caller's own organization. The PUT path writes BOTH
 * `organization_domains.is_primary` (org-membership inference primary) AND
 * `member_profiles.primary_brand_domain` (brand-identity primary) when the
 * domain is claimable, so members don't have to think about the two-primary
 * distinction documented in the four-domain-columns audit.
 *
 * MVP scope: list + set-primary. Add (POST → WorkOS verification challenge)
 * and remove (DELETE) deferred to a follow-up — the WorkOS-side wiring is
 * materially more work than the read+set paths.
 *
 * Auth: WorkOS session OR Bearer API key (`requireAuth` handles both).
 * Role: GET allows any member; PUT requires owner/admin.
 */

import { Router } from 'express';
import type { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { resolveUserOrgMembership } from '../utils/resolve-user-org-membership.js';
import { getPool } from '../db/client.js';
import {
  assertClaimableBrandDomain,
  canonicalizeBrandDomain,
} from '../services/identifier-normalization.js';

const logger = createLogger('me-organization-domains');

export interface MeOrganizationDomainsRouterConfig {
  workos: WorkOS | null;
  invalidateMemberContextCache: () => void;
}

export function createMeOrganizationDomainsRouter(
  config: MeOrganizationDomainsRouterConfig,
): Router {
  const { workos, invalidateMemberContextCache } = config;
  const router = Router();

  async function resolveTargetOrgId(req: any, res: any): Promise<string | null> {
    const requested = typeof req.query?.org === 'string' && req.query.org.length > 0
      ? req.query.org
      : null;

    if (requested) {
      const membership = await resolveUserOrgMembership(workos, req.user!.id, requested);
      if (!membership) {
        res.status(403).json({
          error: 'Not authorized',
          message: 'User is not a member of the requested organization',
        });
        return null;
      }
      return requested;
    }

    const primary = await resolvePrimaryOrganization(req.user!.id);
    if (!primary) {
      res.status(400).json({ error: 'No organization associated with this account' });
      return null;
    }
    return primary;
  }

  // GET /api/me/organization/domains — list verified domains for the caller's org.
  router.get('/', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveTargetOrgId(req, res);
      if (!orgId) return;

      const pool = getPool();
      const result = await pool.query<{
        domain: string;
        is_primary: boolean;
        verified: boolean;
        source: string;
      }>(
        `SELECT domain, is_primary, verified, source
           FROM organization_domains
          WHERE workos_organization_id = $1
          ORDER BY is_primary DESC, created_at ASC`,
        [orgId],
      );

      const profileRow = await pool.query<{ primary_brand_domain: string | null }>(
        `SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1`,
        [orgId],
      );
      const brandPrimary = profileRow.rows[0]?.primary_brand_domain ?? null;

      const domains = result.rows.map((row) => {
        let claimable = false;
        try {
          assertClaimableBrandDomain(canonicalizeBrandDomain(row.domain));
          claimable = true;
        } catch {
          claimable = false;
        }
        return {
          domain: row.domain,
          is_primary: row.is_primary,
          verified: row.verified,
          source: row.source,
          is_brand_primary: brandPrimary === row.domain,
          claimable,
        };
      });

      return res.json({ domains, primary_brand_domain: brandPrimary });
    } catch (err) {
      logger.error({ err }, 'GET /api/me/organization/domains failed');
      return res.status(500).json({ error: 'Failed to list domains' });
    }
  });

  // PUT /api/me/organization/domains/:domain/primary — set primary domain.
  // Writes BOTH organization_domains.is_primary AND member_profiles.primary_brand_domain
  // (when the domain is claimable) in a single transaction so members can't end up
  // with the two-primary fields out of sync.
  router.put('/:domain/primary', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveTargetOrgId(req, res);
      if (!orgId) return;

      // Role gate: owners/admins only. Members can read but not change.
      const membership = await resolveUserOrgMembership(workos, req.user!.id, orgId);
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'Only owners and admins can change the primary domain',
        });
      }

      const normalizedDomain = req.params.domain.toLowerCase().trim();
      const pool = getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Verify the domain belongs to this org and is verified. We refuse to
        // promote a pending/unverified row — letting an attacker set
        // `pending` rows as primary would let them claim a domain via SSO
        // before WorkOS confirms control.
        const domainRow = await client.query<{ verified: boolean }>(
          `SELECT verified FROM organization_domains
            WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain],
        );
        if (domainRow.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Domain not found for this organization' });
        }
        if (!domainRow.rows[0].verified) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'domain_not_verified',
            message: 'The domain must be verified before it can be set as primary',
          });
        }

        // Clear existing primary, set new primary, and update the
        // denormalized organizations.email_domain in one transaction.
        await client.query(
          `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
            WHERE workos_organization_id = $1 AND is_primary = true`,
          [orgId],
        );
        await client.query(
          `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
            WHERE workos_organization_id = $1 AND domain = $2`,
          [orgId, normalizedDomain],
        );
        await client.query(
          `UPDATE organizations SET email_domain = $1, updated_at = NOW()
            WHERE workos_organization_id = $2`,
          [normalizedDomain, orgId],
        );

        // Coherent dual-write: also update member_profiles.primary_brand_domain
        // when the domain is claimable. This is the bit the admin set-primary
        // path doesn't do — and the cause of the Media.net escalation #321.
        // Members shouldn't have to think about the two-primary distinction.
        let brandPrimaryUpdated = false;
        let claimable = false;
        try {
          assertClaimableBrandDomain(canonicalizeBrandDomain(normalizedDomain));
          claimable = true;
        } catch {
          claimable = false;
        }
        if (claimable) {
          const updated = await client.query(
            `UPDATE member_profiles
                SET primary_brand_domain = $1, updated_at = NOW()
              WHERE workos_organization_id = $2`,
            [normalizedDomain, orgId],
          );
          brandPrimaryUpdated = (updated.rowCount ?? 0) > 0;
        }

        await client.query('COMMIT');

        if (brandPrimaryUpdated) invalidateMemberContextCache();

        logger.info(
          {
            orgId,
            domain: normalizedDomain,
            actor: req.user!.id,
            via_dev_bypass: membership.via_dev_bypass,
            brand_primary_updated: brandPrimaryUpdated,
          },
          'Set primary domain via member self-service',
        );

        return res.json({
          success: true,
          primary_domain: normalizedDomain,
          brand_primary_updated: brandPrimaryUpdated,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error({ err }, 'PUT /api/me/organization/domains/:domain/primary failed');
      return res.status(500).json({ error: 'Failed to set primary domain' });
    }
  });

  return router;
}
