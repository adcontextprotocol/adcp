import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const resolvePrimaryOrganizationMock = vi.fn();
const ORIGINAL_DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const ORIGINAL_DEV_USER_ID = process.env.DEV_USER_ID;

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_registry_brand_setup';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_registry_brand_setup';
});

vi.mock('../../src/db/users-db.js', () => ({
  resolvePrimaryOrganization: (userId: string) => resolvePrimaryOrganizationMock(userId),
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildApp(brandDb: Partial<RegistryApiConfig['brandDb']>, brandManager: Partial<RegistryApiConfig['brandManager']> = {}) {
  const app = express();
  app.use(express.json());

  const requireAuth: import('express').RequestHandler = (req, _res, next) => {
    req.user = { id: 'user_test', email: 'user@test.example' } as typeof req.user;
    next();
  };

  app.use('/api', createRegistryApiRouter({
    brandManager: {
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
    requireAuth,
    optionalAuth: requireAuth,
  }));

  return app;
}

describe('POST /api/brands/setup-my-brand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEV_USER_EMAIL = 'dev@test.example';
    process.env.DEV_USER_ID = 'user_test';
    resolvePrimaryOrganizationMock.mockResolvedValue('org_test');
  });

  afterEach(() => {
    if (ORIGINAL_DEV_USER_EMAIL === undefined) {
      delete process.env.DEV_USER_EMAIL;
    } else {
      process.env.DEV_USER_EMAIL = ORIGINAL_DEV_USER_EMAIL;
    }
    if (ORIGINAL_DEV_USER_ID === undefined) {
      delete process.env.DEV_USER_ID;
    } else {
      process.env.DEV_USER_ID = ORIGINAL_DEV_USER_ID;
    }
  });

  it('hosts the full builder draft and returns the pointer snippet', async () => {
    const brandJson = {
      house: { domain: 'example.com', name: 'Example' },
      brands: [{ id: 'example', names: [{ en: 'Example' }], keller_type: 'master' }],
    };
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
      createHostedBrand: vi.fn().mockResolvedValue({ id: 'brand_1' }),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'example.com',
        brand_name: 'Example',
        brand_json: brandJson,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: 'example.com',
      has_brand_json: false,
      hosted_brand_json_url: 'https://agenticadvertising.org/brands/example.com/brand.json',
      pointer_snippet: '{\n  "authoritative_location": "https://agenticadvertising.org/brands/example.com/brand.json"\n}',
    });
    expect(brandDb.createHostedBrand).toHaveBeenCalledWith(expect.objectContaining({
      workos_organization_id: 'org_test',
      created_by_user_id: 'user_test',
      created_by_email: 'user@test.example',
      brand_domain: 'example.com',
      brand_json: brandJson,
      is_public: true,
    }));
  });

  it('rejects non-object brand_json drafts', async () => {
    const res = await request(buildApp({}))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'example.com',
        brand_name: 'Example',
        brand_json: 'not-json',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_json must be a JSON object');
  });
});
