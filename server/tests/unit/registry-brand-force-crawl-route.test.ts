import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const validateCrawlDomainMock = vi.fn();
const isWebUserAAOAdminMock = vi.fn();

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_registry_brand_force_crawl';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_registry_brand_force_crawl';
});

vi.mock('../../src/utils/url-security.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/utils/url-security.js');
  return {
    ...actual,
    validateCrawlDomain: (domain: string) => validateCrawlDomainMock(domain),
  };
});

vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isWebUserAAOAdmin: (userId: string) => isWebUserAAOAdminMock(userId),
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

function brand(overrides: Record<string, unknown>) {
  return {
    id: 'brand-1',
    domain: 'brand.example',
    has_brand_manifest: true,
    source_type: 'community',
    discovered_at: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildApp(options: {
  user?: { id: string; email: string; isAdmin?: boolean };
  scanBrandForDomain: ReturnType<typeof vi.fn>;
  getDiscoveredBrandByDomain: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());

  const requireAuth: import('express').RequestHandler = (req, _res, next) => {
    if (options.user) req.user = options.user as typeof req.user;
    next();
  };

  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: { getDiscoveredBrandByDomain: options.getDiscoveredBrandByDomain } as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: { scanBrandForDomain: options.scanBrandForDomain } as RegistryApiConfig['crawler'],
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

describe('POST /api/registry/brand/:domain/force-crawl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_EMAILS;
    validateCrawlDomainMock.mockImplementation(async (domain: string) => domain.toLowerCase().trim());
    isWebUserAAOAdminMock.mockResolvedValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  });

  it('synchronously adopts live brand.json evidence and reports raw promotion', async () => {
    const getDiscoveredBrandByDomain = vi.fn()
      .mockResolvedValueOnce(brand({
        source_type: 'community',
        workos_organization_id: 'org_brand',
        domain_verified: true,
      }))
      .mockResolvedValueOnce(brand({
        source_type: 'brand_json',
        workos_organization_id: 'org_brand',
        domain_verified: true,
      }));
    const scanBrandForDomain = vi.fn().mockResolvedValue({
      found: true,
      valid: true,
      variant: 'brand_canonical',
      manifestPersisted: true,
    });

    const response = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      scanBrandForDomain,
      getDiscoveredBrandByDomain,
    }))
      .post('/api/registry/brand/Brand.Example/force-crawl')
      .send();

    expect(response.status).toBe(200);
    expect(validateCrawlDomainMock).toHaveBeenCalledWith('brand.example');
    expect(scanBrandForDomain).toHaveBeenCalledWith('brand.example');
    expect(response.body).toMatchObject({
      domain: 'brand.example',
      previous_source: 'hosted',
      new_source: 'hosted',
      previous_source_type: 'community',
      new_source_type: 'brand_json',
      promoted: true,
      brand_json_found: true,
      live_variant: 'brand_canonical',
      has_manifest: true,
    });
  });

  it('reports a stub without claiming promotion when no valid brand.json exists', async () => {
    const existing = brand({ source_type: 'stub', has_brand_manifest: false });
    const getDiscoveredBrandByDomain = vi.fn().mockResolvedValue(existing);
    const scanBrandForDomain = vi.fn().mockResolvedValue({
      found: false,
      valid: false,
      variant: null,
      manifestPersisted: false,
    });

    const response = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      scanBrandForDomain,
      getDiscoveredBrandByDomain,
    }))
      .post('/api/registry/brand/missing.example/force-crawl')
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      promoted: false,
      brand_json_found: false,
      previous_source: 'stub',
      new_source: 'stub',
      previous_source_type: 'stub',
      new_source_type: 'stub',
      live_variant: null,
    });
  });

  it('does not treat a stale stored brand_json row as a successful live crawl', async () => {
    const existing = brand({ source_type: 'brand_json', has_brand_manifest: true });
    const response = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      scanBrandForDomain: vi.fn().mockResolvedValue({
        found: false,
        valid: false,
        variant: null,
        manifestPersisted: false,
      }),
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(existing),
    }))
      .post('/api/registry/brand/stale.example/force-crawl')
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      previous_source_type: 'brand_json',
      new_source_type: 'brand_json',
      promoted: false,
      brand_json_found: false,
      live_variant: null,
      has_manifest: true,
    });
  });

  it('reports a valid live redirect even when no full manifest is persisted', async () => {
    const getDiscoveredBrandByDomain = vi.fn()
      .mockResolvedValueOnce(brand({ source_type: 'community', has_brand_manifest: false }))
      .mockResolvedValueOnce(brand({ source_type: 'brand_json', has_brand_manifest: false }));
    const response = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      scanBrandForDomain: vi.fn().mockResolvedValue({
        found: true,
        valid: true,
        variant: 'house_redirect',
        manifestPersisted: false,
      }),
      getDiscoveredBrandByDomain,
    }))
      .post('/api/registry/brand/redirect.example/force-crawl')
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      previous_source_type: 'community',
      new_source_type: 'brand_json',
      promoted: true,
      brand_json_found: true,
      live_variant: 'house_redirect',
      has_manifest: false,
    });
  });

  it('rejects authenticated non-admin callers before crawling', async () => {
    const getDiscoveredBrandByDomain = vi.fn();
    const scanBrandForDomain = vi.fn();

    const response = await request(buildApp({
      user: { id: 'member_user', email: 'member@example.com' },
      scanBrandForDomain,
      getDiscoveredBrandByDomain,
    }))
      .post('/api/registry/brand/example.com/force-crawl')
      .send();

    expect(response.status).toBe(403);
    expect(scanBrandForDomain).not.toHaveBeenCalled();
    expect(getDiscoveredBrandByDomain).not.toHaveBeenCalled();
  });
});
