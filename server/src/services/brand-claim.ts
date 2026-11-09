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

import { promises as dns } from 'node:dns';
import type { WorkOS } from '@workos-inc/node';
import { BrandDatabase, workosDomainVerificationStrategy } from '../db/brand-db.js';
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
      dns_record_name: string;
      dns_record_type: 'TXT';
      dns_record_value: string | null;
      already_verified: boolean;
      // True when a brand row exists for this domain with an orphaned manifest
      // (a prior owner relinquished). Tells callers whether to surface the
      // adopt-vs-fresh decision when the user runs verify.
      prior_manifest_exists: boolean;
    }
  | { ok: false; code: 'invalid_domain'; message: string }
  | { ok: false; code: 'collision'; message: string }
  | { ok: false; code: 'manual_domain_upgrade'; message: string }
  | { ok: false; code: 'workos_error'; message: string }
  // Kept for API compatibility with older callers. Current WorkOS Domain
  // Verification may return no verification_prefix, which means the TXT
  // record name is the domain apex itself.
  | { ok: false; code: 'workos_misconfigured'; message: string };

export type VerifyChallengeResult =
  | {
      ok: true;
      domain: string;
      newly_verified: boolean;
      adopted_prior_manifest: boolean;
      brand: { brand_domain: string; domain_verified: boolean } | null;
    }
  | { ok: false; code: 'no_challenge'; message: string }
  | {
      ok: false;
      code: 'still_pending';
      message: string;
      state: string;
      retry_after_seconds?: number;
      dns_record_name?: string;
      /** The TXT value WorkOS expects now; it changes after every failed check. */
      dns_record_value?: string;
    }
  | { ok: false; code: 'manual_domain'; message: string }
  | { ok: false; code: 'verified_elsewhere'; message: string }
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

function dnsRecordName(domain: string, verificationPrefix?: string | null): string {
  return verificationPrefix ? `${verificationPrefix}.${domain}` : domain;
}

/** The TXT value WorkOS checks for a pending domain's current token. */
function dnsRecordValue(verificationToken: string): string {
  return `verification_token=${verificationToken}`;
}

/** TXT values published at `name`; none when the name does not resolve. */
async function publishedTxtValues(
  resolveTxt: (name: string) => Promise<string[][]>,
  name: string,
): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map(chunks => chunks.join(''));
  } catch (err) {
    logger.debug({ err, name }, 'brand-claim: TXT lookup found nothing');
    return [];
  }
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

/** Methods that prove control of a domain (see BrandDatabase.syncBrandDomainFromWorkos). */
const PROOF_METHODS = new Set(['dns', 'brand_json', 'member_email']);

