import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { BrandManager, BrandResolution } from '../../src/brand-manager.js';
import { TrustEvaluator, type TrustFetchResult } from '@adcp/sdk/identity-3.3';
import { InvalidTrustLookupDomain, TrustLookupBusy, TrustLookupService, normalizeTrustLookupDomain } from '../../src/services/trust-lookup.js';
import { createTrustLookupRouter } from '../../src/routes/trust-lookup.js';

const domain = 'nova-motors.com';
const now = Date.parse('2026-10-24T12:00:00Z');
const missingIdentity: BrandResolution = {
  brand: null,
  last_attempt: { valid: false, domain, url: `https://${domain}/.well-known/brand.json`, status_code: 404, errors: [], warnings: [] },
};
const brand = {
  canonical_id: 'nova_motors', canonical_domain: domain, brand_name: 'Nova Motors',
  relationship_trust: 'standalone' as const, source: 'brand_json' as const,
};
const grant = { grantee: 'pinnacle-agency.com', scopes: ['adcp:media_buying'] };
function absent(operator = domain): TrustFetchResult {
  return { status: 'absent', operator, checkedAt: now / 1000, freshUntil: now / 1000 + 60 };
}
function present(record: object, operator = domain): TrustFetchResult {
  return { status: 'present', operator, record, checkedAt: now / 1000, freshUntil: now / 1000 + 60 };
}
function setup(identity: BrandResolution = missingIdentity, record = absent()) {
  const resolver = { resolveBrandWithDiagnostics: vi.fn().mockResolvedValue(identity) };
  const reader = { get: vi.fn().mockResolvedValue(record) };
  const service = new TrustLookupService(resolver, () => reader, () => now);
  return { resolver, reader, service };
}

