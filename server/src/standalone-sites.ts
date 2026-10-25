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
      '- [Publish authority and protect a brand portfolio](https://trustjson.org/#publish): experimental trust.json grants and seller enforcement',
      '',
    ].join('\n');
  }
  return [
    '# trust.json',
    '',
    '> Experimental, protocol-neutral standard for publishing which agents an organization runs and who may act on its behalf. Stewarded by AgenticAdvertising.org. AdCP 3.3 defines the advertising profile.',
    '',
    '## Claim and publish',
    '',
    'Self-publish brand.json and trust.json over HTTPS on domains you control; no registry signup is required. A DNS TXT claim in the AgenticAdvertising.org registry controls its hosted entry. Other parties discover authority through your own domain publication or authoritative_location pointer. Claiming a registry entry alone does not enable transaction protection.',
    'Publish trust.json at https://{registrable-domain}/.well-known/trust.json. A hosted trust record may use one authoritative_location document hop, with no HTTP redirects. The original organization remains the authority.',
    '',
    '## Authenticate, resolve, and authorize',
    '',
    'The seller authenticates the actual calling agent using a signature or established credential mapping. Agent and operator names asserted in a request are not proof of identity.',
    'Resolve the brand through domain-controlled brand.json. For a distributed brand, verify both the child house_domain and the parent brand_refs entry. A one-sided claim or inferred registry hierarchy does not establish parent authority.',
    'Evaluate grants from the verified parent trust record, or from the standalone brand record. A delegation chain of at most two grants must reach the authenticated agent operator. Each later grant comes from its grantor\'s own trust.json. The account operator must be the brand, the parent organization, or the grantee of the first grant. Every grant must cover the request.',
    'The protocol permits implicit authority when the signer operator and account operator both match the brand or its verified parent. No third-party grant is needed in that case; agent identity and operator listing checks still apply.',
    '',
    '## Agents and grants',
    '',
    'agents[] lists origins operated by the publishing organization and their roles, such as adcp:buying. One agent per origin; different paths are not separate identities. Under Web Bot Auth, signing keys live at the agent origin in /.well-known/http-message-signatures-directory. trust.json carries no signing keys or jwks_uri.',
    'grants[] names grantee registrable domains. Check scopes, profiles.adcp.brands, countries, valid_from, valid_until, and optional agents[] origin narrowing. Omitted agent narrowing permits the grantee agents broadly; omitted countries are global; omitted validity bounds leave that end of the window unbounded.',
    'exclusive_grants: true makes grants exhaustive for the scopes they name. Reject uncovered third-party claims that need a grant in those scopes. Other activities are not automatically exclusive, and implicit first-party authority still applies. Without exclusivity an uncovered claim may be authorized by verified seller onboarding records.',
    'acknowledgements[] references grants another organization published. Terms remain with the grantor; an acknowledgement alone does not establish permission.',
    '',
    '## Parent domains and missing records',
    '',
    'A child with a verified parent does not need its own trust.json for the parent grants to apply. The parent record is the sole source of grants; a child record cannot override it.',
    'For an authority that has never published trust.json, a first 404 permits legacy brand.json authorization in AdCP 3.x. Missing publication does not independently authorize a caller.',
    'Once the authority trust record is read, legacy brand.json grants are no longer a fallback. Nonexclusive uncovered claims use seller policy instead. Migrate the complete grant list before publishing.',
    'Timeouts, server errors, malformed records, and deletion after publication are not an unprotected state. Spend fails closed with a retryable availability outcome. Never downgrade a previously published authority to legacy authorization; seller authority history must survive restarts.',
    '',
    '## Inspect and revoke',
    '',
    'Review the verified authority, operator agent listings, grant recipients, brand/country/activity/time limits, exclusive scopes, and freshness. Public files cannot reveal private seller onboarding approvals.',
    'Use the homepage domain lookup to inspect current public trust records, including a verified parent record, published agent origins, grants, scope limits, and validity windows. A missing child record does not bypass its parent. Missing files, unavailable/invalid records, and unverified parent claims are separate outcomes. The lookup does not authenticate requests or check seller enforcement, private onboarding approvals, or a seller adoption history. Publisher adagents.json sales permissions are a separate relationship.',
    'Revoke by removing or narrowing grants, or removing an agent origin from its operator listing. Keep the record published. Changes take effect on the seller freshness schedule, within the applicable cache lifetime. Revoking agent access does not itself cancel live buys or suspend the account.',
    '',
    '## Adoption and references',
    '',
    'Publishing alone does not enable enforcement at every seller. trust.json is experimental; its document name, path, and schema may change. SDK and seller support vary. Confirm support and test both allowed and denied requests with each seller before relying on protection. Seller billing, credit, and account approval still apply.',
    '',
    '- [Brand protection guide](https://trustjson.org/#publish)',
    '- [Parent and child brands](https://trustjson.org/#portfolio)',
    '- [Missing records](https://trustjson.org/#missing-records)',
    '- [Check your setup](https://trustjson.org/#check)',
    '- [Public domain lookup](https://trustjson.org/#lookup): enter a domain; results include a link to claim the brand',
    '- Public read API: GET https://trustjson.org/api/trust/lookup?domain=yourbrand.com. Only confirmed missing files report not_found; unavailable/invalid records and unverified parent relationships are separate states. This API reports public declarations, not a transaction authorization decision.',
    '- [Reference](https://docs.adcontextprotocol.org/docs/reference/trust-json)',
    '- [Grant evaluation](https://docs.adcontextprotocol.org/docs/building/by-layer/L2/accounts-and-agents#grants-in-trust-records-experimental)',
    '- [Identity and migration](https://docs.adcontextprotocol.org/docs/reference/migration/agent-identity-3-3)',
    '- [Experimental development schema](https://adcontextprotocol.org/schemas/latest/trust/v1/trust.json)',
    '- [Build or validate brand.json](https://brandjson.org/builder)',
    '- [Experimental status](https://docs.adcontextprotocol.org/docs/reference/experimental-status)',
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
  if (path === '/llms.txt' || path === '/.well-known/llms.txt' || (site === 'trustjson' && path === '/llms-full.txt')) {
    return { kind: 'text', contentType: 'text/plain; charset=utf-8', body: llmsTxt(site) };
  }

  if (STATIC_ASSET.test(path) && (method === 'GET' || method === 'HEAD')) return { kind: 'pass' };
  if (path.startsWith('/schemas/')) return { kind: 'pass' };

  if (site === 'trustjson') {
    if (path === '/' || path === '/index.html') return { kind: 'page', file: 'sites/trustjson/index.html' };
    if ((method === 'GET' || method === 'HEAD') && path === '/api/trust/lookup') return { kind: 'pass' };
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
