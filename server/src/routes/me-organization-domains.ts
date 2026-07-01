/**
 * Member-facing self-service for the org's linked domains.
 *
 * Add (POST) issues a WorkOS DNS-TXT challenge and writes a pending row;
 * verify (POST /:domain/verify) confirms the TXT record with WorkOS and
 * flips `verified=true`. The existing PUT /:domain/primary then accepts
 * the row because `source='workos'` matches the member self-service gate.
 *
 * Auth: WorkOS session OR Bearer API key (`requireAuth` handles both).
 * Role: GET allows any member; POST/PUT require owner/admin.
 */

import { Router } from 'express';
import type { WorkOS } from '@workos-inc/node';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { resolveUserOrgMembership } from '../utils/resolve-user-org-membership.js';
import { getPool } from '../db/client.js';
import {
  setPrimaryDomain,
  upsertWorkosDomain,
  linkDomain,
} from '../db/organization-domains-db.js';
import {
  assertClaimableBrandDomain,
  canonicalizeBrandDomain,
} from '../services/identifier-normalization.js';

const logger = createLogger('me-organization-domains');

// In-process verify cooldown — mirrors the brand-claim service. DNS
// propagation is minutes-scale; agentic loops that see `still_pending`
// will retry immediately. A 60s floor between verify attempts on the
// same (org, domain) costs a real user nothing and kills the loop.
// Per-process — multi-instance deployments get a softer guarantee but
// the route's auth gate is the trust boundary.
const VERIFY_COOLDOWN_MS = 60_000;
const VERIFY_COOLDOWN_MAX_ENTRIES = 10_000;
const verifyAttemptTimes = new Map<string, number>();

function cooldownKey(orgId: string, domain: string) {
  return `${orgId}:${domain}`;
}

function trimVerifyAttempts(now: number) {
  if (verifyAttemptTimes.size < VERIFY_COOLDOWN_MAX_ENTRIES) return;
  for (const [k, t] of verifyAttemptTimes) {
    if (now - t >= VERIFY_COOLDOWN_MS) verifyAttemptTimes.delete(k);
  }
  if (verifyAttemptTimes.size < VERIFY_COOLDOWN_MAX_ENTRIES) return;
  const overflow = verifyAttemptTimes.size - VERIFY_COOLDOWN_MAX_ENTRIES + 1;
  let dropped = 0;
  for (const k of verifyAttemptTimes.keys()) {
    if (dropped >= overflow) break;
    verifyAttemptTimes.delete(k);
    dropped++;
  }
}

export function _resetVerifyCooldown() {
  verifyAttemptTimes.clear();
}

function dnsRecordName(domain: string, verificationPrefix?: string | null): string {
  return verificationPrefix ? `${verificationPrefix}.${domain}` : domain;
}