describe('public trust lookup', () => {
  it('normalizes HTTPS origins and IDN while preserving a requested subdomain', () => {
    expect(normalizeTrustLookupDomain(' HTTPS://WWW.NOVA-MOTORS.COM./ ')).toBe('www.nova-motors.com');
    expect(normalizeTrustLookupDomain('https://bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeTrustLookupDomain('tenant.github.io')).toBe('tenant.github.io');
  });

  it.each(['', 'localhost', '127.0.0.1', '[::1]', 'co.uk', 'github.io', 'http://nova-motors.com',
    'https://nova-motors.com/private', 'https://nova-motors.com:444', 'https://name@nova-motors.com',
    'nova-motors.com?other=example.com', 'nova..com'])('rejects unsafe or ambiguous input %s before networking', async input => {
    const { service, resolver, reader } = setup();
    await expect(service.lookup(input)).rejects.toBeInstanceOf(InvalidTrustLookupDomain);
    expect(resolver.resolveBrandWithDiagnostics).not.toHaveBeenCalled();
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('reports a confirmed absent record and links to the requested brand claim', async () => {
    const { service, reader } = setup();
    const result = await service.lookup(domain);
    expect(result.status).toBe('not_found');
    expect(result.claim_url).toBe('https://agenticadvertising.org/brand/builder?domain=nova-motors.com');
    expect(reader.get).toHaveBeenCalledWith(domain);
    expect(result.message).toContain('sellers may retain earlier records');
  });

  it('does not mistake an outage or invalid trust record for absence', async () => {
    const { service, reader } = setup();
    reader.get.mockRejectedValue(new Error('fixture transport or validation failure'));
    const result = await service.lookup(domain);
    expect(result.status).toBe('unavailable');
    expect(result.message).not.toContain('fixture');
    expect(result.grants).toEqual([]);
  });

  it('does not label a domain unimplemented when identity resolution fails', async () => {
    const { service, reader } = setup({ ...missingIdentity, last_attempt: { ...missingIdentity.last_attempt!, status_code: 503 } });
    expect((await service.lookup(domain)).status).toBe('unavailable');
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('does not treat a missing delegated identity file as a missing original brand file', async () => {
    const { service, reader } = setup({ ...missingIdentity, last_attempt: { ...missingIdentity.last_attempt!, url: 'https://hosting.nova-brands.com/brand.json' } });
    expect((await service.lookup(domain)).status).toBe('unavailable');
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('explains a cross-domain website redirect without treating it as parent authority or missing trust', async () => {
    const { service, reader } = setup({ ...missingIdentity, last_attempt: { ...missingIdentity.last_attempt!, status_code: undefined,
      errors: [{ field: 'network', message: 'Refused redirect outside original host/www pair: nova-motors.com -> nova-brands.com', severity: 'error' }],
    } });
    const result = await service.lookup(domain);
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('A website redirect does not verify parent authority');
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('uses only the verified parent record even when a child has no trust record', async () => {
    const { service, reader } = setup({ brand: {
      ...brand, house_domain: 'nova-brands.com', claimed_house_domain: 'nova-brands.com', relationship_trust: 'mutual',
      relationship_verified_at: '2026-10-24T11:00:00Z',
    } }, present({ grants: [grant], exclusive_grants: true }, 'nova-brands.com'));
    const result = await service.lookup(domain);
    expect(reader.get).toHaveBeenCalledExactlyOnceWith('nova-brands.com');
    expect(result.status).toBe('published');
    expect(result.record_url).toBe('https://nova-brands.com/.well-known/trust.json');
    expect(result.parent_domain).toBe('nova-brands.com');
    expect(result.grants[0].grantee).toBe('pinnacle-agency.com');
  });

  it('reports absence at the parent rather than probing a child fallback', async () => {
    const { service, reader } = setup({ brand: { ...brand, house_domain: 'nova-brands.com', relationship_trust: 'inline' } }, absent('nova-brands.com'));
    const result = await service.lookup(domain);
    expect(result.status).toBe('not_found');
    expect(result.authority_domain).toBe('nova-brands.com');
    expect(reader.get).toHaveBeenCalledExactlyOnceWith('nova-brands.com');
  });

  it('does not describe a house own master brand as a separate child', async () => {
    const { service } = setup({ brand: { ...brand, house_domain: domain, relationship_trust: 'inline' } }, present({ grants: [grant] }));
    const result = await service.lookup(domain);
    expect(result.status).toBe('published');
    expect(result.parent_domain).toBeNull();
    expect(result.message).not.toContain('child');
  });

  it.each(['leaf_only', 'house_only', 'unverifiable'] as const)('does not promote a %s parent claim', async relationship_trust => {
    const { service, reader } = setup({ brand: { ...brand, claimed_house_domain: 'nova-brands.com', relationship_trust } });
    const result = await service.lookup(domain);
    expect(result.status).toBe('unverified_parent');
    expect(result.authority_domain).toBeNull();
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('never uses community hierarchy as verified authority', async () => {
    const { service, reader } = setup({ brand: { ...brand, source: 'community', house_domain: 'nova-brands.com', relationship_trust: 'mutual' } });
    expect((await service.lookup(domain)).status).toBe('unavailable');
    expect(reader.get).not.toHaveBeenCalled();
  });

  it('keeps private-suffix tenant authority at the tenant domain', async () => {
    const tenant = 'pinnacle-agency.github.io';
    const { service, reader, resolver } = setup();
    resolver.resolveBrandWithDiagnostics.mockResolvedValue({ brand: { ...brand, canonical_domain: tenant } });
    await service.lookup(tenant);
    expect(reader.get).toHaveBeenCalledWith(tenant);
  });

  it('filters unrelated brands, preserves limits, and labels expired, scheduled and invalid grants', async () => {
    const { service } = setup({ brand }, present({ exclusive_grants: true, grants: [
      { ...grant, profiles: { adcp: { brands: ['nova_motors'] } }, countries: ['US'], agents: [{ url: 'https://buyer.pinnacle-agency.com/mcp' }], valid_until: '2027-01-01T00:00:00Z' },
      { ...grant, valid_until: '2026-01-01T00:00:00Z' },
      { ...grant, valid_from: '2027-01-01T00:00:00Z' },
      { ...grant, grantee: 'tenant.pinnacle-agency.com' },
      { ...grant, scopes: ['adcp:governance'], profiles: { adcp: { brands: ['other_brand'] } } },
    ] }));
    const result = await service.lookup(domain);
    expect(result.grants.map(item => item.status)).toEqual(['active', 'expired', 'scheduled', 'invalid']);
    expect(result.grants[0]).toMatchObject({ countries: ['US'], agents: ['https://buyer.pinnacle-agency.com'], brands: ['nova_motors'] });
    expect(result.total_grants).toBe(5);
    expect(result.matching_grants).toBe(4);
    expect(result.exclusive_grants).toBe(true);
    expect(result).not.toHaveProperty('exclusive_scopes');
  });

  it('shows an agent URL that cannot be canonicalized as published instead of failing the lookup', async () => {
    const { service } = setup({ brand }, present({ agents: [
      { url: 'https://buyer.nova-motors.com/mcp', roles: ['adcp:buying'] },
      { url: 'not a url', roles: ['adcp:buying'] },
    ], grants: [{ ...grant, agents: [{ url: 'not a url' }] }] }));
    const result = await service.lookup(domain);
    expect(result.status).toBe('published');
    expect(result.agents.map(agent => agent.origin)).toEqual(['https://buyer.nova-motors.com', 'not a url']);
    expect(result.grants[0].agents).toEqual(['not a url']);
  });

  it('bounds rendered records while retaining total counts', async () => {
    const { service } = setup({ brand }, present({ grants: Array.from({ length: 101 }, () => grant) }));
    const result = await service.lookup(domain);
    expect(result.grants).toHaveLength(100);
    expect(result.matching_grants).toBe(101);
  });

  it('bounds the response and cache even when individual declarations are enormous', async () => {
    const { service } = setup({ brand }, present({ exclusive_grants: true, grants: [{ ...grant, scopes: [`vendor:${'a'.repeat(140_000)}`] }] }));
    const result = await service.lookup(domain);
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('display limit');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
  });

  it('bounds identity metadata even on an early lookup outcome', async () => {
    const { service, reader } = setup({ brand: { ...brand, canonical_id: 'a'.repeat(140_000), brand_name: 'b'.repeat(140_000) } });
    const result = await service.lookup(domain);
    expect(result.status).toBe('unavailable');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024);
    expect(reader.get).not.toHaveBeenCalled();
  });

  it.each([
    ['server error', 503, '{}'],
    ['invalid JSON', 200, '{bad json'],
    ['duplicate keys', 200, '{"grants":[],"grants":[]}'],
    ['invalid schema', 200, '{"agents":[{"url":"https://buyer.pinnacle-agency.com","roles":["adcp:buying"],"jwks_uri":"https://buyer.pinnacle-agency.com/jwks"}]}'],
    ['HTTP redirect', 302, '{}'],
  ])('uses the real SDK reader to keep %s distinct from absence', async (_name, status, body) => {
    const resolver = { resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand }) };
    const fetch = vi.fn(async () => new Response(body, { status }));
    const service = new TrustLookupService(resolver, () => new TrustEvaluator({ fetchOptions: { trustedFetchFn: fetch } }));
    expect((await service.lookup(domain)).status).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the SDK SSRF guard for a public hostname that resolves privately', async () => {
    const resolver = { resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand }) };
    const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const service = new TrustLookupService(resolver, () => new TrustEvaluator({ fetchOptions: { lookup } }));
    expect((await service.lookup(domain)).status).toBe('unavailable');
    expect(lookup).toHaveBeenCalled();
  });

  it('reads one hosted record pointer and rejects a second pointer', async () => {
    const resolver = { resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand }) };
    const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('hosting')
      ? { grants: [grant] } : { authoritative_location: 'https://hosting.pinnacle-agency.com/nova-trust.json' })));
    const service = new TrustLookupService(resolver, () => new TrustEvaluator({ fetchOptions: { trustedFetchFn: fetch } }));
    expect((await service.lookup(domain)).status).toBe('published');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(async () => new Response('{"authoritative_location":"https://hosting.pinnacle-agency.com/another.json"}'));
    const chained = new TrustLookupService(resolver, () => new TrustEvaluator({ fetchOptions: { trustedFetchFn: fetch } }));
    expect((await chained.lookup(domain)).status).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('single-flights equivalent requests and briefly caches the result', async () => {
    const { service, reader, resolver } = setup();
    const results = await Promise.all([service.lookup(domain), service.lookup(domain.toUpperCase())]);
    expect(results[0]).toEqual(results[1]);
    await service.lookup(domain);
    expect(resolver.resolveBrandWithDiagnostics).toHaveBeenCalledTimes(1);
    expect(reader.get).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent lookups across distinct domains', async () => {
    let release!: (value: BrandResolution) => void;
    // One shared promise releases all workers without leaving background work.
    const identity = new Promise<BrandResolution>(resolve => { release = resolve; });
    const resolver = { resolveBrandWithDiagnostics: vi.fn(() => identity) };
    const service = new TrustLookupService(resolver);
    const requests = Array.from({ length: 8 }, (_, i) => service.lookup(`nova-brand-${i}.com`));
    await expect(service.lookup('nova-brand-overflow.com')).rejects.toBeInstanceOf(TrustLookupBusy);
    release({ brand: null });
    await Promise.all(requests);
  });
});

describe('trust lookup HTTP route', () => {
  function app(lookup = vi.fn().mockResolvedValue({ status: 'not_found', domain })) {
    const app = express();
    app.use('/api/trust', createTrustLookupRouter({ brandManager: {} as BrandManager, service: { lookup } }));
    return { app, lookup };
  }

  it('is public, read-only, and does not cache a lookup in intermediaries', async () => {
    const fixture = app();
    const response = await request(fixture.app).get('/api/trust/lookup').query({ domain });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fixture.lookup).toHaveBeenCalledWith(domain);
    expect((await request(fixture.app).post('/api/trust/lookup')).status).toBe(404);
  });

  it('rejects missing and repeated domain parameters without doing a lookup', async () => {
    const fixture = app();
    expect((await request(fixture.app).get('/api/trust/lookup')).status).toBe(400);
    expect((await request(fixture.app).get('/api/trust/lookup?domain=first.com&domain=second.com')).status).toBe(400);
    expect(fixture.lookup).not.toHaveBeenCalled();
  });

  it('returns input and capacity errors distinctly', async () => {
    const fixture = app(vi.fn().mockRejectedValue(new InvalidTrustLookupDomain('Invalid domain')));
    expect((await request(fixture.app).get('/api/trust/lookup').query({ domain })).status).toBe(400);
    fixture.lookup.mockRejectedValue(new TrustLookupBusy('Busy'));
    const response = await request(fixture.app).get('/api/trust/lookup').query({ domain });
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('10');
  });

  it('rate limits anonymous network probes', async () => {
    const fixture = app();
    for (let i = 0; i < 10; i++) expect((await request(fixture.app).get('/api/trust/lookup').query({ domain })).status).toBe(200);
    expect((await request(fixture.app).get('/api/trust/lookup').query({ domain })).status).toBe(429);
    expect(fixture.lookup).toHaveBeenCalledTimes(10);
  });
});
