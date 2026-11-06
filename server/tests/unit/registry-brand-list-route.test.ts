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

const PG_HOUSE = {
  domain: 'pg.com',
  record: { brand_name: 'Procter & Gamble', verified: true },
  declared_brand_domains: ['tide.com'],
};

function buildApp() {
  const brandDb = {
    getAllBrandsForRegistry: vi.fn().mockResolvedValue([]),
    getBrandRegistryStats: vi.fn().mockResolvedValue(EMPTY_STATS),
    getRegistryHouse: vi.fn().mockResolvedValue(PG_HOUSE),
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
  it('reads the normalised house once and scopes the list and the stats to it', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?house_domain=https://www.PG.com/');
    expect(res.status).toBe(200);
    expect(brandDb.getRegistryHouse).toHaveBeenCalledTimes(1);
    expect(brandDb.getRegistryHouse).toHaveBeenCalledWith('pg.com');
    expect(brandDb.getAllBrandsForRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ house: PG_HOUSE }),
    );
    expect(brandDb.getBrandRegistryStats).toHaveBeenCalledWith(undefined, PG_HOUSE);
    expect(res.body.house).toEqual({ domain: 'pg.com', brand_name: 'Procter & Gamble', verified: true });
  });

  it('returns house as null when the registry has no record for it', async () => {
    const { app, brandDb } = buildApp();
    brandDb.getRegistryHouse.mockResolvedValue({ domain: 'unknown.com', record: null, declared_brand_domains: [] });
    const res = await request(app).get('/api/brands/registry?house_domain=unknown.com');
    expect(res.status).toBe(200);
    expect(res.body.house).toBeNull();
  });

  it('leaves the filter off when the parameter is absent', async () => {
    const { app, brandDb } = buildApp();
    const res = await request(app).get('/api/brands/registry?search=tide');
    expect(res.status).toBe(200);
    expect(brandDb.getRegistryHouse).not.toHaveBeenCalled();
    expect(brandDb.getAllBrandsForRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'tide', house: undefined }),
    );
    expect(brandDb.getBrandRegistryStats).toHaveBeenCalledWith('tide', undefined);
    expect(res.body).not.toHaveProperty('house');
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

  it.each(['house_domain=pg.com&house_domain=unilever.com', 'search=a&search=b', 'source=hosted&source=community'])(
    'refuses a parameter given twice (%s)',
    async (queryString) => {
      const { app, brandDb } = buildApp();
      const res = await request(app).get(`/api/brands/registry?${queryString}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be provided only once/);
      expect(brandDb.getAllBrandsForRegistry).not.toHaveBeenCalled();
    },
  );
});
