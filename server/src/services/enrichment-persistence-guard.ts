/**
 * Which enrichment lookups may become registry records (adcp#9024).
 *
 * Every path that turns a Brandfetch lookup into a `brands` row with
 * `source_type: 'enriched'` asks this module first:
 *
 *  - `GET /api/brands/enrich` (`routes/registry-api.ts`)
 *  - the `enrich_brand` MCP tool (`mcp-tools.ts`)
 *  - Addie's `research_brand` tool (`addie/mcp/brand-tools.ts`)
 *  - `enrichBrand()` (`services/brand-enrichment.ts`)
 *
 * The rules only decide whether the result is saved. Callers still return
 * the lookup result, so a refused write is invisible to the caller.
 *
 *  1. Reserved names (RFC 2606, RFC 6761) are never saved.
 *  2. A domain that is not its own registrable domain (eTLD+1 by the Public
 *     Suffix List) is never saved, and neither is a result whose Brandfetch
 *     brand domain differs from the domain asked about. Brandfetch answers a
 *     made-up subdomain with the parent's brand, which is how 103 copies of
 *     one real brand reached the registry. The result is not written under
 *     the registrable domain either: that would let a lookup of one domain
 *     create or refresh the record of another, and the parent gets its own
 *     record when someone looks it up directly.
 *  3. Only authenticated callers create records. An anonymous lookup may
 *     refresh an `enriched` record that already exists for the domain, so the
 *     read cache keeps working, but it never creates one.
 */

import { parse as parseDomain } from 'tldts';
import { canonicalizeBrandDomain } from './identifier-normalization.js';

/** Top-level domains reserved by RFC 2606 and RFC 6761. */
const RESERVED_TLDS: readonly string[] = ['example', 'test', 'invalid', 'localhost'];

/** Second-level names reserved by RFC 2606 section 3, with their subdomains. */
const RESERVED_SECOND_LEVEL_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org'];

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Domain-only reasons, which also select records for the admin cleanup. */
export type EnrichmentDomainRejection = 'invalid_domain' | 'reserved_name' | 'not_registrable_domain';

export type EnrichmentSkipReason =
  | EnrichmentDomainRejection
  | 'brand_domain_mismatch'
  | 'unauthenticated';

export interface EnrichmentDomainClassification {
  /** The canonical form of the domain (lowercased, no protocol, no www/m). */
  domain: string;
  /** eTLD+1 by the Public Suffix List, or null when there is none. */
  registrable_domain: string | null;
  /** Set when the domain may never hold an enrichment record. */
  rejection?: EnrichmentDomainRejection;
}

export type EnrichmentPersistenceDecision =
  | { persist: true; domain: string }
  | { persist: false; domain: string; reason: EnrichmentSkipReason; registrable_domain: string | null };

export interface EnrichmentPersistenceInput {
  /** The domain the caller asked about. */
  requestedDomain: string;
  /** `raw.domain` from Brandfetch: the domain of the brand it answered with. */
  brandfetchDomain?: string | null;
  /** Whether the caller has an identity (user session, API key, or a trusted system path). */
  authenticated: boolean;
  /** The row already stored for the requested domain, if the caller read one. */
  existingRecord?: { source_type?: string | null } | null;
}

function canonical(domain: string): string {
  return canonicalizeBrandDomain(String(domain ?? '').trim());
}

/**
 * True for RFC 2606 / RFC 6761 names: `.example`, `.test`, `.invalid`,
 * `.localhost`, and `example.com`, `example.net`, `example.org` with their
 * subdomains.
 */
export function isReservedDomain(domain: string): boolean {
  const d = canonical(domain);
  if (!d) return false;
  const tld = d.slice(d.lastIndexOf('.') + 1);
  if (RESERVED_TLDS.includes(tld)) return true;
  return RESERVED_SECOND_LEVEL_DOMAINS.some((reserved) => d === reserved || d.endsWith(`.${reserved}`));
}

/** The registrable domain (eTLD+1) by the Public Suffix List, private section included. */
export function getRegistrableDomain(domain: string): string | null {
  const d = canonical(domain);
  if (!d) return null;
  const parsed = parseDomain(d, { allowPrivateDomains: true });
  if (parsed.isIp) return null;
  return parsed.domain ?? null;
}

/**
 * Apply the rules that depend on the domain alone. Shared by the write guard
 * and the admin cleanup, so the cleanup selects exactly the records the guard
 * now refuses to create.
 */
export function classifyEnrichmentDomain(domain: string): EnrichmentDomainClassification {
  const d = canonical(domain);
  if (!d || d.length > 253 || !DOMAIN_SHAPE.test(d)) {
    return { domain: d, registrable_domain: null, rejection: 'invalid_domain' };
  }
  const registrable = getRegistrableDomain(d);
  if (isReservedDomain(d)) {
    return { domain: d, registrable_domain: registrable, rejection: 'reserved_name' };
  }
  if (!registrable || registrable !== d) {
    return { domain: d, registrable_domain: registrable, rejection: 'not_registrable_domain' };
  }
  return { domain: d, registrable_domain: registrable };
}

/** Decide whether an enrichment result may be written to the registry. */
export function decideEnrichmentPersistence(input: EnrichmentPersistenceInput): EnrichmentPersistenceDecision {
  const classification = classifyEnrichmentDomain(input.requestedDomain);
  const { domain, registrable_domain } = classification;
  if (classification.rejection) {
    return { persist: false, domain, reason: classification.rejection, registrable_domain };
  }

  if (input.brandfetchDomain) {
    const answered = canonical(input.brandfetchDomain);
    if (answered && answered !== domain) {
      return { persist: false, domain, reason: 'brand_domain_mismatch', registrable_domain };
    }
  }

  if (!input.authenticated && input.existingRecord?.source_type !== 'enriched') {
    return { persist: false, domain, reason: 'unauthenticated', registrable_domain };
  }

  return { persist: true, domain };
}
