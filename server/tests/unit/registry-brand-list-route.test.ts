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

const EMPTY_STATS = {
  total: 0,
  hosted: 0,
  brand_json: 0,
  community: 0,
  enriched: 0,
  stub: 0,
  houses: 0,
  sub_brands: 0,
  with_manifest: 0,
};

function buildApp() {
  const brandDb = {
    getAllBrandsForRegistry: vi.fn().mockResolvedValue([]),
    getBrandRegistryStats: vi.fn().mockResolvedValue(EMPTY_STATS),
  };
  const app = express();
  const passAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: brandDb as unknown as RegistryApiConfig['brandDb'],
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
  return { app, brandDb };
}

describe('GET /api/brands/registry house_domain filter', () => {
  it('passes the normalised house domain to the list and the stats', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?house_domain=https://PG.com/');
    expect(res.status).toBe(200);
    expect(brandDb.getAllBrandsForRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ house_domain: 'pg.com' }),
    );
    expect(brandDb.getBrandRegistryStats).toHaveBeenCalledWith(undefined, 'pg.com');
  });

  it('leaves the filter off when the parameter is absent', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?search=tide');
    expect(res.status).toBe(200);
    expect(brandDb.getAllBrandsForRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'tide', house_domain: undefined }),
    );
    expect(brandDb.getBrandRegistryStats).toHaveBeenCalledWith('tide', undefined);
  });

  it('refuses a value that is not a domain', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?house_domain=not%20a%20domain');
    expect(res.status).toBe(400);
    expect(brandDb.getAllBrandsForRegistry).not.toHaveBeenCalled();
  });

  it('refuses an empty value', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?house_domain=');
    expect(res.status).toBe(400);
    expect(brandDb.getAllBrandsForRegistry).not.toHaveBeenCalled();
  });
});
