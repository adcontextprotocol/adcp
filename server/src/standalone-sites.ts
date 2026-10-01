/**
 * Standalone standard sites served from this app: brandjson.org (brand.json)
 * and trustjson.org (trust.json). They are neutral homes for open standards
 * stewarded by AgenticAdvertising.org, so they expose only their own pages,
 * schemas, and the public read APIs those pages need. Everything else stays on
 * agenticadvertising.org.
 */

export type StandaloneSite = 'brandjson' | 'trustjson';

const APEX_HOSTS: Record<StandaloneSite, string> = {
  brandjson: 'brandjson.org',
  trustjson: 'trustjson.org',
};

const SITE_BY_HOST = new Map<string, StandaloneSite>([
  ['brandjson.org', 'brandjson'],
  ['www.brandjson.org', 'brandjson'],
  ['trustjson.org', 'trustjson'],
  ['www.trustjson.org', 'trustjson'],
]);

const AAO_ORIGIN = 'https://agenticadvertising.org';

export function getStandaloneSite(hostname: string | undefined): StandaloneSite | null {
  if (!hostname) return null;
  return SITE_BY_HOST.get(hostname.toLowerCase()) ?? null;
}

export function standaloneSiteOrigin(site: StandaloneSite): string {
  return `https://${APEX_HOSTS[site]}`;
}

export type StandaloneDecision =
  /** Serve an HTML page from server/public. */
  | { kind: 'page'; file: string }
  /** Rewrite the request path and continue to the existing route. */
  | { kind: 'rewrite'; url: string }
  /** Continue unchanged (assets, schemas, allowed APIs). */
  | { kind: 'pass' }
  | { kind: 'redirect'; status: 301 | 302; location: string }
  | { kind: 'text'; contentType: string; body: string }
  | { kind: 'not_found' };

const STATIC_ASSET = /^\/[A-Za-z0-9._\/-]+\.(css|js|svg|png|ico|jpg|jpeg|webp|gif|woff2?|ttf)$/;

function queryOf(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? '' : url.slice(i);
}

function robotsTxt(site: StandaloneSite): string {
  const origin = standaloneSiteOrigin(site);
  return `User-agent: *\nAllow: /\n\n# ${APEX_HOSTS[site]}\nSitemap: ${origin}/sitemap.xml\n`;
}

function sitemapXml(site: StandaloneSite): string {
  const origin = standaloneSiteOrigin(site);
  const paths = site === 'brandjson' ? ['/', '/builder'] : ['/'];
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function llmsTxt(site: StandaloneSite): string {
  if (site === 'brandjson') {
    return [
      '# brand.json',
      '',
      '> An open standard for publishing brand identity at /.well-known/brand.json so AI agents can find it. Stewarded by AgenticAdvertising.org.',
      '',
      '- [Builder and validator](https://brandjson.org/builder): create or check a brand.json',
      '- [Specification](https://docs.adcontextprotocol.org/docs/brand-protocol/brand-json)',
      '- [JSON Schema](https://brandjson.org/schemas/v3/brand.json)',
      '',
    ].join('\n');
  }
  return [
    '# trust.json',
    '',
    '> Draft open standard for publishing which agents an organization runs, their keys, and who may act on its behalf, at /.well-known/trust.json. Stewarded by AgenticAdvertising.org.',
    '',
    '- [RFC](https://github.com/adcontextprotocol/adcp/issues/7809)',
    '- [Draft specification](https://github.com/adcontextprotocol/adcp/pull/7819)',
    '',
  ].join('\n');
}

/**
 * Decide how to handle a request on a standalone site host.
 * `path` is req.path; `url` is req.originalUrl (path + query).
 */
export function resolveStandaloneRequest(
  site: StandaloneSite,
  hostname: string,
  method: string,
  path: string,
  url: string,
): StandaloneDecision {
  const apex = APEX_HOSTS[site];
  if (hostname.toLowerCase() !== apex) {
    return { kind: 'redirect', status: 301, location: `https://${apex}${url}` };
  }

  if (path === '/robots.txt') return { kind: 'text', contentType: 'text/plain; charset=utf-8', body: robotsTxt(site) };
  if (path === '/sitemap.xml') return { kind: 'text', contentType: 'application/xml; charset=utf-8', body: sitemapXml(site) };
  if (path === '/llms.txt' || path === '/.well-known/llms.txt') {
    return { kind: 'text', contentType: 'text/plain; charset=utf-8', body: llmsTxt(site) };
  }

  if (STATIC_ASSET.test(path) && (method === 'GET' || method === 'HEAD')) return { kind: 'pass' };
  if (path.startsWith('/schemas/')) return { kind: 'pass' };

  if (site === 'trustjson') {
    if (path === '/' || path === '/index.html') return { kind: 'page', file: 'sites/trustjson/index.html' };
    return { kind: 'not_found' };
  }

  // brandjson
  if (path === '/' || path === '/index.html') return { kind: 'page', file: 'sites/brandjson/index.html' };
  if (path === '/builder' || path === '/builder/') {
    return { kind: 'rewrite', url: `/brand/builder${queryOf(url)}` };
  }
  if (path === '/spec') {
    return { kind: 'redirect', status: 302, location: 'https://docs.adcontextprotocol.org/docs/brand-protocol/brand-json' };
  }
  if (path.startsWith('/view/')) {
    return { kind: 'redirect', status: 302, location: `${AAO_ORIGIN}/brand${url}` };
  }
  // Public, unauthenticated reads the builder uses. Writes and anything
  // session-bound stay on agenticadvertising.org.
  if ((method === 'GET' || method === 'HEAD') && path.startsWith('/api/brands/')) return { kind: 'pass' };
  if ((method === 'GET' || method === 'HEAD') && path === '/api/config') return { kind: 'pass' };
  // Stateless brand-book import; bounded by its own rate and cost limits.
  if (method === 'POST' && path === '/api/brands/import') return { kind: 'pass' };
  if (path.startsWith('/api/')) return { kind: 'not_found' };

  return { kind: 'redirect', status: 301, location: `${AAO_ORIGIN}${url}` };
}
