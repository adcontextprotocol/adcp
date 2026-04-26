/**
 * Brand-claim domain challenge service (#3176, #3189).
 *
 * Pure async functions called by both:
 *  - routes/member-profiles.ts:/brand-claim/issue and /verify (HTTP)
 *  - addie/mcp/member-tools.ts:request_brand_domain_challenge / verify_brand_domain_challenge (chat)
 *
 * Encapsulates the WorkOS Domain Verification API calls + brand-registry
 * mirror. Callers own auth/role checks and req/res translation; this layer
 * owns WorkOS-vs-our-DB orchestration.
 */

import type { WorkOS } from '@workos-inc/node';
import { BrandDatabase } from '../db/brand-db.js';
import type { HostedBrand } from '../types.js';
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
      // True when a brand row exists for this domain with an orphaned manifest
      // (a prior owner relinquished). Tells callers whether to surface the
      // adopt-vs-fresh decision when the user runs verify.
      prior_manifest_exists: boolean;
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
      brand: { brand_domain: string; domain_verified: boolean } | null;
    }
  | { ok: false; code: 'no_challenge'; message: string }
  | { ok: false; code: 'still_pending'; message: string; state: string; retry_after_seconds?: number }
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

// In-process verify cooldown to stop autonomous LLM loops from polling. DNS
// propagation is minutes-scale; a 60s floor between verify attempts costs
// nothing for a real user but kills retry loops. Per-process — multi-instance
// deployments get a softer guarantee but the goal is loop-killing, not a
// hard rate limit. The route's auth gate is the trust boundary.
const VERIFY_COOLDOWN_MS = 60_000;
const VERIFY_COOLDOWN_MAX_ENTRIES = 10_000;
const verifyAttemptTimes = new Map<string, number>();
function cooldownKey(orgId: string, domain: string) {
  return `${orgId}:${domain}`;
}
// Bound the map so a buggy client (or attacker who clears the admin gate)
// can't grow it without limit. Drop expired entries first; if still over
// the cap, drop oldest. Cheap because the map is small in practice.
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

export async function issueDomainChallenge(input: {
  workos: WorkOS;
  brandDb: BrandDatabase;
  orgId: string;
  rawDomain: string;
}): Promise<IssueChallengeResult> {
  const { workos, brandDb, orgId, rawDomain } = input;
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

  // Detect orphaned-manifest case so callers can offer the adopt option.
  // Brand row exists, has a non-empty manifest, and was relinquished by a
  // prior owner. If the row is owned by the caller's org or there's no
  // manifest, the adopt decision doesn't apply.
  let priorManifestExists = false;
  try {
    const existingBrand = await brandDb.getHostedBrandByDomain(domain);
    if (existingBrand && existingBrand.manifest_orphaned === true) {
      const manifest = existingBrand.brand_json as Record<string, unknown> | null | undefined;
      priorManifestExists = !!manifest && Object.keys(manifest).length > 0;
    }
  } catch (err) {
    logger.warn({ err, domain }, 'brand-claim: prior-manifest check failed, defaulting to false');
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
        prior_manifest_exists: priorManifestExists,
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
      prior_manifest_exists: priorManifestExists,
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

  // Cooldown gate. DNS propagation can take minutes; the LLM seeing
  // "still_pending" tends to retry immediately. Reject inside the
  // cooldown window with a hint to wait.
  const key = cooldownKey(orgId, domain);
  const now = Date.now();
  const last = verifyAttemptTimes.get(key);
  if (last !== undefined && now - last < VERIFY_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((VERIFY_COOLDOWN_MS - (now - last)) / 1000);
    return {
      ok: false,
      code: 'still_pending',
      message: `Hold off — wait ${retryAfterSeconds}s before re-checking. DNS propagation takes minutes; rapid retries don't help.`,
      state: 'pending',
      retry_after_seconds: retryAfterSeconds,
    };
  }
  trimVerifyAttempts(now);
  verifyAttemptTimes.set(key, now);

  let existing;
  try {
    existing = await workos.organizations.getOrganization(orgId);
  } catch (err) {
    logger.error({ err, orgId, domain }, 'brand-claim: getOrganization failed during verify');
    return { ok: false, code: 'workos_error', message: 'Failed to look up organization.' };
  }
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
      message: 'WorkOS has not confirmed the DNS record yet. DNS propagation can take 5-15 minutes (occasionally longer with slow registrars).',
      state: String(verified.state),
    };
  }

  let updated: HostedBrand | null = null;
  try {
    updated = await brandDb.applyVerifiedBrandClaim(domain, orgId, { adoptPriorManifest });
  } catch (err) {
    logger.error({ err, orgId, domain }, 'brand-claim: applyVerifiedBrandClaim failed after WorkOS verify');
    return { ok: false, code: 'workos_error', message: 'Domain verified with WorkOS but the brand registry write failed. Retry the verify call.' };
  }
  // Verify succeeded — clear cooldown so a follow-up call returns the
  // already-verified path without an artificial wait.
  verifyAttemptTimes.delete(key);
  logger.info({ domain, orgId, adoptPriorManifest, alreadyVerified }, 'Brand claim verified via WorkOS and applied to registry');
  return {
    ok: true,
    domain,
    newly_verified: !alreadyVerified,
    adopted_prior_manifest: adoptPriorManifest,
    brand: updated ? { brand_domain: updated.brand_domain, domain_verified: updated.domain_verified } : null,
  };
}

// Test-only: reset the in-memory cooldown map so suites can run verify back-to-back.
export function _resetVerifyCooldown() {
  verifyAttemptTimes.clear();
}
