import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const mocks = vi.hoisted(() => ({
  fetchBrandData: vi.fn(),
  fetchBrandContext: vi.fn(),
  isBrandfetchConfigured: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/services/brandfetch.js', () => ({
  fetchBrandData: mocks.fetchBrandData,
  fetchBrandContext: mocks.fetchBrandContext,
  isBrandfetchConfigured: mocks.isBrandfetchConfigured,
  ENRICHMENT_CACHE_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildApp(
  brandDb: Pick<RegistryApiConfig['brandDb'], 'getDiscoveredBrandByDomain' | 'upsertDiscoveredBrand'>,
  authenticated = false,
  brandManager: Partial<RegistryApiConfig['brandManager']> = {},
): express.Express {
  const app = express();
  app.use(express.json());
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const optionalAuth: import('express').RequestHandler = (req, _res, next) => {
    if (authenticated) {
      req.user = { id: 'user_test', email: 'user@test.example' } as typeof req.user;
    }
    next();
  };
  app.use('/api', createRegistryApiRouter({
    brandManager: {
      resolveBrand: vi.fn().mockResolvedValue(null),
      validateDomain: vi.fn().mockResolvedValue({ valid: false, errors: [] }),
      ...brandManager,
    } as RegistryApiConfig['brandManager'],
    brandDb: brandDb as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: passAuth,
    optionalAuth,
  }));
  return app;
}

function discoveredBrandWithContext() {
  return {
    id: 'brand-1',
    domain: 'acme.com',
    canonical_domain: 'acme.com',
    brand_name: 'Acme',
    source_type: 'enriched',
    is_public: true,
    manifest_orphaned: false,
    brand_manifest: {
      name: 'Acme',
      url: 'https://acme.com',
      brand_context: { brand: { voice: { summary: 'legacy stored context' } } },
    },
  };
}

describe('GET /api/brands/enrich', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBrandfetchConfigured.mockReturnValue(true);
  });

  it('strips persisted brand_context from cached manifests and returns live context top-level', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        id: 'brand-1',
        domain: 'acme.com',
        has_brand_manifest: true,
        brand_manifest: {
          name: 'Acme',
          url: 'https://acme.com',
          description: 'Brand API description.',
          brand_context: { brand: { voice: { summary: 'legacy stored context' } } },
        },
        source_type: 'enriched',
        last_validated: new Date(),
      }),
      upsertDiscoveredBrand: vi.fn(),
    };
    mocks.fetchBrandContext.mockResolvedValue({
      success: true,
      domain: 'acme.com',
      context: { brand: { voice: { summary: 'live context' } } },
    });

    const res = await request(buildApp(brandDb, true)).get('/api/brands/enrich?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.manifest).toEqual({
      name: 'Acme',
      url: 'https://acme.com',
      description: 'Brand API description.',
    });
    expect(res.body.context.brand.voice.summary).toBe('live context');
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
    expect(brandDb.upsertDiscoveredBrand).not.toHaveBeenCalled();
  });

  it('persists only Brand API fields while returning Brand Context as ephemeral response context', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn().mockResolvedValue({}),
    };
    mocks.fetchBrandData.mockResolvedValue({
      success: true,
      domain: 'acme.com',
      raw: { id: 'bf_1', name: 'Acme', domain: 'acme.com', claimed: true, verified: true, description: 'Brand API description.' },
      manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        description: 'Brand API description.',
      },
      context: { identity: { description: 'Context description.' } },
      highQuality: true,
    });

    const res = await request(buildApp(brandDb, true)).get('/api/brands/enrich?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.manifest).toEqual({
      name: 'Acme',
      url: 'https://acme.com',
      description: 'Brand API description.',
    });
    expect(res.body.context.identity.description).toBe('Context description.');
    expect(brandDb.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'acme.com',
      brand_name: 'Acme',
      source_type: 'enriched',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        description: 'Brand API description.',
      },
    }));
  });

  it('does not persist context-only fallback results', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn().mockResolvedValue({}),
    };
    mocks.fetchBrandData.mockResolvedValue({
      success: true,
      domain: 'context-only.com',
      manifest: {
        name: 'Context Only',
        url: 'https://context-only.com',
      },
      context: { identity: { tagline: 'Only available from context.' } },
      highQuality: false,
    });

    const res = await request(buildApp(brandDb, true)).get('/api/brands/enrich?domain=context-only.com');

    expect(res.status).toBe(200);
    expect(res.body.manifest.name).toBe('Context Only');
    expect(res.body.context.identity.tagline).toBe('Only available from context.');
    expect(res.body).not.toHaveProperty('source_type');
    expect(brandDb.upsertDiscoveredBrand).not.toHaveBeenCalled();
  });

  it('does not fetch or return Brand Context for anonymous callers', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn().mockResolvedValue({}),
    };
    mocks.fetchBrandData.mockResolvedValue({
      success: true,
      domain: 'acme.com',
      raw: { id: 'bf_1', name: 'Acme', domain: 'acme.com', claimed: true, verified: true },
      manifest: {
        name: 'Acme',
        url: 'https://acme.com',
      },
      highQuality: true,
    });

    const res = await request(buildApp(brandDb)).get('/api/brands/enrich?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.context).toBeUndefined();
    expect(res.body.context_error).toBeUndefined();
    expect(mocks.fetchBrandData).toHaveBeenCalledWith('acme.com', { includeContext: false });
    expect(mocks.fetchBrandContext).not.toHaveBeenCalled();
  });
});

describe('public registry brand read paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBrandfetchConfigured.mockReturnValue(true);
  });

  it('strips legacy brand_context from /api/brands/resolve fallback manifests', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb)).get('/api/brands/resolve?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.brand_manifest).toEqual({ name: 'Acme', url: 'https://acme.com' });
  });

  it('strips legacy brand_context from /api/brands/resolve/bulk fallback manifests', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/resolve/bulk')
      .send({ domains: ['acme.com'] });

    expect(res.status).toBe(200);
    expect(res.body.results['acme.com'].brand_manifest).toEqual({ name: 'Acme', url: 'https://acme.com' });
  });

  it('strips legacy brand_context from /api/brands/brand-json cached data', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb)).get('/api/brands/brand-json?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'Acme', url: 'https://acme.com' });
  });
});
