/**
 * Identifier normalization for the property catalog.
 *
 * All identifiers are normalized before storage or lookup to prevent
 * duplicates from case differences, protocol prefixes, www/m subdomains, etc.
 */

export interface NormalizeResult {
  type: string;
  value: string;
  modified: boolean;
  reason: string | null;
}

/**
 * Normalize a domain to its canonical form for the brand registry, member
 * profiles, and other surfaces that key on the bare apex.
 * Strips protocol, path, query, fragment, trailing dot, www/m prefix. Lowercases.
 */
export function canonicalizeBrandDomain(raw: string): string {
  return normalizeDomain(raw).value;
}

const BRAND_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Throw if the canonicalized value isn't a plausible domain (multi-label,
 * RFC-1123-ish). Defends against polluting the brands.domain key with values
 * like "localhost", empty strings, or unparseable garbage from upstream
 * profile fields.
 */
export function assertValidBrandDomain(canonical: string): void {
  if (!BRAND_DOMAIN_RE.test(canonical) || canonical.length > 253) {
    throw new Error(`"${canonical}" is not a valid brand domain.`);
  }
}

/**
 * Shared-platform and public-suffix domains where any one tenant claiming
 * the apex would steal the brand identity for thousands of others. WorkOS
 * may or may not reject these at create — defense in depth so the
 * brand-claim flow can't accidentally hand `vercel.app` to one member.
 *
 * Not exhaustive — for full coverage we'd need the public-suffix list
 * from publicsuffix.org. This blocks the highest-volume offenders.
 */
const SHARED_PLATFORM_DOMAINS = new Set<string>([
  // Hosting / serverless
  'vercel.app', 'vercel.com', 'netlify.app', 'netlify.com', 'fly.dev',
  'fly.io', 'render.com', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'cloudfront.net', 'amplifyapp.com', 'replit.app',
  'replit.dev', 'repl.co', 'glitch.me', 'azurewebsites.net', 'herokuapp.com',
  // Content platforms
  'github.io', 'gitlab.io', 'bitbucket.io', 'readthedocs.io',
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'tumblr.com', 'wixsite.com', 'squarespace.com',
  // Common eTLDs that pass the apex regex
  'co.uk', 'co.jp', 'com.au', 'com.br', 'co.in', 'co.nz', 'co.za',
  'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ne.jp', 'or.jp',
]);

/**
 * Throw if a caller is trying to claim a domain that's a shared platform
 * (vercel.app, github.io) or a country-code public suffix (co.uk). Used
 * by the brand-claim flow before issuing a verification challenge —
 * letting one member claim `vercel.app` would steal the brand identity
 * for every Vercel-hosted site.
 */
export function assertClaimableBrandDomain(canonical: string): void {
  assertValidBrandDomain(canonical);
  if (SHARED_PLATFORM_DOMAINS.has(canonical)) {
    throw new Error(`"${canonical}" is a shared platform or public-suffix domain and can't be claimed as a single brand.`);
  }
}

function normalizeDomain(raw: string): { value: string; reason: string | null } {
  let canonical = raw.trim();
  // Strip protocol
  canonical = canonical.replace(/^https?:\/\//i, '');
  // Strip path, query, fragment by finding the first occurrence
  const pathIdx = canonical.search(/[/?#]/);
  if (pathIdx !== -1) canonical = canonical.substring(0, pathIdx);
  // Strip trailing dot and slash
  if (canonical.endsWith('.')) canonical = canonical.slice(0, -1);
  if (canonical.endsWith('/')) canonical = canonical.slice(0, -1);
  canonical = canonical.toLowerCase();

  let reason: string | null = null;

  if (canonical.startsWith('www.')) {
    canonical = canonical.slice(4);
    reason = 'www_stripped';
  } else if (canonical.startsWith('m.')) {
    canonical = canonical.slice(2);
    reason = 'm_stripped';
  } else if (canonical !== raw.trim().toLowerCase()) {
    reason = 'normalized';
  }

  return { value: canonical, reason };
}

/**
 * Normalize a subdomain identifier.
 * Like domain but preserves subdomains (no www/m stripping).
 */
function normalizeSubdomain(raw: string): { value: string; reason: string | null } {
  let canonical = raw.trim();
  canonical = canonical.replace(/^https?:\/\//i, '');
  const pathIdx = canonical.search(/[/?#]/);
  if (pathIdx !== -1) canonical = canonical.substring(0, pathIdx);
  if (canonical.endsWith('.')) canonical = canonical.slice(0, -1);
  if (canonical.endsWith('/')) canonical = canonical.slice(0, -1);
  canonical = canonical.toLowerCase();

  return {
    value: canonical,
    reason: canonical !== raw.trim().toLowerCase() ? 'normalized' : null,
  };
}

/**
 * Normalize an RSS URL.
 * Lowercases scheme and host, preserves path case.
 */
function normalizeRssUrl(raw: string): { value: string; reason: string | null } {
  try {
    const url = new URL(raw.trim());
    const canonical = `${url.protocol}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
    return {
      value: canonical,
      reason: canonical !== raw.trim() ? 'normalized' : null,
    };
  } catch {
    return { value: raw.trim().toLowerCase(), reason: 'normalized' };
  }
}

/**
 * Default normalization: lowercase only.
 */
function normalizeDefault(raw: string): { value: string; reason: string | null } {
  const canonical = raw.trim().toLowerCase();
  return {
    value: canonical,
    reason: canonical !== raw.trim() ? 'normalized' : null,
  };
}

/**
 * Normalize an identifier based on its type.
 */
export function normalizeIdentifier(type: string, value: string): NormalizeResult {
  let result: { value: string; reason: string | null };

  switch (type) {
    case 'domain':
      result = normalizeDomain(value);
      break;
    case 'subdomain':
      result = normalizeSubdomain(value);
      break;
    case 'rss_url':
      result = normalizeRssUrl(value);
      break;
    default:
      // ios_bundle, android_package, apple_app_store_id, google_play_id,
      // roku_store_id, fire_tv_asin, samsung_app_id, apple_tv_bundle,
      // bundle_id, venue_id, screen_id, openooh_venue_type,
      // apple_podcast_id, spotify_collection_id, podcast_guid, network_id
      result = normalizeDefault(value);
      break;
  }

  return {
    type,
    value: result.value,
    modified: result.reason !== null,
    reason: result.reason,
  };
}

/**
 * Normalize a batch of identifiers.
 */
export function normalizeIdentifiers(
  identifiers: Array<{ type: string; value: string }>
): NormalizeResult[] {
  return identifiers.map(({ type, value }) => normalizeIdentifier(type, value));
}
