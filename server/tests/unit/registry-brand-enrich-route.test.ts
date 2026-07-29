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
  staticAdminApiKey = false,
): express.Express {
  const app = express();
  app.use(express.json());
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const optionalAuth: import('express').RequestHandler = (req, _res, next) => {
    if (authenticated) {
      req.user = { id: 'user_test', email: 'user@test.example' } as typeof req.user;
    }
    if (staticAdminApiKey) {
      (req as typeof req & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey = true;
    }
    next();
  };
  app.use('/api', createRegistryApiRouter({
    brandManager: {
      resolveBrand: vi.fn().mockResolvedValue(null),
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand: null }),
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
          company: { industry: 'Software' },
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
      company: { industry: 'Software' },
    });
    expect(res.body.company).toEqual({ industry: 'Software' });
    expect(res.body.context.brand.voice.summary).toBe('live context');
    expect(res.body.context_source).toBe('brandfetch');
    expect(res.body.context_scope).toBe('ephemeral');
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
    expect(brandDb.upsertDiscoveredBrand).not.toHaveBeenCalled();
  });

  it('returns live context for static admin API key callers', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        id: 'brand-1',
        domain: 'acme.com',
        has_brand_manifest: true,
        brand_manifest: {
          name: 'Acme',
          url: 'https://acme.com',
          brand_context: { identity: { description: 'legacy stored context' } },
        },
        source_type: 'enriched',
        last_validated: new Date(),
      }),
      upsertDiscoveredBrand: vi.fn(),
    };
    mocks.fetchBrandContext.mockResolvedValue({
      success: true,
      domain: 'acme.com',
      context: { identity: { description: 'live admin context' } },
    });

    const res = await request(buildApp(brandDb, false, {}, true)).get('/api/brands/enrich?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.manifest).toEqual({
      name: 'Acme',
      url: 'https://acme.com',
    });
    expect(res.body.context.identity.description).toBe('live admin context');
    expect(res.body.context_source).toBe('brandfetch');
    expect(res.body.context_scope).toBe('ephemeral');
    expect(mocks.fetchBrandContext).toHaveBeenCalledWith('acme.com');
    expect(mocks.fetchBrandData).not.toHaveBeenCalled();
  });

  it('returns cached manifest with context_error when live cached Brand Context fetch fails', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        id: 'brand-1',
        domain: 'acme.com',
        has_brand_manifest: true,
        brand_manifest: {
          name: 'Acme',
          url: 'https://acme.com',
          brand_context: { identity: { description: 'legacy stored context' } },
        },
        source_type: 'enriched',
        last_validated: new Date(),
      }),
      upsertDiscoveredBrand: vi.fn(),
    };
    mocks.fetchBrandContext.mockResolvedValue({
      success: false,
      domain: 'acme.com',
      error: 'Brand Context unavailable',
    });

    const res = await request(buildApp(brandDb, true)).get('/api/brands/enrich?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      domain: 'acme.com',
      cached: true,
      manifest: {
        name: 'Acme',
        url: 'https://acme.com',
      },
      source_type: 'enriched',
      context_error: 'Brand Context unavailable',
    });
    expect(res.body.context).toBeUndefined();
    expect(res.body.context_source).toBeUndefined();
    expect(res.body.context_scope).toBeUndefined();
    expect(mocks.fetchBrandContext).toHaveBeenCalledWith('acme.com');
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
      company: { industry: 'Software' },
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
      company: { industry: 'Software' },
    });
    expect(res.body.company).toEqual({ industry: 'Software' });
    expect(res.body.context.identity.description).toBe('Context description.');
    expect(res.body.context_source).toBe('brandfetch');
    expect(res.body.context_scope).toBe('ephemeral');
    expect(brandDb.upsertDiscoveredBrand).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'acme.com',
      brand_name: 'Acme',
      source_type: 'enriched',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        description: 'Brand API description.',
        company: { industry: 'Software' },
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

  it('reports verified owner-registered fallback records as hosted', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        ...discoveredBrandWithContext(),
        source_type: 'community',
        workos_organization_id: 'org_owner',
        domain_verified: true,
      }),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb)).get('/api/brands/resolve?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('hosted');
  });

  it('does not report an unverified organization-attributed record as hosted', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        ...discoveredBrandWithContext(),
        source_type: 'community',
        workos_organization_id: 'org_unverified',
        domain_verified: false,
      }),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb)).get('/api/brands/resolve?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('community');
  });

  it('keeps identical live and stored records on the same provenance label', async () => {
    const stored = {
      ...discoveredBrandWithContext(),
      source_type: 'community' as const,
      workos_organization_id: 'org_owner',
      domain_verified: true,
    };
    const live = {
      canonical_id: 'acme.com',
      canonical_domain: 'acme.com',
      brand_name: 'Acme',
      source: 'brand_json' as const,
      brand_manifest: { name: 'Acme', url: 'https://acme.com' },
    };
    const resolveBrandWithDiagnostics = vi.fn()
      .mockResolvedValueOnce({ brand: live })
      .mockResolvedValueOnce({ brand: null });
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(stored),
      upsertDiscoveredBrand: vi.fn(),
    };
    const app = buildApp(brandDb, false, { resolveBrandWithDiagnostics });

    const liveResponse = await request(app).get('/api/brands/resolve?domain=acme.com');
    const storedResponse = await request(app).get('/api/brands/resolve?domain=acme.com');

    expect(liveResponse.status).toBe(200);
    expect(storedResponse.status).toBe(200);
    expect(liveResponse.body).toEqual(storedResponse.body);
    expect(liveResponse.body.source).toBe('hosted');
  });

  it('lets a live brand_json record outrank stored enrichment', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };
    const live = {
      canonical_id: 'acme-live',
      canonical_domain: 'acme.com',
      brand_name: 'Acme Live',
      source: 'brand_json' as const,
      promoted_from_schema: 'https://schemas.adcontextprotocol.org/brand/v1/brand.json',
      migration_warnings: [{ field: 'house', message: 'Not promoted' }],
    };

    const res = await request(buildApp(brandDb, false, {
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand: live }),
    })).get('/api/brands/resolve?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      canonical_id: 'acme-live',
      source: 'brand_json',
      promoted_from_schema: live.promoted_from_schema,
      migration_warnings: live.migration_warnings,
    });
  });

  it.each([
    { is_public: false, manifest_orphaned: false },
    { is_public: true, manifest_orphaned: true },
  ])('never lets a non-public stored record override a live record (%o)', async (visibility) => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        ...discoveredBrandWithContext(),
        ...visibility,
        source_type: 'community',
        workos_organization_id: 'org_owner',
        domain_verified: true,
      }),
      upsertDiscoveredBrand: vi.fn(),
    };
    const live = {
      canonical_id: 'acme-live',
      canonical_domain: 'acme.com',
      brand_name: 'Acme Live',
      source: 'brand_json' as const,
    };

    const res = await request(buildApp(brandDb, false, {
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand: live }),
    })).get('/api/brands/resolve?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(live);
  });

  it('rejects path and port lookup inputs before brand resolution', async () => {
    const resolveBrand = vi.fn().mockResolvedValue(null);
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb, false, { resolveBrand }))
      .get('/api/brands/resolve?domain=public.example%3A8443%2Fadmin');

    expect(res.status).toBe(400);
    expect(resolveBrand).not.toHaveBeenCalled();
    expect(brandDb.getDiscoveredBrandByDomain).not.toHaveBeenCalled();
  });

  it('surfaces live brand.json diagnostics when fresh resolution falls back', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };
    const validation = {
      valid: false,
      domain: 'acme.com',
      url: 'https://acme.com/.well-known/brand.json',
      status_code: 200,
      errors: [{ field: 'brands[0].names', message: 'Required', severity: 'error' }],
      warnings: [{ field: '$schema', message: 'Legacy schema detected' }],
    };

    const res = await request(buildApp(brandDb, false, {
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({
        brand: null,
        last_attempt: validation,
      }),
    })).get('/api/brands/resolve?domain=acme.com&fresh=true');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('enriched');
    expect(res.body.live_brand_json).toEqual({
      valid: false,
      url: validation.url,
      status_code: 200,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  });

  it("uses this request's own fresh failure status in a not-found response", async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
    };
    const freshFailure = {
      valid: false,
      domain: 'acme.com',
      url: 'https://acme.com/.well-known/brand.json',
      status_code: 503,
      errors: [{ field: 'http_status', message: 'HTTP 503', severity: 'error' }],
      warnings: [],
    };
    const validateDomain = vi.fn().mockResolvedValue({
      valid: true,
      status_code: 200,
      errors: [],
      warnings: [],
    });

    const res = await request(buildApp(brandDb, false, {
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({
        brand: null,
        last_attempt: freshFailure,
      }),
      validateDomain,
    })).get('/api/brands/resolve?domain=acme.com&fresh=true');

    expect(res.status).toBe(404);
    expect(res.body.file_status).toBe(503);
    expect(validateDomain).not.toHaveBeenCalled();
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

  it('rejects non-hostname inputs from bulk resolution', async () => {
    const resolveBrand = vi.fn().mockResolvedValue(null);
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb, false, { resolveBrand }))
      .post('/api/brands/resolve/bulk')
      .send({ domains: ['acme.com', 'public.example:8443/admin'] });

    expect(res.status).toBe(400);
    expect(resolveBrand).not.toHaveBeenCalled();
  });

  it('caps anonymous bulk resolution at 25 domains', async () => {
    const resolveBrand = vi.fn().mockResolvedValue(null);
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb, false, { resolveBrand }))
      .post('/api/brands/resolve/bulk')
      .send({ domains: Array.from({ length: 26 }, (_, i) => `brand-${i}.example`) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Maximum 25 domains per request');
    expect(resolveBrand).not.toHaveBeenCalled();
  });

  it('shares one concurrency ceiling across simultaneous bulk requests', async () => {
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resolveBrand = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return null;
    });
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      upsertDiscoveredBrand: vi.fn(),
    };
    const app = buildApp(brandDb, false, { resolveBrand });
    const firstDomains = Array.from({ length: 10 }, (_, i) => `first-${i}.example`);
    const secondDomains = Array.from({ length: 10 }, (_, i) => `second-${i}.example`);

    const pending = Promise.all([
      request(app).post('/api/brands/resolve/bulk').send({ domains: firstDomains }),
      request(app).post('/api/brands/resolve/bulk').send({ domains: secondDomains }),
    ]);

    await vi.waitFor(() => expect(resolveBrand).toHaveBeenCalledTimes(10));
    expect(maxActive).toBe(10);
    release?.();

    const responses = await pending;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(maxActive).toBe(10);
    expect(resolveBrand).toHaveBeenCalledTimes(20);
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

  it('reports a cached canonical document with the canonical variant', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        ...discoveredBrandWithContext(),
        source_type: 'brand_json',
        brand_manifest: {
          $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
          id: 'acme',
          names: [{ en: 'Acme' }],
          properties: [{ type: 'website', identifier: 'acme.com', relationship: 'owned' }],
        },
      }),
      upsertDiscoveredBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb)).get('/api/brands/brand-json?domain=acme.com');

    expect(res.status).toBe(200);
    expect(res.body.variant).toBe('brand_canonical');
  });

  it('surfaces live validation diagnostics when fresh brand-json falls back to cached data', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(discoveredBrandWithContext()),
      upsertDiscoveredBrand: vi.fn(),
    };
    const validation = {
      valid: false,
      domain: 'acme.com',
      url: 'https://acme.com/.well-known/brand.json',
      status_code: 200,
      errors: [{ field: 'root', message: 'Invalid brand.json', severity: 'error' }],
      warnings: [{ field: '$schema', message: 'Legacy schema detected' }],
    };

    const res = await request(buildApp(brandDb, false, {
      validateDomain: vi.fn().mockResolvedValue(validation),
    })).get('/api/brands/brand-json?domain=acme.com&fresh=true');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'Acme', url: 'https://acme.com' });
    expect(res.body.live_brand_json).toEqual({
      valid: false,
      url: validation.url,
      status_code: 200,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  });
});
