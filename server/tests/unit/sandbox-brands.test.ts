import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', process.env.WORKOS_API_KEY ?? 'sk_test');
  vi.stubEnv('WORKOS_CLIENT_ID', process.env.WORKOS_CLIENT_ID ?? 'client_test');
});

vi.mock('../../src/utils/url-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/url-security.js')>();
  return { ...actual, safeFetchAxiosLike: vi.fn() };
});

vi.mock('../../src/utils/posthog.js', () => ({ captureEvent: vi.fn() }));

vi.mock('../../src/middleware/rate-limit.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  return Object.fromEntries(Object.entries(original).map(([name, value]) => [name, name.endsWith('RateLimiter') ? pass : value]));
});

import { BrandManager } from '../../src/brand-manager.js';
import { safeFetchAxiosLike } from '../../src/utils/url-security.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';
import { getSandboxBrand, listSandboxBrandDomains } from '../../src/services/sandbox-brands.js';

const mockedSafeFetch = vi.mocked(safeFetchAxiosLike);

const TEST_KIT_BRAND_DOMAINS = [
  'acmeoutdoor.example',
  'bistro-oranje.example',
  'novamotors.example',
  'oseinatural.example',
  'summitfoods.example',
];

function buildApp(brandDb: Partial<RegistryApiConfig['brandDb']>): express.Express {
  const app = express();
  app.use(express.json());
  const passAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createRegistryApiRouter({
    brandManager: new BrandManager({ observeRelationshipDeclaration: async () => Date.now() }),
    brandDb: {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
      ...brandDb,
    } as unknown as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: { trackRequest: async () => {}, markResolved: async () => true },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  }));
  return app;
}

describe('sandbox test brands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every fictional .example brand in the sandbox test kits', () => {
    expect(listSandboxBrandDomains().sort()).toEqual(TEST_KIT_BRAND_DOMAINS);
  });

  it('leaves the hosted-grader brand to its own origin brand.json', () => {
    expect(getSandboxBrand('hosted-grader.adcontextprotocol.org')).toBeUndefined();
  });

  it.each(TEST_KIT_BRAND_DOMAINS)('resolves %s through /api/brands/resolve without fetching', async (domain) => {
    const res = await request(buildApp({})).get('/api/brands/resolve').query({ domain });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body.canonical_domain).toBe(domain);
    expect(body.source).toBe('hosted');
    expect(typeof body.brand_name).toBe('string');
    expect(mockedSafeFetch).not.toHaveBeenCalled();
  });

  it('returns the Acme Outdoor kit identity and brand assets', async () => {
    const res = await request(buildApp({})).get('/api/brands/resolve').query({ domain: 'acmeoutdoor.example' });

    const body = JSON.parse(res.text) as {
      canonical_id: string;
      brand_name: string;
      keller_type: string;
      brand_manifest: { logos: unknown[]; colors: { primary: string } };
    };
    expect(body.canonical_id).toBe('acme_outdoor');
    expect(body.brand_name).toBe('Acme Outdoor');
    expect(body.keller_type).toBe('master');
    expect(body.brand_manifest.logos.length).toBeGreaterThan(0);
    expect(body.brand_manifest.colors.primary).toBe('#1B5E20');
  });

  it('wins over a stored community row for the same domain', async () => {
    const app = buildApp({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        domain: 'acmeoutdoor.example',
        canonical_domain: 'acmeoutdoor.example',
        brand_name: 'Impostor Outdoor',
        source_type: 'community',
        is_public: true,
        manifest_orphaned: false,
        brand_manifest: {},
      }),
    });

    const res = await request(app).get('/api/brands/resolve').query({ domain: 'acmeoutdoor.example' });

    expect(JSON.parse(res.text).brand_name).toBe('Acme Outdoor');
  });

  it('rejects saving a community copy of a sandbox brand', async () => {
    const upsertDiscoveredBrand = vi.fn();
    const res = await request(buildApp({ upsertDiscoveredBrand }))
      .post('/api/brands/save')
      .send({ domain: 'acmeoutdoor.example', brand_name: 'Acme Outdoor' });

    expect(res.status).toBe(409);
    expect(upsertDiscoveredBrand).not.toHaveBeenCalled();
  });
});
