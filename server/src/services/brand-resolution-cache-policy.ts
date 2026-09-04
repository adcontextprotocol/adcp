/**
 * Cache policy for the registry's brand-resolution surfaces.
 *
 * Origin-attested identity changes comparatively rarely, while registry
 * contributions and third-party enrichment are advisory and can be corrected
 * independently. Negative results are deliberately brief: keeping either a
 * miss or a failed validation longer would hide a newly published origin
 * document. Keep callers on these helpers so implementation, tests, and the
 * published policy stay aligned.
 */

export type BrandResolutionSource =
  | 'hosted'
  | 'brand_json'
  | 'community'
  | 'enriched'
  | 'stub';

export type BrandResolutionOutcome = BrandResolutionSource | 'miss' | 'error';

/** Outcomes exposed by the public AgenticAdvertising.org-hosted brand.json mirror. */
export type BrandJsonCacheOutcome =
  | 'brand_json'
  | 'community'
  | 'enriched'
  | 'miss'
  | 'error';

/** In-process BrandManager TTLs, in seconds. */
export const BRAND_MANAGER_CACHE_TTL_SECONDS = {
  /** Successfully validated origin evidence and its resolved identity. */
  origin: 24 * 60 * 60,
  /** Origin failures and resolution misses must never outlive each other. */
  negative: 5 * 60,
} as const;

/** Public AgenticAdvertising.org-hosted /brands/:domain/brand.json HTTP TTLs, in seconds. */
export const BRAND_JSON_HTTP_CACHE_TTL_SECONDS = {
  brand_json: 60 * 60,
  community: 15 * 60,
  enriched: 5 * 60,
  /** Genuine not-found results are briefly cacheable to reduce repeated lookups. */
  miss: 60,
} as const;

/** /api/brands/resolve HTTP success and miss TTLs, in seconds. */
export const BRAND_RESOLVE_HTTP_CACHE_TTL_SECONDS = {
  hosted: 5 * 60,
  brand_json: 5 * 60,
  community: 2 * 60,
  enriched: 60,
  stub: 60,
  miss: 30,
} as const;

export function brandManagerResolutionTtlMs(brand: BrandResolutionSource | null): number {
  return 1000 * (brand === null
    ? BRAND_MANAGER_CACHE_TTL_SECONDS.negative
    : BRAND_MANAGER_CACHE_TTL_SECONDS.origin);
}

function publicCacheControl(maxAge: number): string {
  return `public, max-age=${maxAge}`;
}

export function brandJsonCacheControl(
  outcome: BrandJsonCacheOutcome,
): string {
  // A transient database/server failure must never be replayed after recovery.
  if (outcome === 'error') return 'no-store';
  return publicCacheControl(BRAND_JSON_HTTP_CACHE_TTL_SECONDS[outcome]);
}

/**
 * `fresh=true` is an explicit origin-read request, so intermediaries must not
 * reuse or retain it. Resolver errors are likewise never retained. Normal
 * successes and misses use the shortest relevant source/outcome policy.
 */
export function brandResolveCacheControl(
  outcome: BrandResolutionOutcome,
  fresh = false,
): string {
  if (fresh || outcome === 'error') return 'no-store';
  return publicCacheControl(BRAND_RESOLVE_HTTP_CACHE_TTL_SECONDS[outcome]);
}
