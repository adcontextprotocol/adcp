import { describe, it, expect } from 'vitest';
import { getStandaloneSite, resolveStandaloneRequest } from '../../src/standalone-sites.js';

const brand = (method: string, url: string, host = 'brandjson.org') =>
  resolveStandaloneRequest('brandjson', host, method, url.split('?')[0], url);
const trust = (method: string, url: string, host = 'trustjson.org') =>
  resolveStandaloneRequest('trustjson', host, method, url.split('?')[0], url);

describe('getStandaloneSite', () => {
  it('recognizes apex and www hosts only', () => {
    expect(getStandaloneSite('brandjson.org')).toBe('brandjson');
    expect(getStandaloneSite('WWW.BRANDJSON.ORG')).toBe('brandjson');
    expect(getStandaloneSite('trustjson.org')).toBe('trustjson');
    expect(getStandaloneSite('agenticadvertising.org')).toBeNull();
    expect(getStandaloneSite('evil-brandjson.org')).toBeNull();
    expect(getStandaloneSite(undefined)).toBeNull();
  });
});

describe('resolveStandaloneRequest: brandjson.org', () => {
  it('redirects www to the apex, keeping the path and query', () => {
    expect(brand('GET', '/builder?domain=acme.example', 'www.brandjson.org')).toEqual({
      kind: 'redirect', status: 301, location: 'https://brandjson.org/builder?domain=acme.example',
    });
  });

  it('serves the landing page and maps /builder onto the existing builder route', () => {
    expect(brand('GET', '/')).toEqual({ kind: 'page', file: 'sites/brandjson/index.html' });
    expect(brand('GET', '/builder?domain=acme.example')).toEqual({ kind: 'rewrite', url: '/brand/builder?domain=acme.example' });
  });

  it('passes schemas, static assets, and public brand reads', () => {
    expect(brand('GET', '/schemas/v3/brand.json').kind).toBe('pass');
    expect(brand('GET', '/design-system.css').kind).toBe('pass');
    expect(brand('GET', '/sites/standard-site.css').kind).toBe('pass');
    expect(brand('GET', '/api/brands/resolve?domain=acme.example').kind).toBe('pass');
  });

  it('passes the stateless brand-book import endpoint', () => {
    expect(brand('POST', '/api/brands/import').kind).toBe('pass');
    expect(brand('POST', '/api/brands/save').kind).toBe('not_found');
  });

  it('keeps writes and other APIs off the site', () => {
    expect(brand('POST', '/api/brands/setup-my-brand').kind).toBe('not_found');
    expect(brand('GET', '/api/me/portrait').kind).toBe('not_found');
    expect(brand('POST', '/design-system.css').kind).not.toBe('pass');
  });

  it('sends the viewer and everything else to agenticadvertising.org', () => {
    expect(brand('GET', '/view/acme.example')).toEqual({
      kind: 'redirect', status: 302, location: 'https://agenticadvertising.org/brand/view/acme.example',
    });
    expect(brand('GET', '/registry?tab=brands')).toEqual({
      kind: 'redirect', status: 301, location: 'https://agenticadvertising.org/registry?tab=brands',
    });
  });

  it('answers robots.txt, sitemap.xml, and llms.txt for its own host', () => {
    const robots = brand('GET', '/robots.txt');
    expect(robots.kind).toBe('text');
    expect(robots.kind === 'text' && robots.body).toContain('https://brandjson.org/sitemap.xml');
    const llms = brand('GET', '/llms.txt');
    expect(llms.kind === 'text' && llms.body).toContain('# brand.json');
  });
});

describe('resolveStandaloneRequest: trustjson.org', () => {
  it('serves the authority guide at each AI discovery path', () => {
    const guide = trust('GET', '/llms.txt');
    expect(guide.kind).toBe('text');
    if (guide.kind !== 'text') throw new Error('Expected plain-text authority guide');
    expect(guide.contentType).toBe('text/plain; charset=utf-8');
    expect(guide.body).toContain('https://trustjson.org/#publish');
    expect(guide.body).toContain('trust.json carries no signing keys');
    expect(guide.body).toContain('A child with a verified parent does not need its own trust.json');
    expect(guide.body).toContain('Never downgrade a previously published authority');
    expect(trust('GET', '/.well-known/llms.txt')).toEqual(guide);
    expect(trust('GET', '/llms-full.txt')).toEqual(guide);
  });

  it('exposes the public lookup only at its exact read path', () => {
    expect(trust('GET', '/api/trust/lookup?domain=nova-motors.com').kind).toBe('pass');
    expect(trust('HEAD', '/api/trust/lookup').kind).toBe('pass');
    expect(trust('POST', '/api/trust/lookup').kind).toBe('not_found');
    expect(trust('GET', '/api/trust/lookup/other').kind).toBe('not_found');
  });

  it('keeps unrelated app paths off the site', () => {
    expect(trust('GET', '/')).toEqual({ kind: 'page', file: 'sites/trustjson/index.html' });
    expect(trust('GET', '/schemas/v3/brand.json').kind).toBe('pass');
    expect(trust('GET', '/builder').kind).toBe('not_found');
    expect(trust('GET', '/api/brands/resolve').kind).toBe('not_found');
    expect(trust('GET', '/registry').kind).toBe('not_found');
  });
});
