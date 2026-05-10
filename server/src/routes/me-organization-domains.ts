/**
 * Member-facing self-service for the org's linked domains.
 *
 * Mirrors the admin Set-Primary affordance from `admin-account-detail.html`
 * but scoped to the caller's own organization. The PUT path flips
 * `organization_domains.is_primary` — after the Stage 2 column drop, that
 * row drives both org-membership-inference and brand-identity, so a single
 * write sets the primary unambiguously.
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

      // After the Stage 2 column drop, `is_primary` on organization_domains
      // is the canonical brand-primary too — `is_brand_primary` mirrors it.
      // Kept as a separate field on the response for API stability so any
      // existing clients that read it don't break.
      const brandPrimary = result.rows.find((r) => r.is_primary)?.domain ?? null;

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
          is_brand_primary: row.is_primary,
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
  // Single source of truth: organization_domains.is_primary. After the Stage 2
  // column drop, brand-identity and org-membership-inference share this row.
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

      // Canonicalize the input domain — strips protocol/path/`www.`/etc. and
      // rejects shapes that aren't valid brand-domain inputs. Reuses the same
      // function the GET path uses to compute `claimable`.
      let normalizedDomain: string;
      try {
        normalizedDomain = canonicalizeBrandDomain(req.params.domain);
      } catch (err) {
        logger.warn({ err, raw: req.params.domain }, 'Rejected invalid domain in PUT primary');
        return res.status(400).json({ error: 'invalid_domain' });
      }
      if (normalizedDomain.length > 253) {
        return res.status(400).json({ error: 'invalid_domain' });
      }

      const pool = getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Lock the org row to serialize against the WorkOS webhook
        // (`upsertOrganizationDomain`), which takes the same row lock when it
        // promotes a newly-verified domain to is_primary. Without this, our
        // three writes can interleave with the webhook's two writes and end
        // up with `organizations.email_domain` reflecting whichever
        // transaction committed last.
        await client.query(
          'SELECT 1 FROM organizations WHERE workos_organization_id = $1 FOR UPDATE',
          [orgId],
        );

        // Verify the domain belongs to this org and is a WorkOS-verified row.
        // After Stage 2 of #4159, is_primary drives BOTH org-membership
        // inference AND brand identity, so we hold the bar at WorkOS DNS
        // proof: pending rows are pre-verification (would grant SSO claim
        // before WorkOS confirms control) and admin-imported / manual rows
        // aren't DNS-proof-of-control claims (would let an admin-imported
        // verified=true row escalate to brand identity via member self-service).
        const domainRow = await client.query<{ verified: boolean; source: string }>(
          `SELECT verified, source FROM organization_domains
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
        if (domainRow.rows[0].source !== 'workos') {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'domain_not_workos_verified',
            message: 'Only domains verified through WorkOS DNS challenge can be set as primary',
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

        await client.query('COMMIT');

        // Brand-identity primary now mirrors org-membership-inference primary
        // via the same row, so any member-context cache that depended on
        // brand-primary still needs invalidation when the row flips.
        invalidateMemberContextCache();

        logger.info(
          {
            orgId,
            domain: normalizedDomain,
            actor: req.user!.id,
            via_dev_bypass: membership.via_dev_bypass,
          },
          'Set primary domain via member self-service',
        );

        return res.json({
          success: true,
          primary_domain: normalizedDomain,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch((rbErr) => {
          logger.error({ rbErr, orgId }, 'ROLLBACK failed in PUT primary');
        });
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