// Returns true when `domain` is already linked to an organization other
// than `orgId`. Used by the POST issue path to refuse cross-tenant
// ownership transfer at issue time (before DNS proof). `linkDomain` would
// also refuse, but a pre-check keeps us from leaking a WorkOS resource
// for a domain we can't accept locally.
async function crossOrgConflict(domain: string, orgId: string): Promise<boolean> {
  const row = await getPool().query<{ workos_organization_id: string }>(
    `SELECT workos_organization_id FROM organization_domains WHERE domain = $1 LIMIT 1`,
    [domain],
  );
  if (row.rowCount === 0) return false;
  return row.rows[0].workos_organization_id !== orgId;
}

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

      // Member self-service: only WorkOS-verified rows are eligible. After
      // Stage 2 of #4159, is_primary drives BOTH org-membership inference
      // AND brand identity, so we hold the bar at WorkOS DNS proof.
      // Admin-imported / manual rows aren't DNS-proof-of-control claims and
      // pending rows are pre-verification — the source allowlist below is
      // the security gate.
      const result = await setPrimaryDomain({
        orgId,
        domain: normalizedDomain,
        requireSource: ['workos'],
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          return res.status(404).json({ error: 'Domain not found for this organization' });
        }
        if (result.reason === 'not_verified') {
          return res.status(400).json({
            error: 'domain_not_verified',
            message: 'The domain must be verified before it can be set as primary',
          });
        }
        return res.status(400).json({
          error: 'domain_not_workos_verified',
          message: 'Only domains verified through WorkOS DNS challenge can be set as primary',
        });
      }

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
      logger.error({ err }, 'PUT /api/me/organization/domains/:domain/primary failed');
      return res.status(500).json({ error: 'Failed to set primary domain' });
    }
  });

  // POST /api/me/organization/domains — issue a WorkOS DNS-TXT challenge.
  // Owner/admin only. On success, returns the prefix/token the caller must
  // publish at `<prefix>.<domain>` IN TXT. Re-posting the same domain is
  // idempotent: if a pending challenge already exists on WorkOS for this org
  // we surface the existing token; if it's already verified we still write
  // through to the local row (source='workos', verified=true).
  router.post('/', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveTargetOrgId(req, res);
      if (!orgId) return;

      const membership = await resolveUserOrgMembership(workos, req.user!.id, orgId);
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'Only owners and admins can add a domain',
        });
      }

      if (!workos) {
        return res.status(503).json({
          error: 'workos_unavailable',
          message: 'Domain verification is not configured on this deployment.',
        });
      }

      const rawDomain = (req.body as Record<string, unknown>)?.domain;
      if (typeof rawDomain !== 'string' || rawDomain.length === 0) {
        return res.status(400).json({ error: 'invalid_domain', message: 'domain is required' });
      }
      let normalizedDomain: string;
      try {
        normalizedDomain = canonicalizeBrandDomain(rawDomain);
        assertClaimableBrandDomain(normalizedDomain);
      } catch (err) {
        logger.debug({ err, rawDomain }, 'POST add domain: rejected non-claimable domain');
        return res.status(400).json({
          error: 'invalid_domain',
          message: 'The domain is malformed or a shared platform / public-suffix domain that cannot be claimed.',
        });
      }
      if (normalizedDomain.length > 253) {
        return res.status(400).json({ error: 'invalid_domain' });
      }

      // Idempotent re-issue: WorkOS rejects duplicate creates, so check first.
      // If a usable challenge already exists (or it's verified), return that
      // state instead of failing on the create call below.
      let existingOrg;
      try {
        existingOrg = await workos.organizations.getOrganization(orgId);
      } catch (err) {
        logger.warn({ err, orgId }, 'POST add domain: getOrganization failed, will attempt create');
      }
      const existingEntry = existingOrg?.domains.find(d => d.domain.toLowerCase() === normalizedDomain);

      if (existingEntry) {
        const stateStr = String(existingEntry.state);
        const verified = stateStr === 'verified' || stateStr === 'legacy_verified';
        if (verified) {
          // WorkOS confirms DNS proof for THIS org. That's the documented
          // contract for transfer-on-conflict, so upsertWorkosDomain is safe
          // even if a cross-org local row exists.
          await upsertWorkosDomain({ orgId, domain: normalizedDomain, verified: true });
          invalidateMemberContextCache();
          return res.json({
            domain: normalizedDomain,
            state: stateStr,
            already_verified: true,
            verification_token: null,
            verification_prefix: null,
            verification_strategy: existingEntry.verificationStrategy ?? null,
          });
        }
        // Non-verified branches below MUST cross-check the local DB before
        // writing — see comment near the create path.
        const tokenMissing = !existingEntry.verificationToken;
        if (!tokenMissing) {
          const conflict = await crossOrgConflict(normalizedDomain, orgId);
          if (conflict) {
            return res.status(409).json({
              error: 'domain_already_claimed',
              message: 'This domain is already linked to another organization.',
            });
          }
          await linkDomain({
            orgId,
            domain: normalizedDomain,
            source: 'workos',
            verified: false,
          });
          return res.json({
            domain: normalizedDomain,
            state: stateStr,
            already_verified: false,
            verification_token: existingEntry.verificationToken,
            verification_prefix: existingEntry.verificationPrefix,
            dns_record_name: dnsRecordName(normalizedDomain, existingEntry.verificationPrefix),
            verification_strategy: existingEntry.verificationStrategy ?? 'dns',
          });
        }
        // Broken state: pending but no token. Delete + recreate so the user
        // gets a usable record. Same pattern as brand-claim.ts.
        try {
          await workos.organizationDomains.deleteOrganizationDomain(existingEntry.id);
        } catch (err) {
          logger.error({ err, orgId, domain: normalizedDomain }, 'Failed to delete broken pending domain');
          return res.status(502).json({
            error: 'workos_error',
            message: 'Failed to clear a broken pending challenge for this domain. Try again or contact support.',
          });
        }
      }

      // Cross-org local conflict check BEFORE creating the WorkOS resource.
      // `organization_domains` is the single-source-of-truth row for both
      // brand identity and org-membership inference (#4159 Stage 2). At
      // issue time we have no DNS proof, so we must not overwrite a row
      // owned by another org — even one with `source='manual'` from an
      // admin attach or the brands FK backfill. `upsertWorkosDomain` would
      // silently transfer; `linkDomain` refuses transfer; an explicit
      // pre-check returns 409 cleanly and avoids leaking a WorkOS resource.
      const preConflict = await crossOrgConflict(normalizedDomain, orgId);
      if (preConflict) {
        return res.status(409).json({
          error: 'domain_already_claimed',
          message: 'This domain is already linked to another organization.',
        });
      }

      try {
        const created = await workos.organizationDomains.createOrganizationDomain({
          organizationId: orgId,
          domain: normalizedDomain,
        });
        // linkDomain (not upsertWorkosDomain) — leaves any same-org row
        // alone (e.g. an existing source='manual' row stays as-is until
        // the verify path provides DNS proof). Inserts source='workos'
        // verified=false when no local row exists.
        await linkDomain({
          orgId,
          domain: normalizedDomain,
          source: 'workos',
          verified: false,
        });
        logger.info(
          { orgId, domain: normalizedDomain, actor: req.user!.id, workos_domain_id: created.id },
          'Issued domain verification challenge via member self-service',
        );
        return res.json({
          domain: normalizedDomain,
          state: String(created.state),
          already_verified: false,
          verification_token: created.verificationToken ?? null,
          verification_prefix: created.verificationPrefix ?? null,
          dns_record_name: created.verificationToken
            ? dnsRecordName(normalizedDomain, created.verificationPrefix)
            : null,
          verification_strategy: created.verificationStrategy ?? 'dns',
        });
      } catch (err: any) {
        const status = err?.status ?? err?.response?.status;
        const body = err?.response?.data ?? err?.rawResponse ?? null;
        const code = body?.code ?? '';
        const message = String(body?.message ?? err?.message ?? '');
        const looksLikeCollision =
          code === 'organization_domain_already_used'
          || /already\s+(?:exists|used|associated|attached|registered)/i.test(message)
          || /belongs\s+to\s+another/i.test(message);
        if ((status === 422 || status === 409) && looksLikeCollision) {
          return res.status(409).json({
            error: 'domain_already_claimed',
            message: 'This domain is already registered to another organization.',
          });
        }
        if (status === 422 || status === 400) {
          return res.status(400).json({
            error: 'invalid_domain',
            message: 'WorkOS rejected the domain as malformed.',
          });
        }
        logger.error({ err, orgId, domain: normalizedDomain }, 'createOrganizationDomain failed');
        return res.status(502).json({ error: 'workos_error', message: 'Failed to issue domain verification challenge.' });
      }
    } catch (err) {
      logger.error({ err }, 'POST /api/me/organization/domains failed');
      return res.status(500).json({ error: 'Failed to add domain' });
    }
  });

  // POST /api/me/organization/domains/:domain/verify — confirm the DNS-TXT
  // record with WorkOS. On success the local row flips to verified=true,
  // which makes it eligible for PUT /:domain/primary above.
  router.post('/:domain/verify', requireAuth, async (req, res) => {
    try {
      const orgId = await resolveTargetOrgId(req, res);
      if (!orgId) return;

      const membership = await resolveUserOrgMembership(workos, req.user!.id, orgId);
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'Only owners and admins can verify a domain',
        });
      }

      if (!workos) {
        return res.status(503).json({
          error: 'workos_unavailable',
          message: 'Domain verification is not configured on this deployment.',
        });
      }

      let normalizedDomain: string;
      try {
        normalizedDomain = canonicalizeBrandDomain(req.params.domain);
      } catch (err) {
        logger.warn({ err, raw: req.params.domain }, 'Rejected invalid domain in verify');
        return res.status(400).json({ error: 'invalid_domain' });
      }

      // 60s cooldown per (org, domain). DNS propagation is minutes-scale,
      // so a tight retry loop only burns WorkOS quota and gives no new
      // information. Same guard as brand-claim.ts.
      const cdKey = cooldownKey(orgId, normalizedDomain);
      const now = Date.now();
      const last = verifyAttemptTimes.get(cdKey);
      if (last !== undefined && now - last < VERIFY_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((VERIFY_COOLDOWN_MS - (now - last)) / 1000);
        return res.status(429).json({
          error: 'still_pending',
          message: `Hold off — wait ${retryAfterSeconds}s before re-checking. DNS propagation takes minutes; rapid retries don't help.`,
          retry_after_seconds: retryAfterSeconds,
        });
      }
      trimVerifyAttempts(now);
      verifyAttemptTimes.set(cdKey, now);

      let org;
      try {
        org = await workos.organizations.getOrganization(orgId);
      } catch (err) {
        logger.error({ err, orgId, domain: normalizedDomain }, 'verify: getOrganization failed');
        return res.status(502).json({ error: 'workos_error', message: 'Failed to look up organization.' });
      }
      const entry = org.domains.find(d => d.domain.toLowerCase() === normalizedDomain);
      if (!entry) {
        return res.status(404).json({
          error: 'no_challenge',
          message: 'No outstanding domain challenge for this organization. Issue one first.',
        });
      }

      const stateStr = String(entry.state);
      const alreadyVerified = stateStr === 'verified' || stateStr === 'legacy_verified';
      let verifiedState = stateStr;
      if (!alreadyVerified) {
        try {
          const verified = await workos.organizationDomains.verifyOrganizationDomain(entry.id);
          verifiedState = String(verified.state);
        } catch (err: any) {
          const status = err?.status ?? err?.response?.status;
          if (status === 422 || status === 400) {
            const recordName = dnsRecordName(normalizedDomain, entry.verificationPrefix);
            return res.status(400).json({
              error: 'still_pending',
              message: `WorkOS could not find a matching DNS TXT record. Make sure ${recordName} is published with the verification token, then retry.`,
              state: stateStr,
              dns_record_name: recordName,
            });
          }
          logger.error({ err, orgId, domain: normalizedDomain }, 'verifyOrganizationDomain failed');
          return res.status(502).json({ error: 'workos_error', message: 'Failed to verify domain.' });
        }
      }

      if (verifiedState !== 'verified' && verifiedState !== 'legacy_verified') {
        return res.status(400).json({
          error: 'still_pending',
          message: 'WorkOS has not confirmed the DNS record yet. DNS propagation can take 5-15 minutes.',
          state: verifiedState,
        });
      }

      await upsertWorkosDomain({
        orgId,
        domain: normalizedDomain,
        verified: true,
      });
      invalidateMemberContextCache();
      // Clear the cooldown so a follow-up call (e.g. "verify, now set primary")
      // doesn't have to wait out the loop-prevention window.
      verifyAttemptTimes.delete(cdKey);

      logger.info(
        { orgId, domain: normalizedDomain, actor: req.user!.id, already_verified: alreadyVerified },
        'Verified domain via member self-service',
      );

      return res.json({
        success: true,
        domain: normalizedDomain,
        newly_verified: !alreadyVerified,
        state: verifiedState,
      });
    } catch (err) {
      logger.error({ err }, 'POST /api/me/organization/domains/:domain/verify failed');
      return res.status(500).json({ error: 'Failed to verify domain' });
    }
  });

  return router;
}
