import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', process.env.WORKOS_API_KEY ?? 'sk_test');
  vi.stubEnv('WORKOS_CLIENT_ID', process.env.WORKOS_CLIENT_ID ?? 'client_test');
});

vi.mock('../../src/utils/posthog.js', () => ({
  captureEvent: vi.fn(),
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildApp(storedRow: Record<string, unknown>) {
  const app = express();
  const passAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createRegistryApiRouter({
    brandManager: {
      resolveBrand: vi.fn().mockResolvedValue(null),
      resolveBrandWithDiagnostics: vi.fn().mockResolvedValue({ brand: null }),
      validateDomain: vi.fn().mockResolvedValue({ valid: false, errors: [] }),
    } as unknown as RegistryApiConfig['brandManager'],
    brandDb: {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(storedRow),
    } as unknown as RegistryApiConfig['brandDb'],
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
    optionalAuth: passAuth,
  }));
  return app;
}

function storedHostedRow(overrides: Record<string, unknown>) {
  return {
    id: 'brand-1',
    domain: 'owned.example',
    source_type: 'brand_json',
    workos_organization_id: 'org_owner',
    domain_verified: true,
    is_public: true,
    manifest_orphaned: false,
    has_brand_manifest: true,
    ...overrides,
  };
}

describe('GET /api/brands/resolve brand name for a stored row', () => {
  it('takes the manifest name when the row has no brand_name', async () => {
    const app = buildApp(storedHostedRow({
      brand_name: null,
      brand_manifest: { id: 'owned', name: 'Owned Brand', names: [{ en: 'Owned Brand' }] },
    }));
    const res = await request(app).get('/api/brands/resolve?domain=owned.example');
    expect(res.status).toBe(200);
    expect(res.body.brand_name).toBe('Owned Brand');
  });

  it('keeps an explicit brand_name over the manifest', async () => {
    const app = buildApp(storedHostedRow({
      brand_name: 'Curated Name',
      brand_manifest: { id: 'owned', name: 'Owned Brand' },
    }));
    const res = await request(app).get('/api/brands/resolve?domain=owned.example');
    expect(res.body.brand_name).toBe('Curated Name');
  });

  it('falls back to the domain when neither names the brand', async () => {
    const app = buildApp(storedHostedRow({ brand_name: null, brand_manifest: {} }));
    const res = await request(app).get('/api/brands/resolve?domain=owned.example');
    expect(res.body.brand_name).toBe('owned.example');
  });
});