export async function issueDomainChallenge(input: {
  workos: WorkOS;
  brandDb: BrandDatabase;
  orgId: string;
  rawDomain: string;
  /**
   * Replace a domain an administrator marked verified in WorkOS (strategy
   * `manual`) with a DNS challenge. The domain stops being a verified domain
   * of the organization until the DNS record verifies, so callers must ask.
   */
  replaceManualDomain?: boolean;
}): Promise<IssueChallengeResult> {
  const { workos, brandDb, orgId, rawDomain, replaceManualDomain = false } = input;
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
  let registryHoldsProof = false;
  try {
    const existingBrand = await brandDb.getHostedBrandByDomain(domain);
    registryHoldsProof = !!existingBrand
      && existingBrand.workos_organization_id === orgId
      && existingBrand.domain_verified
      && PROOF_METHODS.has(existingBrand.domain_verification_method ?? '');
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
  //
  // Broken state: WorkOS returned a pending domain with no verificationToken.
  // Recoverable — delete and recreate produces a usable challenge. A missing
  // verificationPrefix is valid; it means publish the TXT at the domain apex.
  try {
    const existing = await workos.organizations.getOrganization(orgId);
    const existingDomain = existing.domains.find(d => d.domain.toLowerCase() === domain);
    if (existingDomain) {
      const verified = isVerifiedState(existingDomain.state);
      const tokenMissing = !existingDomain.verificationToken;
      // An administrator's assertion is not proof of control. Unless the
      // registry already holds proof for this org, offer to replace it with
      // a DNS challenge.
      const unprovenManual = verified
        && workosDomainVerificationStrategy(existingDomain.verificationStrategy) === 'manual'
        && !registryHoldsProof;
      if (unprovenManual && !replaceManualDomain) {
        return {
          ok: false,
          code: 'manual_domain_upgrade',
          message: `${domain} was added to this organization by an AgenticAdvertising.org administrator, which does not prove control of the domain. To verify it by DNS, issue the challenge again with replace_manual_domain set to true. Until the DNS record is verified, ${domain} stops being a verified domain of this organization: people with email addresses on it are not added automatically, and agents cannot be newly registered on it.`,
        };
      }
      if (unprovenManual) {
        logger.info({ orgId, domain, existingDomainId: existingDomain.id },
          'brand-claim: replacing administrator-asserted domain with a DNS challenge');
        try {
          await workos.organizationDomains.deleteOrganizationDomain(existingDomain.id);
        } catch (err) {
          logger.error({ err, orgId, domain, existingDomainId: existingDomain.id }, 'brand-claim: failed to delete administrator-asserted org-domain');
          return { ok: false, code: 'workos_error', message: 'Failed to replace the administrator-added domain with a DNS challenge. Try again or contact support.' };
        }
        // Fall through to the create branch below.
      } else if (!verified && tokenMissing) {
        logger.warn(
          { orgId, domain, existingDomainId: existingDomain.id, state: String(existingDomain.state) },
          'brand-claim: existing org-domain has null verificationToken; deleting to recreate',
        );
        try {
          await workos.organizationDomains.deleteOrganizationDomain(existingDomain.id);
        } catch (err) {
          logger.error({ err, orgId, domain, existingDomainId: existingDomain.id }, 'brand-claim: failed to delete broken existing org-domain');
          return { ok: false, code: 'workos_error', message: 'Failed to clear a broken pending challenge for this domain. Try again or contact support.' };
        }
        // Fall through to the create branch below.
      } else {
        return {
          ok: true,
          domain,
          workos_domain_id: existingDomain.id,
          state: String(existingDomain.state),
          verification_strategy: existingDomain.verificationStrategy ?? null,
          verification_token: existingDomain.verificationToken ?? null,
          verification_prefix: existingDomain.verificationPrefix ?? null,
          dns_record_name: dnsRecordName(domain, existingDomain.verificationPrefix),
          dns_record_type: 'TXT',
          dns_record_value: existingDomain.verificationToken ?? null,
          already_verified: verified,
          prior_manifest_exists: priorManifestExists,
        };
      }
    }
  } catch (err) {
    logger.warn({ err, orgId }, 'brand-claim: org pre-check failed, will attempt create');
  }

  try {
    const created = await workos.organizationDomains.createOrganizationDomain({ organizationId: orgId, domain });
    return {
      ok: true,
      domain,
      workos_domain_id: created.id,
      state: String(created.state),
      verification_strategy: created.verificationStrategy ?? 'dns',
      verification_token: created.verificationToken ?? null,
      verification_prefix: created.verificationPrefix ?? null,
      dns_record_name: dnsRecordName(domain, created.verificationPrefix),
      dns_record_type: 'TXT',
      dns_record_value: created.verificationToken ?? null,
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
    logger.error({ err, orgId, domain }, 'workos.organizationDomains.createOrganizationDomain failed');
    return { ok: false, code: 'workos_error', message: 'Failed to issue domain verification challenge.' };
  }
}

export async function verifyDomainChallenge(input: {
  workos: WorkOS;
  brandDb: BrandDatabase;
  orgId: string;
  rawDomain: string;
  adoptPriorManifest?: boolean;
  /** Injected for tests; defaults to the system resolver. */
  resolveTxt?: (name: string) => Promise<string[][]>;
}): Promise<VerifyChallengeResult> {
  const { workos, brandDb, orgId, rawDomain, adoptPriorManifest = false, resolveTxt = dns.resolveTxt } = input;
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
    const recordName = dnsRecordName(domain, existingDomain.verificationPrefix);
    const recordValue = existingDomain.verificationToken
      ? dnsRecordValue(existingDomain.verificationToken)
      : undefined;
    // WorkOS issues a new token after every failed check, so asking it to
    // verify a stale record only moves the target again. Check first.
    if (recordValue && !(await publishedTxtValues(resolveTxt, recordName)).includes(recordValue)) {
      return {
        ok: false,
        code: 'still_pending',
        message: `The DNS TXT record at ${recordName} must be exactly ${recordValue}. WorkOS issues a new value after every failed check, so replace any older value, then retry.`,
        state: String(existingDomain.state),
        dns_record_name: recordName,
        dns_record_value: recordValue,
      };
    }
    try {
      verified = await workos.organizationDomains.verifyOrganizationDomain(existingDomain.id);
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if (status === 422 || status === 400) {
        return {
          ok: false,
          code: 'still_pending',
          message: `WorkOS could not find a matching DNS TXT record. Make sure ${recordName} is published with the verification token, then retry.`,
          state: String(existingDomain.state),
          dns_record_name: recordName,
          ...(recordValue ? { dns_record_value: recordValue } : {}),
        };
      }
      logger.error({ err, orgId, domain }, 'workos.organizationDomains.verifyOrganizationDomain failed');
      return { ok: false, code: 'workos_error', message: 'Failed to verify domain.' };
    }
  }

  if (!isVerifiedState(verified.state)) {
    // A check that did not confirm leaves WorkOS holding a new token; hand
    // the caller the value to publish now.
    let current = verified;
    try {
      current = await workos.organizationDomains.getOrganizationDomain(existingDomain.id);
    } catch (err) {
      logger.warn({ err, orgId, domain }, 'brand-claim: could not re-read the domain after an unconfirmed check');
    }
    const recordName = dnsRecordName(domain, current.verificationPrefix);
    return {
      ok: false,
      code: 'still_pending',
      message: current.verificationToken
        ? `WorkOS has not confirmed the DNS record yet, and it now expects ${dnsRecordValue(current.verificationToken)} at ${recordName}. Update the record if it holds an older value; DNS changes can take a few minutes to propagate.`
        : 'WorkOS has not confirmed the DNS record yet. DNS propagation can take 5-15 minutes (occasionally longer with slow registrars).',
      state: String(current.state),
      dns_record_name: recordName,
      ...(current.verificationToken ? { dns_record_value: dnsRecordValue(current.verificationToken) } : {}),
    };
  }

  const method = await brandDb.resolveWorkosDomainVerification(
    domain,
    orgId,
    workosDomainVerificationStrategy(verified.verificationStrategy),
  );
  if (method === 'manual') {
    return {
      ok: false,
      code: 'manual_domain',
      message: `${domain} was marked verified by an AgenticAdvertising.org administrator, which does not prove control of the domain. Verify it by DNS (issue the challenge again with replace_manual_domain set to true), point ${domain}/.well-known/brand.json at the hosted brand record, or sign in with a verified email address on ${domain}.`,
    };
  }

  let updated: HostedBrand | null = null;
  try {
    updated = await brandDb.applyVerifiedBrandClaim(domain, orgId, method, { adoptPriorManifest });
  } catch (err) {
    logger.error({ err, orgId, domain }, 'brand-claim: applyVerifiedBrandClaim failed after WorkOS verify');
    return { ok: false, code: 'workos_error', message: 'Domain verified with WorkOS but the brand registry write failed. Retry the verify call.' };
  }
  if (!updated) {
    return {
      ok: false,
      code: 'verified_elsewhere',
      message: `Another organization has verified ${domain}. Only DNS verification can move a verified brand to a new organization.`,
    };
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
    brand: { brand_domain: updated.brand_domain, domain_verified: updated.domain_verified },
  };
}

// Test-only: reset the in-memory cooldown map so suites can run verify back-to-back.
export function _resetVerifyCooldown() {
  verifyAttemptTimes.clear();
}
