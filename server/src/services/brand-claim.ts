/**
 * Brand-claim domain challenge service (#3176, #3189).
 *
 * Pure async functions called by both:
 *  - routes/member-profiles.ts:/brand-claim/issue and /verify (HTTP)
 *  - addie/mcp/member-tools.ts:request_brand_domain_challenge / verify_brand_domain_challenge (chat)
 *
 * Encapsulates the WorkOS Domain Verification API calls + brand-registry
 * mirror. The route handler still owns auth/role checks and req/res
 * translation; the chat tool handler does the same in chat-friendly form.
 * Keeps the WorkOS-vs-our-DB orchestration in one place.
 */

import type { WorkOS } from '@workos-inc/node';
import { BrandDatabase } from '../db/brand-db.js';
import { canonicalizeBrandDomain, assertClaimableBrandDomain } from './identifier-normalization.js';
import { createLogger } from '../logger.js';

const logger = createLogger('brand-claim');

export type IssueChallengeResult =
  | {
      ok: true;
      domain: string;
      workos_domain_id: string;
      state: string;
      verification_strategy: string | null;
      verification_token: string | null;
      verification_prefix: string | null;
      already_verified: boolean;
    }
  | { ok: false; code: 'invalid_domain'; message: string }
  | { ok: false; code: 'collision'; message: string }
  | { ok: false; code: 'workos_error'; message: string };

export type VerifyChallengeResult =
  | {
      ok: true;
      domain: string;
      newly_verified: boolean;
      adopted_prior_manifest: boolean;
    }
  | { ok: false; code: 'no_challenge'; message: string }
  | { ok: false; code: 'still_pending'; message: string; state: string }
  | { ok: false; code: 'workos_error'; message: string };

/**
 * Returns true when WorkOS's domain state should be treated as verified.
 * The SDK distinguishes Pending|Failed (returned from getOrganization()
 * domain entries) from Verified|LegacyVerified (returned from verify()),
 * which makes TypeScript narrowing weird. Stringify-then-compare so the
 * helper accepts either shape.
 */
function isVerifiedState(state: unknown): boolean {
  const s = String(state);
  return s === 'verified' || s === 'legacy_verified';
}

export async function issueDomainChallenge(input: {
  workos: WorkOS;
  orgId: string;
  rawDomain: string;
}): Promise<IssueChallengeResult> {
  const { workos, orgId, rawDomain } = input;
  if (!rawDomain) {
    return { ok: false, code: 'invalid_domain', message: 'domain is required' };
  }
  const domain = canonicalizeBrandDomain(rawDomain);
  try {
    assertClaimableBrandDomain(domain);
  } catch (err) {
    logger.debug({ err, rawDomain, domain }, 'brand-claim: rejected non-claimable domain');
    return {
      ok: false,
      code: 'invalid_domain',
      message: 'The domain is malformed or a shared platform / public-suffix domain that cannot be claimed.',
    };
  }

  // Idempotent re-issue: if the domain is already attached to this org
  // (pending or verified), surface the existing challenge instead of
  // creating a new one. WorkOS would reject the duplicate create anyway.
  try {
    const existing = await workos.organizations.getOrganization(orgId);
    const existingDomain = existing.domains.find(d => d.domain.toLowerCase() === domain);
    if (existingDomain) {
      return {
        ok: true,
        domain,
        workos_domain_id: existingDomain.id,
        state: String(existingDomain.state),
        verification_strategy: existingDomain.verificationStrategy ?? null,
        verification_token: existingDomain.verificationToken ?? null,
        verification_prefix: existingDomain.verificationPrefix ?? null,
        already_verified: isVerifiedState(existingDomain.state),
      };
    }
  } catch (err) {
    logger.warn({ err, orgId }, 'brand-claim: org pre-check failed, will attempt create');
  }

  try {
    const created = await workos.organizationDomains.create({ organizationId: orgId, domain });
    return {
      ok: true,
      domain,
      workos_domain_id: created.id,
      state: String(created.state),
      verification_strategy: created.verificationStrategy ?? 'dns',
      verification_token: created.verificationToken ?? null,
      verification_prefix: created.verificationPrefix ?? null,
      already_verified: isVerifiedState(created.state),
    };
  } catch (err: any) {
    // WorkOS returns 422 for both "already attached to another org" AND
    // "syntactically invalid". Disambiguate by inspecting the response —
    // a typo'd domain shouldn't get told to "open an escalation."
    const status = err?.status ?? err?.response?.status;
    const body = err?.response?.data ?? err?.rawResponse ?? null;
    const code = body?.code ?? '';
    const message = String(body?.message ?? err?.message ?? '');
    const looksLikeCollision =
      code === 'organization_domain_already_used'
      || /already\s+(?:exists|used|associated|attached|registered)/i.test(message)
      || /belongs\s+to\s+another/i.test(message);

    if ((status === 422 || status === 409) && looksLikeCollision) {
      return {
        ok: false,
        code: 'collision',
        message: 'This domain is already registered to another organization.',
      };
    }
    if (status === 422 || status === 400) {
      return {
        ok: false,
        code: 'invalid_domain',
        message: 'WorkOS rejected the domain as malformed.',
      };
    }
    logger.error({ err, orgId, domain }, 'workos.organizationDomains.create failed');
    return { ok: false, code: 'workos_error', message: 'Failed to issue domain verification challenge.' };
  }
}

export async function verifyDomainChallenge(input: {
  workos: WorkOS;
  brandDb: BrandDatabase;
  orgId: string;
  rawDomain: string;
  adoptPriorManifest?: boolean;
}): Promise<VerifyChallengeResult> {
  const { workos, brandDb, orgId, rawDomain, adoptPriorManifest = false } = input;
  if (!rawDomain) {
    return { ok: false, code: 'no_challenge', message: 'domain is required' };
  }
  const domain = canonicalizeBrandDomain(rawDomain);

  const existing = await workos.organizations.getOrganization(orgId);
  const existingDomain = existing.domains.find(d => d.domain.toLowerCase() === domain);
  if (!existingDomain) {
    return {
      ok: false,
      code: 'no_challenge',
      message: 'No outstanding domain challenge for this organization. Issue one first.',
    };
  }

  let verified;
  let alreadyVerified = false;
  if (isVerifiedState(existingDomain.state)) {
    verified = existingDomain;
    alreadyVerified = true;
  } else {
    try {
      verified = await workos.organizationDomains.verify(existingDomain.id);
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if (status === 422 || status === 400) {
        return {
          ok: false,
          code: 'still_pending',
          message: 'WorkOS could not find a matching DNS TXT record. Make sure verification_prefix.{domain} is published with the verification_token, then retry.',
          state: String(existingDomain.state),
        };
      }
      logger.error({ err, orgId, domain }, 'workos.organizationDomains.verify failed');
      return { ok: false, code: 'workos_error', message: 'Failed to verify domain.' };
    }
  }

  if (!isVerifiedState(verified.state)) {
    return {
      ok: false,
      code: 'still_pending',
      message: 'WorkOS has not confirmed the DNS record yet. DNS propagation can take a few minutes — try again.',
      state: String(verified.state),
    };
  }

  await brandDb.applyVerifiedBrandClaim(domain, orgId, { adoptPriorManifest });
  logger.info({ domain, orgId, adoptPriorManifest, alreadyVerified }, 'Brand claim verified via WorkOS and applied to registry');
  return {
    ok: true,
    domain,
    newly_verified: !alreadyVerified,
    adopted_prior_manifest: adoptPriorManifest,
  };
}
