import { parse as parseDomain } from 'tldts';
import { TrustEvaluator, assertPublishableTrustRecord, type TrustGrant } from '@adcp/sdk/identity-3.3';
import { canonicalAgentOrigin } from '@adcp/sdk/signing/client';
import type { BrandManager } from '../brand-manager.js';
import { Cache } from '../cache.js';
import { normalizeExternalHostname } from '../utils/url-security.js';

export const INVALID_DOMAIN_MESSAGE = 'Enter a public domain such as yourbrand.com, without a path or port.';
export const LOOKUP_BUSY_MESSAGE = 'Lookups are busy. Try again shortly.';
export class InvalidTrustLookupDomain extends Error {}
export class TrustLookupBusy extends Error {}

/** Accept a domain or its HTTPS origin, never an arbitrary fetch URL. */
export function normalizeTrustLookupDomain(input: string): string {
  try {
    // A domain never contains '@'; rejecting it up front excludes URL userinfo.
    if (!input.trim() || input.length > 512 || input.includes('@')) throw new Error();
    const url = new URL(input.includes('://') ? input.trim() : `https://${input.trim()}`);
    const domain = normalizeExternalHostname(url.hostname);
    if (url.protocol !== 'https:' || url.port
      || url.pathname !== '/' || url.search || url.hash || !domain || domain.length > 253) throw new Error();
    const parsed = parseDomain(domain, { allowPrivateDomains: true, detectSpecialUse: true });
    if (parsed.isIp || parsed.isSpecialUse || !parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) throw new Error();
    return domain;
  } catch {
    throw new InvalidTrustLookupDomain(INVALID_DOMAIN_MESSAGE);
  }
}

/** Display an agent by its canonical origin, or as published if it cannot be canonicalized. */
function displayOrigin(url: string): string {
  try { return canonicalAgentOrigin(url); } catch { return url; }
}

function registrableDomain(domain: string): string {
  const normalized = normalizeTrustLookupDomain(domain);
  return parseDomain(normalized, { allowPrivateDomains: true }).domain!;
}

interface PublishedGrant {
  grantee: string;
  scopes: string[];
  agents: string[] | null;
  brands: string[] | null;
  countries: string[] | null;
  valid_from: string | null;
  valid_until: string | null;
  status: 'active' | 'expired' | 'scheduled' | 'invalid';
}

export interface TrustLookupResult {
  domain: string;
  status: 'published' | 'not_found' | 'unavailable' | 'unverified_parent';
  authority_domain: string | null;
  record_url: string | null;
  checked_at: string;
  claim_url: string;
  brand_name: string | null;
  brand_id: string | null;
  parent_domain: string | null;
  relationship_verified_at: string | null;
  message: string;
  exclusive_grants: boolean;
  exclusive_scopes: string[];
  agents: Array<{ origin: string; roles: string[]; countries: string[] | null }>;
  grants: PublishedGrant[];
  total_agents: number;
  total_grants: number;
  matching_grants: number;
}

type BrandResolver = Pick<BrandManager, 'resolveBrandWithDiagnostics'>;
type RecordReader = Pick<TrustEvaluator, 'get'>;

/**
 * A current-publication inspector, never a request authorizer. No registry
 * enrichment or seller-private approvals enter this result. In particular,
 * not_found describes today's public response, not a seller's adoption history.
 */
export class TrustLookupService {
  private readonly cache = new Cache<TrustLookupResult>(1, 500);
  private readonly pending = new Map<string, Promise<TrustLookupResult>>();

  constructor(
    private readonly brandManager: BrandResolver,
    // A reader belongs to this inspection, not an unlimited public authority
    // history. SDK fetches enforce SSRF, strict JSON, 2 MiB, and one pointer.
    private readonly createReader: () => RecordReader = () => new TrustEvaluator({ pollingIntervalSeconds: 60 }),
    private readonly now: () => number = Date.now,
  ) {}

  async lookup(input: string): Promise<TrustLookupResult> {
    const domain = normalizeTrustLookupDomain(input);
    const cached = this.cache.get(domain);
    if (cached) return cached;
    const pending = this.pending.get(domain);
    if (pending) return pending;
    if (this.pending.size >= 8) throw new TrustLookupBusy(LOOKUP_BUSY_MESSAGE);
    const request = this.inspect(domain).then(result => {
      this.cache.set(domain, result, result.status === 'unavailable' ? 10_000 : 60_000);
      return result;
    }).finally(() => { this.pending.delete(domain); });
    this.pending.set(domain, request);
    return request;
  }

