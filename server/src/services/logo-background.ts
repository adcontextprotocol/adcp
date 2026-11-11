/**
 * Which background a brand logo is drawn for.
 *
 * Precedence, highest first:
 * 1. a `background` the logo object declares (brand.json's own field);
 * 2. a light-bg / dark-bg / transparent-bg tag on the logo;
 * 3. for AAO-hosted logos, the background derived from the rendered pixels
 *    (brand_logos.derived_background).
 *
 * A declared value is never overwritten, even one outside the enum.
 */

import { BrandLogoDatabase } from '../db/brand-logo-db.js';
import { isUuid } from '../utils/uuid.js';
import { createLogger } from '../logger.js';
import { isLogoBackground, type LogoBackground } from './logo-rendition.js';

const logger = createLogger('logo-background');

const PRODUCTION_HOST = 'agenticadvertising.org';

/** The first background tag, if the tags declare one. */
export function backgroundFromTags(tags: unknown): LogoBackground | undefined {
  if (!Array.isArray(tags)) return undefined;
  return tags.find(isLogoBackground);
}

function hostedLogoHosts(): Set<string> {
  const hosts = new Set([PRODUCTION_HOST]);
  try {
    hosts.add(new URL(process.env.BASE_URL || `https://${PRODUCTION_HOST}`).hostname.toLowerCase());
  } catch {
    // An unparseable BASE_URL leaves only the production host.
  }
  return hosts;
}

/**
 * Parse an AAO-hosted logo URL into its domain and logo id. Accepts the
 * `/assets/brands/{domain}/{id}.{ext}` and legacy `/logos/brands/{domain}/{id}`
 * forms, absolute on an AAO host or relative. Returns null for anything else.
 */
export function parseHostedLogoUrl(url: unknown): { domain: string; id: string } | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let pathname: string;
  if (url.startsWith('/') && !url.startsWith('//')) {
    pathname = url.split(/[?#]/, 1)[0];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!hostedLogoHosts().has(parsed.hostname.toLowerCase())) return null;
    pathname = parsed.pathname;
  }

  const segments = pathname.split('/');
  // ['', 'assets'|'logos', 'brands', domain, id[.ext]]
  if (segments.length !== 5 || segments[0] !== '' || segments[2] !== 'brands') return null;
  let domain: string;
  try {
    domain = decodeURIComponent(segments[3]).toLowerCase();
  } catch {
    return null;
  }
  if (!domain) return null;
  let id: string;
  if (segments[1] === 'assets') {
    const dot = segments[4].lastIndexOf('.');
    if (dot <= 0) return null;
    id = segments[4].slice(0, dot);
  } else if (segments[1] === 'logos') {
    id = segments[4];
  } else {
    return null;
  }
  return isUuid(id) ? { domain, id: id.toLowerCase() } : null;
}

type LogoRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LogoRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaresBackground(logo: LogoRecord): boolean {
  return logo.background !== undefined && logo.background !== null;
}

/**
 * Map every logo object in a brand.json-shaped container: `logos[]`, a single
 * `logo`, and the same inside `brands[]`. Returns the container unchanged when
 * there is nothing to map, otherwise a shallow copy; inputs are never mutated,
 * since resolver results can be cached objects.
 */
function mapLogos(container: unknown, fn: (logo: LogoRecord) => LogoRecord): unknown {
  if (!isRecord(container)) return container;
  let out: LogoRecord | undefined;
  const set = (key: string, value: unknown) => {
    out ??= { ...container };
    out[key] = value;
  };
  if (Array.isArray(container.logos)) {
    set('logos', container.logos.map((logo) => (isRecord(logo) ? fn(logo) : logo)));
  }
  if (isRecord(container.logo)) {
    set('logo', fn(container.logo));
  }
  if (Array.isArray(container.brands)) {
    set('brands', container.brands.map((brand) => mapLogos(brand, fn)));
  }
  return out ?? container;
}

export interface LogoBackgroundCarrier {
  brand_manifest?: Record<string, unknown>;
  brand?: Record<string, unknown>;
}

/**
 * Fill in `background` on every logo in each response's `brand_manifest` and
 * `brand` that does not declare one, using tags and then the stored derived
 * background of AAO-hosted logos. One database read covers all responses.
 * On a database error the responses come back with declared and tag-derived
 * backgrounds only.
 */
export async function annotateLogoBackgrounds<T extends LogoBackgroundCarrier>(
  responses: T[],
  brandLogoDb: Pick<BrandLogoDatabase, 'getApprovedLogoBackgrounds'> = new BrandLogoDatabase(),
): Promise<T[]> {
  const hostedIds = new Set<string>();
  const collect = (logo: LogoRecord) => {
    if (!declaresBackground(logo) && !backgroundFromTags(logo.tags)) {
      const hosted = parseHostedLogoUrl(logo.url);
      if (hosted) hostedIds.add(hosted.id);
    }
    return logo;
  };
  for (const response of responses) {
    mapLogos(response.brand_manifest, collect);
    mapLogos(response.brand, collect);
  }

  let stored: Awaited<ReturnType<BrandLogoDatabase['getApprovedLogoBackgrounds']>> = new Map();
  if (hostedIds.size > 0) {
    try {
      stored = await brandLogoDb.getApprovedLogoBackgrounds([...hostedIds]);
    } catch (err) {
      logger.warn({ err }, 'Failed to load derived logo backgrounds');
    }
  }

  const fill = (logo: LogoRecord): LogoRecord => {
    if (declaresBackground(logo)) return logo;
    let background: LogoBackground | null | undefined = backgroundFromTags(logo.tags);
    if (!background) {
      const hosted = parseHostedLogoUrl(logo.url);
      const row = hosted ? stored.get(hosted.id) : undefined;
      if (row && row.domain === hosted!.domain) {
        background = backgroundFromTags(row.tags) ?? row.derived_background;
      }
    }
    return background ? { ...logo, background } : logo;
  };

  return responses.map((response) => {
    const out = { ...response };
    if (response.brand_manifest !== undefined) {
      out.brand_manifest = mapLogos(response.brand_manifest, fill) as T['brand_manifest'];
    }
    if (response.brand !== undefined) {
      out.brand = mapLogos(response.brand, fill) as T['brand'];
    }
    return out;
  });
}
