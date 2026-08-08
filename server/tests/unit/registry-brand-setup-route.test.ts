import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const resolvePrimaryOrganizationMock = vi.fn();
const queryMock = vi.fn();
const ORIGINAL_DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const ORIGINAL_DEV_USER_ID = process.env.DEV_USER_ID;

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_registry_brand_setup';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_registry_brand_setup';
});

vi.mock('../../src/db/users-db.js', () => ({
  resolvePrimaryOrganization: (userId: string) => resolvePrimaryOrganizationMock(userId),
}));

vi.mock('../../src/db/client.js', () => ({
  isDatabaseInitialized: () => false,
  query: (...args: unknown[]) => queryMock(...args),
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
    queryMock.mockResolvedValue({ rows: [] });
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

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'http://cdn.example.test/logo.png',
    'https://cdn.example.test/logo.png\" onerror=\"alert(1)',
    'https://cdn.example.test/logo\\evil.png',
    'https://user:password@cdn.example.test/logo.png',
  ])('rejects unsafe logo URL %s', async (logoUrl) => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: 'Nova',
        logo_url: logoUrl,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('logo_url must be an absolute HTTPS URL without credentials');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('rejects logo URLs longer than 2048 characters', async () => {
    const brandDb = { createHostedBrand: vi.fn() };
    const logoUrl = `https://cdn.example.test/${'a'.repeat(2025)}`;
    expect(logoUrl.length).toBeGreaterThan(2048);

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({ domain: 'nova.example', brand_name: 'Nova', logo_url: logoUrl });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('logo_url must be an absolute HTTPS URL without credentials');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it.each([
    ['logo_url', 42, 'logo_url must be an absolute HTTPS URL without credentials'],
    ['brand_color', ['#123456'], 'brand_color must use #RRGGBB format'],
  ])('rejects non-string %s values', async (field, value, expectedError) => {
    const brandDb = { createHostedBrand: vi.fn() };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({ domain: 'nova.example', brand_name: 'Nova', [field]: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(expectedError);
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it.each(['red', '#123', '#12345g', '#123456; background: red'])('rejects unsafe brand color %s', async (brandColor) => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: 'Nova',
        brand_color: brandColor,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_color must use #RRGGBB format');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('rejects unsafe branding nested in a full brand.json draft', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: 'Nova',
        brand_json: {
          brands: [{
            names: [{ en: 'Nova' }],
            logos: [{ url: 'data:image/svg+xml,<svg onload=alert(1)>' }],
            colors: { primary: '#123456; color: red' },
          }],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_json logo URLs must be absolute HTTPS URLs without credentials');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('rejects an unsafe primary color nested in a full brand.json draft', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: 'Nova',
        brand_json: {
          brands: [{
            names: [{ en: 'Nova' }],
            colors: { primary: '#123456; color: red' },
          }],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_json primary brand color must use #RRGGBB format');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('rejects a full draft containing both valid and unsafe nested logos', async () => {
    const brandDb = { createHostedBrand: vi.fn() };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: 'Nova',
        brand_json: {
          house: { domain: 'nova.example', name: 'Nova' },
          brands: [{
            names: [{ en: 'Nova' }],
            logos: [
              { url: 'https://cdn.example.test/logo.png' },
              { url: 'javascript:alert(1)' },
            ],
          }],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_json logo URLs must be absolute HTTPS URLs without credentials');
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('does not adopt unsafe branding from an approved legacy manifest', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        review_status: 'approved',
        brand_manifest: {
          house: { domain: 'nova.example', name: 'Legacy Nova' },
          brands: [{
            names: [{ en: 'Legacy Nova' }],
            logos: [{ url: 'data:image/svg+xml,<svg onload=alert(1)>' }],
            colors: { primary: '#123456; background: red' },
          }],
        },
      }),
      getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
      createHostedBrand: vi.fn().mockResolvedValue({ id: 'brand_1' }),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({ domain: 'nova.example', brand_name: 'Nova' });

    expect(res.status).toBe(200);
    const savedBrandJson = brandDb.createHostedBrand.mock.calls[0][0].brand_json;
    expect(savedBrandJson.house).toEqual({ domain: 'nova.example', name: 'Nova' });
    expect(savedBrandJson.brands[0]).not.toHaveProperty('logos');
    expect(savedBrandJson.brands[0]).not.toHaveProperty('colors');
  });

  it('preserves valid HTTPS branding and treats hostile names as text data', async () => {
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
      getHostedBrandByDomain: vi.fn().mockResolvedValue(null),
      createHostedBrand: vi.fn().mockResolvedValue({ id: 'brand_1' }),
    };
    const hostileName = 'Nova\"><img src=x onerror="alert(1)">';

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'nova.example',
        brand_name: hostileName,
        logo_url: 'https://cdn.example.test/brand/logo.svg?theme=dark',
        brand_color: '#12Ab9F',
      });

    expect(res.status).toBe(200);
    expect(brandDb.createHostedBrand).toHaveBeenCalledWith(expect.objectContaining({
      brand_json: expect.objectContaining({
        house: { domain: 'nova.example', name: hostileName },
        brands: [expect.objectContaining({
          names: [{ en: hostileName }],
          logos: [{ url: 'https://cdn.example.test/brand/logo.svg?theme=dark' }],
          colors: { primary: '#12Ab9F' },
        })],
      }),
    }));
  });

  it('denies non-dev callers without a resolvable organization', async () => {
    delete process.env.DEV_USER_EMAIL;
    delete process.env.DEV_USER_ID;
    resolvePrimaryOrganizationMock.mockResolvedValue(null);
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'victim.example',
        brand_name: 'Victim',
        brand_json: {
          house: { domain: 'victim.example', name: 'Victim' },
          brands: [{ id: 'victim', names: [{ en: 'Victim' }], keller_type: 'master' }],
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('A verified organization is required to set up a brand');
    expect(queryMock).not.toHaveBeenCalled();
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });

  it('denies non-dev callers whose organization does not own the requested domain', async () => {
    delete process.env.DEV_USER_EMAIL;
    delete process.env.DEV_USER_ID;
    resolvePrimaryOrganizationMock.mockResolvedValue('org_test');
    queryMock.mockResolvedValue({ rows: [{ domain: 'owned.example' }] });
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn(),
      getHostedBrandByDomain: vi.fn(),
      createHostedBrand: vi.fn(),
    };

    const res = await request(buildApp(brandDb))
      .post('/api/brands/setup-my-brand')
      .send({
        domain: 'victim.example',
        brand_name: 'Victim',
        brand_json: {
          house: { domain: 'victim.example', name: 'Victim' },
          brands: [{ id: 'victim', names: [{ en: 'Victim' }], keller_type: 'master' }],
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This domain is not associated with your organization');
    expect(queryMock).toHaveBeenCalledWith(
      'SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND verified = true',
      ['org_test']
    );
    expect(brandDb.createHostedBrand).not.toHaveBeenCalled();
  });
});
