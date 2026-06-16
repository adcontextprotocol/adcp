import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const validateCrawlDomainMock = vi.fn();
const isWebUserAAOAdminMock = vi.fn();

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

vi.mock('../../src/addie/admin-status-lookup.js', () => ({
  isWebUserAAOAdmin: (userId: string) => isWebUserAAOAdminMock(userId),
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;
const ORIGINAL_DEV_USER_EMAIL = process.env.DEV_USER_EMAIL;
const ORIGINAL_DEV_USER_ID = process.env.DEV_USER_ID;

function buildApp(options: {
  user?: { id: string; email: string; isAdmin?: boolean };
  crawler: Pick<RegistryApiConfig['crawler'], 'revalidatePublisherAdagents'>;
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
    isWebUserAAOAdminMock.mockResolvedValue(false);
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

  it('rejects authenticated non-admin callers', async () => {
    const revalidatePublisherAdagents = vi.fn();
    isWebUserAAOAdminMock.mockResolvedValue(false);

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
});
