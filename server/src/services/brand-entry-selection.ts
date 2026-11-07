import { canonicalizeBrandDomain } from './identifier-normalization.js';

export interface BrandEntrySelector {
  domain: string;
  /** An already-resolved portfolio ID, not a display name or domain alias. */
  brandId?: string;
  /** Additional house hostnames confirmed by the resolver's HTTPS redirect check. */
  houseDomains?: Iterable<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBrand(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && Array.isArray(value.names) && value.names.length > 0;
}

function publicEntry(brand: Record<string, unknown>): Record<string, unknown> {
  const entry = { ...brand };
  // Historical enrichment context is private/ephemeral, not brand identity.
  delete entry.brand_context;
  return entry;
}

function urlHostname(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.hostname.toLowerCase();
  } catch {
    // An invalid display URL cannot select an identity.
  }
  return undefined;
}

function ownedWebsiteIdentifiers(brand: Record<string, unknown>): string[] {
  if (!Array.isArray(brand.properties)) return [];
  return brand.properties
    .filter(property =>
      isRecord(property) && property.type === 'website'
      && typeof property.identifier === 'string'
      && (property.relationship === undefined || property.relationship === 'owned')
      // Raw/cached documents may use the adagents.json compatibility field.
      // A supplied delegation marker cannot establish owned brand identity.
      && property.delegation_type === undefined)
    .map(property => (property.identifier as string).toLowerCase());
}

function matchesDomain(brand: Record<string, unknown>, domain: string): boolean {
  return urlHostname(brand.url) === domain || ownedWebsiteIdentifiers(brand).includes(domain);
}

/**
 * Domains a house portfolio document names as its brands: each brand_refs[]
 * pointer, plus each inline brand's url and owned websites. Returned as
 * canonical registry domains, without the house's own domain.
 *
 * This is the house's own claim. It never extends relationship trust; the
 * caller decides whether the house is entitled to make it.
 */
export function housePortfolioBrandDomains(document: unknown, houseDomain: string): string[] {
  if (!isRecord(document) || !isRecord(document.house)) return [];
  const house = canonicalizeBrandDomain(houseDomain);
  if (typeof document.house.domain !== 'string' || canonicalizeBrandDomain(document.house.domain) !== house) {
    return [];
  }

  const declared = new Set<string>();
  const brands = Array.isArray(document.brands) ? document.brands.filter(isBrand) : [];
  for (const brand of brands) {
    const hostname = urlHostname(brand.url);
    if (hostname) declared.add(canonicalizeBrandDomain(hostname));
    for (const identifier of ownedWebsiteIdentifiers(brand)) declared.add(canonicalizeBrandDomain(identifier));
  }
  const pointers = Array.isArray(document.brand_refs) ? document.brand_refs : [];
  for (const pointer of pointers) {
    if (isRecord(pointer) && typeof pointer.domain === 'string') {
      declared.add(canonicalizeBrandDomain(pointer.domain));
    }
  }
  declared.delete(house);
  declared.delete('');
  return [...declared];
}

/**
 * Select one complete brand entry without renaming localized/creative fields.
 * This only inspects a document: it never follows pointers, extends trust,
 * guesses from a name, or falls back to the first portfolio entry.
 */
export function selectBrandEntry(
  document: unknown,
  selector: BrandEntrySelector,
): Record<string, unknown> | undefined {
  if (!isRecord(document) || typeof document.authoritative_location === 'string'
    || typeof document.house === 'string') return undefined;

  if (isBrand(document) && !isRecord(document.house)
    && document.brands === undefined && document.brand_refs === undefined) {
    return selector.brandId === undefined || document.id === selector.brandId
      ? publicEntry(document) : undefined;
  }

  if (!isRecord(document.house) || typeof document.house.domain !== 'string') return undefined;
  const brands = Array.isArray(document.brands) ? document.brands : [];
  // Invalid siblings cannot be silently discarded to manufacture uniqueness.
  if (!brands.every(isBrand)) return undefined;
  const pointers = Array.isArray(document.brand_refs) ? document.brand_refs : [];
  const domain = selector.domain.toLowerCase();
  const matches = selector.brandId === undefined
    ? brands.filter(brand => matchesDomain(brand, domain))
    : brands.filter(brand => brand.id === selector.brandId);
  const pointerMatches = pointers.filter(pointer => isRecord(pointer) && (
    selector.brandId === undefined
      ? typeof pointer.domain === 'string' && pointer.domain.toLowerCase() === domain
      : pointer.brand_id === selector.brandId
  ));
  if (matches.length + pointerMatches.length > 1) return undefined;
  if (matches.length === 1) return publicEntry(matches[0]);
  if (selector.brandId !== undefined || pointerMatches.length > 0) return undefined;

  const houseDomains = new Set([domain, ...(selector.houseDomains ?? [])].map(host => host.toLowerCase()));
  if (!houseDomains.has(document.house.domain.toLowerCase())) return undefined;
  const masters = brands.filter(brand => brand.keller_type === 'master');
  if (masters.length === 1) return publicEntry(masters[0]);
  if (masters.length === 0 && brands.length === 1 && pointers.length === 0) return publicEntry(brands[0]);
  return undefined;
}
