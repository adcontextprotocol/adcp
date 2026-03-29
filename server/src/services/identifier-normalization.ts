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
 * Normalize a domain to its canonical form.
 * Strips protocol, path, query, fragment, trailing dot, www/m prefix. Lowercases.
 */
function normalizeDomain(raw: string): { value: string; reason: string | null } {
  let canonical = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
    .replace(/\/$/, '')
    .toLowerCase();

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
  const canonical = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
    .replace(/\/$/, '')
    .toLowerCase();

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
