import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const validateCrawlDomainMock = vi.fn();
const isAuthenticatedUserAAOAdminMock = vi.fn();

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_registry_adagents_revalidate';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_registry_adagents_revalidate';
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
const ORIGINAL_DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const ORIGINAL_DEV_USER_ID = process.env.DEV_USER_ID;

function buildApp(options: {
  user?: { id: string; authWorkosUserId?: string; email: string; isAdmin?: boolean };
  crawler: Pick<RegistryApiConfig['crawler'], 'revalidatePublisherAdagents'>
    & Partial<Pick<RegistryApiConfig['crawler'], 'getPublisherCrawlRequest'>>;
}) {
  const app = express();
  app.use(express.json());

  const requireAuth: import('express').RequestHandler = (req, _res, next) => {
    if (options.user) {
      req.user = options.user as typeof req.user;
    }
    next();
  };

  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: options.crawler as RegistryApiConfig['crawler'],
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

describe('POST /api/registry/publisher/:domain/adagents/revalidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADMIN_EMAILS;
    delete process.env.DEV_USER_EMAIL;
    delete process.env.DEV_USER_ID;
    validateCrawlDomainMock.mockImplementation(async (domain: string) => domain.toLowerCase().trim());
    isAuthenticatedUserAAOAdminMock.mockImplementation(async (principal: { id: string; authWorkosUserId?: string }) => (principal.authWorkosUserId ?? principal.id) === 'admin_user');
  });

  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
    if (ORIGINAL_DEV_USER_EMAIL === undefined) delete process.env.DEV_USER_EMAIL;
    else process.env.DEV_USER_EMAIL = ORIGINAL_DEV_USER_EMAIL;
    if (ORIGINAL_DEV_USER_ID === undefined) delete process.env.DEV_USER_ID;
    else process.env.DEV_USER_ID = ORIGINAL_DEV_USER_ID;
  });

  it('revalidates a publisher domain for an admin and returns the persisted verdict', async () => {
    const revalidatePublisherAdagents = vi.fn().mockResolvedValue({
      domain: 'publisher.example',
      adagents_valid: true,
      checked_at: '2026-06-16T12:00:00.000Z',
      properties_count: 3,
      authorized_agents_count: 1,
      status_code: 200,
      resolved_url: 'https://publisher.example/.well-known/adagents.json',
      discovery_method: 'direct',
    });

    const res = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      crawler: { revalidatePublisherAdagents },
    }))
      .post('/api/registry/publisher/Publisher.Example/adagents/revalidate?force=true')
      .send();

    expect(res.status).toBe(200);
    expect(validateCrawlDomainMock).toHaveBeenCalledWith('publisher.example');
    expect(revalidatePublisherAdagents).toHaveBeenCalledWith('publisher.example', { force: true });
    expect(res.body).toMatchObject({
      domain: 'publisher.example',
      adagents_valid: true,
      checked_at: '2026-06-16T12:00:00.000Z',
      properties_count: 3,
      authorized_agents_count: 1,
    });
  });

  it('returns validation issues for an invalid or missing adagents.json', async () => {
    const revalidatePublisherAdagents = vi.fn().mockResolvedValue({
      domain: 'missing.example',
      adagents_valid: false,
      checked_at: '2026-06-16T12:05:00.000Z',
      error: 'File not found at https://missing.example/.well-known/adagents.json',
      issues: {
        errors: [{ field: 'http_status', message: 'File not found at https://missing.example/.well-known/adagents.json', severity: 'error' }],
        warnings: [],
      },
      properties_count: 0,
      authorized_agents_count: 0,
      status_code: 404,
    });

    const res = await request(buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      crawler: { revalidatePublisherAdagents },
    }))
      .post('/api/registry/publisher/missing.example/adagents/revalidate')
      .send();

    expect(res.status).toBe(200);
    expect(revalidatePublisherAdagents).toHaveBeenCalledWith('missing.example', { force: false });
    expect(res.body).toMatchObject({
      domain: 'missing.example',
      adagents_valid: false,
      error: 'File not found at https://missing.example/.well-known/adagents.json',
      issues: {
        errors: [{ field: 'http_status', severity: 'error' }],
        warnings: [],
      },
      status_code: 404,
    });
  });

  it('rate limits repeated revalidation for the same domain', async () => {
    const revalidatePublisherAdagents = vi.fn().mockResolvedValue({
      domain: 'rate-limited.example',
      adagents_valid: true,
      checked_at: '2026-06-16T12:00:00.000Z',
      status_code: 200,
    });
    const app = buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      crawler: { revalidatePublisherAdagents },
    });

    const first = await request(app)
      .post('/api/registry/publisher/rate-limited.example/adagents/revalidate')
      .send();
    const second = await request(app)
      .post('/api/registry/publisher/rate-limited.example/adagents/revalidate')
      .send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({
      error: 'Rate limit exceeded for this domain',
    });
    expect(typeof second.body.retry_after).toBe('number');
    expect(revalidatePublisherAdagents).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable 503 and releases the rate-limit reservation on crawl contention', async () => {
    const revalidatePublisherAdagents = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('crawl busy'), { code: 'crawl_deferred' }))
      .mockResolvedValueOnce({
        domain: 'busy.example',
        adagents_valid: true,
        checked_at: '2026-06-16T12:00:00.000Z',
        status_code: 200,
      });
    const app = buildApp({
      user: { id: 'admin_user', email: 'admin@example.com', isAdmin: true },
      crawler: { revalidatePublisherAdagents },
    });

    const busy = await request(app)
      .post('/api/registry/publisher/busy.example/adagents/revalidate')
      .send();
    const retry = await request(app)
      .post('/api/registry/publisher/busy.example/adagents/revalidate')
      .send();

    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('5');
    expect(busy.body).toEqual({
      error: 'Publisher crawl is temporarily busy',
      code: 'publisher_crawl_busy',
      retry_after: 5,
    });
    expect(retry.status).toBe(200);
    expect(revalidatePublisherAdagents).toHaveBeenCalledTimes(2);
  });

  it('rejects authenticated non-admin callers', async () => {
    const revalidatePublisherAdagents = vi.fn();
    isAuthenticatedUserAAOAdminMock.mockResolvedValue(false);

    const res = await request(buildApp({
      user: { id: 'member_user', email: 'member@example.com', isAdmin: false },
      crawler: { revalidatePublisherAdagents },
    }))
      .post('/api/registry/publisher/example.com/adagents/revalidate')
      .send();

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Admin access required' });
    expect(revalidatePublisherAdagents).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers', async () => {
    const revalidatePublisherAdagents = vi.fn();

    const res = await request(buildApp({
      crawler: { revalidatePublisherAdagents },
    }))
      .post('/api/registry/publisher/example.com/adagents/revalidate')
      .send();

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Authentication required' });
    expect(revalidatePublisherAdagents).not.toHaveBeenCalled();
  });
  it.each([
    { authenticated: 'admin_user', canonical: 'member_user', allowed: true },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false },
  ])('uses exact $authenticated authority linked to $canonical, ignoring stale isAdmin', async ({ authenticated, canonical, allowed }) => {
    const user = { id: canonical, authWorkosUserId: authenticated, email: 'credential@example.com', isAdmin: !allowed };
    const sideEffect = vi.fn().mockResolvedValue({ domain: 'security.example', adagents_valid: true });
    const app = buildApp({ user, crawler: { revalidatePublisherAdagents: sideEffect } });
    const response = await request(app).post('/api/registry/publisher/security.example/adagents/revalidate').send();
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
    const sideEffect = vi.fn().mockResolvedValue({ domain: 'security.example', adagents_valid: true });
    const app = buildApp({ user, crawler: { revalidatePublisherAdagents: sideEffect } });
    const response = await request(app).post('/api/registry/publisher/security.example/adagents/revalidate').send();
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
    const sideEffect = vi.fn().mockResolvedValue({ domain: 'security.example', adagents_valid: true });
    const app = buildApp({ user, crawler: { revalidatePublisherAdagents: sideEffect } });
    const response = await request(app).post('/api/registry/publisher/security.example/adagents/revalidate').send();
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
    const sideEffect = vi.fn().mockResolvedValue({ domain: 'security.example', adagents_valid: true });
    const app = buildApp({ user, crawler: { revalidatePublisherAdagents: sideEffect } });
    const response = await request(app).post('/api/registry/publisher/security.example/adagents/revalidate').send();
    expect(response.status).toBe(decision === 'revoked' ? 403 : 503);
    expect(sideEffect).not.toHaveBeenCalled();
    if (decision === 'unavailable') expect(response.body.error).toBe('admin_authorization_unavailable');
    expect(isAuthenticatedUserAAOAdminMock).toHaveBeenCalledTimes(2);
    // A refusal before the crawler runs must release its per-domain reservation.
    const retry = await request(app).post('/api/registry/publisher/security.example/adagents/revalidate').send();
    expect(retry.status).toBe(200);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { authenticated: 'admin_user', canonical: 'member_user', allowed: true, mutate: false },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false, mutate: false },
    { authenticated: 'admin_user', canonical: 'member_user', allowed: true, mutate: true },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false, mutate: true },
    { authenticated: 'member_user', canonical: 'admin_user', allowed: false, mutate: false, unavailable: true },
  ])('keeps crawl status authority on $authenticated before asynchronous row loading (mutate=$mutate)', async ({ authenticated, canonical, allowed, mutate, unavailable }) => {
    if (unavailable) isAuthenticatedUserAAOAdminMock.mockRejectedValueOnce(new AAOAdminLookupUnavailableError());
    const user = { id: canonical, authWorkosUserId: authenticated, email: 'credential@example.com', isAdmin: !allowed };
    const id = '11111111-1111-4111-8111-111111111111';
    const getPublisherCrawlRequest = vi.fn(async () => {
      await Promise.resolve();
      if (mutate) {
        user.id = authenticated;
        user.authWorkosUserId = canonical;
        user.email = 'changed@example.com';
      }
      return {
        id, publisher_domain: 'private-request.example', requester_type: 'user',
        requested_by_user_id: 'unrelated_requester', status: 'succeeded', attempts: 1, max_attempts: 2,
        created_at: new Date(), completed_at: new Date(), available_at: new Date(),
      };
    });
    const response = await request(buildApp({
      user, crawler: { revalidatePublisherAdagents: vi.fn(), getPublisherCrawlRequest },
    })).get(`/api/registry/crawl-request/${id}`).send();
    expect(response.status).toBe(unavailable ? 503 : allowed ? 200 : 404);
    if (unavailable) {
      expect(response.body.error).toBe('admin_authorization_unavailable');
      expect(response.headers['retry-after']).toBe('5');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    if (allowed) expect(response.body.domain).toBe('private-request.example');
    const principal = isAuthenticatedUserAAOAdminMock.mock.calls[0][0];
    expect(principal.id).toBe(authenticated);
    expect(principal.email).toBe('credential@example.com');
    expect(Object.isFrozen(principal)).toBe(true);
  });

  it.each([
    { authenticated: 'request_owner', canonical: 'member_user', allowed: true },
    { authenticated: 'member_user', canonical: 'request_owner', allowed: false },
  ])('uses exact $authenticated ownership for crawl status instead of canonical $canonical', async ({ authenticated, canonical, allowed }) => {
    if (allowed) isAuthenticatedUserAAOAdminMock.mockRejectedValue(new AAOAdminLookupUnavailableError());
    const id = '22222222-2222-4222-8222-222222222222';
    const getPublisherCrawlRequest = vi.fn().mockResolvedValue({
      id, publisher_domain: 'owned-request.example', requester_type: 'user',
      requested_by_user_id: 'request_owner', status: 'succeeded', attempts: 1, max_attempts: 2,
      created_at: new Date(), completed_at: new Date(), available_at: new Date(),
    });
    const response = await request(buildApp({
      user: { id: canonical, authWorkosUserId: authenticated, email: 'credential@example.com' },
      crawler: { revalidatePublisherAdagents: vi.fn(), getPublisherCrawlRequest },
    })).get(`/api/registry/crawl-request/${id}`).send();
    expect(response.status).toBe(allowed ? 200 : 404);
    if (allowed) expect(isAuthenticatedUserAAOAdminMock).not.toHaveBeenCalled();
  });

  it.each([
    '/api/registry/authorizations?agent_url=https%3A%2F%2Fagent.example&include=raw',
    '/api/registry/authorizations/snapshot?include=raw',
  ])('keeps raw authorization audit access static-key-only at %s', async (path) => {
    const { AuthorizationSnapshotDatabase } = await import('../../src/db/authorization-snapshot-db.js');
    const narrow = vi.spyOn(AuthorizationSnapshotDatabase.prototype, 'getNarrow');
    const snapshot = vi.spyOn(AuthorizationSnapshotDatabase.prototype, 'openSnapshot');
    try {
      isAuthenticatedUserAAOAdminMock.mockResolvedValue(true);
      const response = await request(buildApp({
        user: { id: 'member_user', authWorkosUserId: 'admin_user', email: 'admin@example.com', isAdmin: true },
        crawler: { revalidatePublisherAdagents: vi.fn() },
      })).get(path).send();
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('include=raw requires admin access');
      expect(narrow).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      narrow.mockRestore();
      snapshot.mockRestore();
    }
  });

});
