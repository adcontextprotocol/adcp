import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const validateCrawlDomainMock = vi.fn();
const isAuthenticatedUserAAOAdminMock = vi.fn();

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

vi.mock('../../src/addie/admin-status-lookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>()),
  isAuthenticatedUserAAOAdmin: (principal: { id: string; authWorkosUserId?: string; email?: string | null }) => isAuthenticatedUserAAOAdminMock(principal),
}));

import { AAOAdminLookupUnavailableError } from '../../src/addie/admin-status-lookup.js';
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
  user?: { id: string; authWorkosUserId?: string; email: string; isAdmin?: boolean };
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
    isAuthenticatedUserAAOAdminMock.mockImplementation(async (principal: { id: string; authWorkosUserId?: string }) => (principal.authWorkosUserId ?? principal.id) === 'admin_user');
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
  it.each([
    { authenticated: 'admin_user', canonical: 'member_user', allowed: true },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false },
  ])('uses exact $authenticated authority linked to $canonical, ignoring stale isAdmin', async ({ authenticated, canonical, allowed }) => {
    const user = { id: canonical, authWorkosUserId: authenticated, email: 'credential@example.com', isAdmin: !allowed };
    const sideEffect = vi.fn().mockResolvedValue({ found: false, valid: false, variant: null, manifestPersisted: false });
    const app = buildApp({ user, scanBrandForDomain: sideEffect, getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null) });
    const response = await request(app).post('/api/registry/brand/security.example/force-crawl').send();
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(sideEffect).toHaveBeenCalledTimes(Number(allowed));
    expect(isAuthenticatedUserAAOAdminMock).toHaveBeenCalledTimes(allowed ? 2 : 1);
    const principal = isAuthenticatedUserAAOAdminMock.mock.calls[0][0];
    expect(principal.authWorkosUserId ?? principal.id).toBe(authenticated);
    expect(principal.email).toBe('credential@example.com');
    expect(Object.isFrozen(principal)).toBe(true);
    expect(principal).not.toBe(user);
    for (const [checked] of isAuthenticatedUserAAOAdminMock.mock.calls) expect(checked).toBe(principal);
  });

  it('returns retryable unavailable without trusting a stale admin flag or running the side effect', async () => {
    isAuthenticatedUserAAOAdminMock.mockRejectedValueOnce(new AAOAdminLookupUnavailableError());
    const user = { id: 'admin_user', authWorkosUserId: 'revoked_credential', email: 'credential@example.com', isAdmin: true };
    const sideEffect = vi.fn().mockResolvedValue({ found: false, valid: false, variant: null, manifestPersisted: false });
    const app = buildApp({ user, scanBrandForDomain: sideEffect, getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null) });
    const response = await request(app).post('/api/registry/brand/security.example/force-crawl').send();
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('admin_authorization_unavailable');
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it.each([
    { authenticated: 'admin_user', canonical: 'member_user', allowed: true },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false },
  ])('captures immutable $authenticated provenance before an awaited authorization lookup', async ({ authenticated, canonical, allowed }) => {
    const user = { id: canonical, authWorkosUserId: authenticated, email: 'credential@example.com', isAdmin: !allowed };
    isAuthenticatedUserAAOAdminMock.mockImplementationOnce(async (principal) => {
      await Promise.resolve();
      user.id = authenticated;
      user.authWorkosUserId = canonical;
      user.email = 'changed@example.com';
      return (principal.authWorkosUserId ?? principal.id) === 'admin_user';
    });
    const sideEffect = vi.fn().mockResolvedValue({ found: false, valid: false, variant: null, manifestPersisted: false });
    const app = buildApp({ user, scanBrandForDomain: sideEffect, getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null) });
    const response = await request(app).post('/api/registry/brand/security.example/force-crawl').send();
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(sideEffect).toHaveBeenCalledTimes(Number(allowed));
    const principal = isAuthenticatedUserAAOAdminMock.mock.calls[0][0];
    expect(Object.isFrozen(principal)).toBe(true);
    expect(principal.authWorkosUserId ?? principal.id).toBe(authenticated);
    expect(principal.email).toBe('credential@example.com');
  });

  it.each(['revoked', 'unavailable'] as const)('fails closed when authorization becomes %s during preflight I/O', async (decision) => {
    const user = { id: 'member_user', authWorkosUserId: 'admin_user', email: 'credential@example.com', isAdmin: true };
    isAuthenticatedUserAAOAdminMock.mockResolvedValueOnce(true);
    if (decision === 'revoked') isAuthenticatedUserAAOAdminMock.mockResolvedValueOnce(false);
    else isAuthenticatedUserAAOAdminMock.mockRejectedValueOnce(new AAOAdminLookupUnavailableError());
    const sideEffect = vi.fn().mockResolvedValue({ found: false, valid: false, variant: null, manifestPersisted: false });
    const app = buildApp({ user, scanBrandForDomain: sideEffect, getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null) });
    const response = await request(app).post('/api/registry/brand/security.example/force-crawl').send();
    expect(response.status).toBe(decision === 'revoked' ? 403 : 503);
    expect(sideEffect).not.toHaveBeenCalled();
    if (decision === 'unavailable') expect(response.body.error).toBe('admin_authorization_unavailable');
    expect(isAuthenticatedUserAAOAdminMock).toHaveBeenCalledTimes(2);
    // A refusal before the crawler runs must release its per-domain reservation.
    const retry = await request(app).post('/api/registry/brand/security.example/force-crawl').send();
    expect(retry.status).toBe(200);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

});