  private async inspect(domain: string): Promise<TrustLookupResult> {
    const authority = registrableDomain(domain);
    const result: TrustLookupResult = {
      domain, status: 'unavailable', authority_domain: authority,
      record_url: `https://${authority}/.well-known/trust.json`, checked_at: new Date(this.now()).toISOString(),
      claim_url: `https://agenticadvertising.org/brand/builder?domain=${encodeURIComponent(domain)}`,
      brand_name: null, brand_id: null, parent_domain: null, relationship_verified_at: null,
      message: 'We couldn’t read or validate this domain’s record right now. That doesn’t mean it’s unprotected. Try again later.',
      exclusive_grants: false, exclusive_scopes: [], agents: [], grants: [],
      total_agents: 0, total_grants: 0, matching_grants: 0,
    };

    try {
      const { brand, last_attempt: attempt } = await this.brandManager.resolveBrandWithDiagnostics(domain, { skipCache: true });
      // Only a genuine miss at the original discovery URL permits inspection
      // without identity data. A failed pointer/parent fetch is not that miss.
      const missingBrandFile = attempt && [404, 410].includes(attempt.status_code ?? 0)
        && attempt.url === `https://${domain}/.well-known/brand.json`;
      if (!brand && (!attempt || (!attempt.valid && !missingBrandFile))) {
        const crossDomainRedirect = attempt?.errors.some(error => error.field === 'network'
          && error.message.startsWith('Refused redirect outside original host/www pair:'));
        result.message = crossDomainRedirect
          ? 'This domain’s brand.json redirects to another site. A website redirect does not verify parent authority, so the brand needs its own brand.json (or a pointer) on this domain.'
          : 'We couldn’t check this brand’s identity or parent company right now. Try again later. This doesn’t mean the brand is unprotected.';
        return result;
      }
      if (brand && brand.source !== 'brand_json') {
        result.message = 'This brand hasn’t published its own brand.json, so there’s no domain-controlled identity to check. Registry data alone can’t establish who speaks for it.';
        return result;
      }
      result.brand_name = brand?.brand_name.slice(0, 256) ?? null;
      const brandId = brand?.canonical_id.split('#').at(-1) ?? null;
      if (brandId && brandId.length > 512) {
        result.message = 'The brand identifier exceeds this lookup’s display limit. Review the source identity record.';
        return result;
      }
      result.brand_id = brandId;
      const verifiedParent = brand?.house_domain
        && (brand.relationship_trust === 'mutual' || brand.relationship_trust === 'inline');
      if (brand && (brand.claimed_house_domain || brand.house_domain
        || ['leaf_only', 'house_only', 'unverifiable'].includes(brand.relationship_trust ?? '')) && !verifiedParent) {
        result.status = 'unverified_parent';
        result.authority_domain = null;
        result.record_url = null;
        const claimedParent = brand.claimed_house_domain ?? brand.house_domain;
        result.parent_domain = claimedParent && claimedParent.length <= 253 ? claimedParent : null;
        result.message = 'This brand names a parent company, but the parent doesn’t list it back. Until both brand.json records match, the parent’s list doesn’t apply.';
        return result;
      }
      if (verifiedParent) {
        result.authority_domain = registrableDomain(brand!.house_domain!);
        result.parent_domain = result.authority_domain !== authority ? brand!.house_domain! : null;
        result.relationship_verified_at = brand!.relationship_verified_at ?? null;
        result.record_url = `https://${result.authority_domain}/.well-known/trust.json`;
      }

      const record = await this.createReader().get(result.authority_domain!);
      result.checked_at = new Date(record.checkedAt * 1000).toISOString();
      if (record.status === 'absent') {
        result.status = 'not_found';
        result.message = `${result.authority_domain} hasn’t published a trust.json, so there’s no public list of who can act for this brand. Individual sellers may retain earlier records or have their own approvals.`;
        return result;
      }
      result.status = 'published';
      result.message = result.parent_domain
        ? `Covered by its parent company, ${result.authority_domain}. The brand doesn’t need its own trust.json; sellers use the parent’s list.`
        : `${result.authority_domain} publishes its own list of who can act for it.`;
      const agents = record.record.agents ?? [];
      const grants = record.record.grants ?? [];
      const matching = grants.filter(grant => {
        const brands = grant.profiles?.adcp?.brands;
        return !result.brand_id || !brands || brands.includes('*') || brands.includes(result.brand_id);
      });
      result.exclusive_grants = record.record.exclusive_grants === true;
      result.exclusive_scopes = result.exclusive_grants ? [...new Set(grants.flatMap(grant => grant.scopes))] : [];
      result.total_agents = agents.length;
      result.total_grants = grants.length;
      result.matching_grants = matching.length;
      result.agents = agents.slice(0, 100).map(agent => ({
        origin: displayOrigin(agent.url), roles: agent.roles, countries: agent.countries ?? null,
      }));
      result.grants = matching.slice(0, 100).map(grant => this.summarizeGrant(grant));
      // A few entries can still carry enormous scope/brand arrays. Bound the
      // public response and cached value as well as the upstream body and rows.
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) {
        result.status = 'unavailable';
        result.message = 'A trust record was found, but its declarations exceed this lookup’s display limit. Read the source record for the complete publication.';
        result.agents = [];
        result.grants = [];
        result.exclusive_scopes = [];
      }
      return result;
    } catch {
      // No exception (including schema, SSRF, timeout or HTTP errors) is a
      // confirmed absent record. Do not expose upstream error text to callers.
      result.status = 'unavailable';
      result.agents = [];
      result.grants = [];
      return result;
    }
  }

  private summarizeGrant(grant: TrustGrant): PublishedGrant {
    let status: PublishedGrant['status'] = 'active';
    try {
      assertPublishableTrustRecord({ grants: [grant] });
      if (grant.valid_from && grant.valid_until && Date.parse(grant.valid_from) >= Date.parse(grant.valid_until)) {
        status = 'invalid';
      } else if (grant.valid_until && Date.parse(grant.valid_until) <= this.now()) status = 'expired';
      else if (grant.valid_from && Date.parse(grant.valid_from) > this.now()) status = 'scheduled';
    } catch { status = 'invalid'; }
    return {
      grantee: grant.grantee, scopes: grant.scopes,
      agents: grant.agents?.map(agent => displayOrigin(agent.url)) ?? null,
      brands: grant.profiles?.adcp?.brands ?? null, countries: grant.countries ?? null,
      valid_from: grant.valid_from ?? null, valid_until: grant.valid_until ?? null, status,
    };
  }
}
