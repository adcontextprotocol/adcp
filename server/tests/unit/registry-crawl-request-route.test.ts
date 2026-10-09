import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type RequestHandler } from 'express';
import request from 'supertest';

const validateCrawlDomainMock = vi.fn();

vi.mock('../../src/utils/url-security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/url-security.js')>()),
  validateCrawlDomain: (domain: string) => validateCrawlDomainMock(domain),
}));

import {
  CrawlQueueCapacityError,
  CrawlRequestRateLimitError,
} from '../../src/db/publisher-crawl-requests-db.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

type TestUser = { id: string; authWorkosUserId?: string; email: string };
type CrawlRequest = Request & { isStaticAdminApiKey?: boolean };

function buildApp(options: { user?: TestUser; staticAdmin?: boolean } = {}) {
  const state = {
    user: options.user,
    staticAdmin: options.staticAdmin ?? false,
    request: undefined as CrawlRequest | undefined,
  };
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    req.user = state.user as typeof req.user;
    state.request = req as CrawlRequest;
    state.request.isStaticAdminApiKey = state.staticAdmin;
    next();
  };
  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: { enqueuePublisherCrawlRequest: enqueue } as unknown as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth,
    optionalAuth: requireAuth,
  }));
  const post = (domain = 'publisher.example') => request(app)
    .post('/api/registry/crawl-request')
    .send({ domain });
  return { state, enqueue, post };
}

function linkedUser(): TestUser {
  return { id: 'primary_credential', authWorkosUserId: 'secondary_credential', email: 'requester@example.com' };
}

describe('POST /api/registry/crawl-request requester provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PUBLISHER_CRAWL_QUEUE_ENABLED', 'true');
    validateCrawlDomainMock.mockImplementation(async (domain: string) => domain.toLowerCase().trim());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['mutate', 'replace', 'remove'] as const)(
    'keeps the authenticated credential when DNS validation can %s req.user and set the static-admin flag',
    async (mutation) => {
      const user = linkedUser();
      const { state, enqueue, post } = buildApp({ user });
      validateCrawlDomainMock.mockImplementationOnce(async (domain: string) => {
        await Promise.resolve();
        if (mutation === 'mutate') {
          user.id = 'replacement_canonical';
          user.authWorkosUserId = 'replacement_credential';
          user.email = 'replacement@example.com';
        } else {
          state.request!.user = mutation === 'remove' ? undefined : {
            id: 'replacement_canonical',
            authWorkosUserId: 'replacement_credential',
            email: 'replacement@example.com',
          } as Request['user'];
        }
        state.request!.isStaticAdminApiKey = true;
        return domain;
      });

      const response = await post();

      expect(response.status).toBe(202);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        id: response.body.crawl_request_id,
        domain: 'publisher.example',
        requesterType: 'user',
        requestedByUserId: 'secondary_credential',
      }));
    },
  );

  it('preserves static-admin/null attribution when validation replaces its request state', async () => {
    const { state, enqueue, post } = buildApp({ staticAdmin: true });
    validateCrawlDomainMock.mockImplementationOnce(async (domain: string) => {
      await Promise.resolve();
      state.request!.isStaticAdminApiKey = false;
      state.request!.user = linkedUser() as Request['user'];
      return domain;
    });

    const response = await post();

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requesterType: 'static_admin',
      requestedByUserId: null,
    }));
  });

  it('denies a missing principal before validation can supply a user or static-admin flag', async () => {
    const { state, enqueue, post } = buildApp();
    validateCrawlDomainMock.mockImplementation(async (domain: string) => {
      state.request!.user = linkedUser() as Request['user'];
      state.request!.isStaticAdminApiKey = true;
      return domain;
    });

    const denied = await post();

    expect(denied.status).toBe(401);
    expect(validateCrawlDomainMock).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    state.user = linkedUser();
    expect((await post()).status).toBe(202);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requesterType: 'user',
      requestedByUserId: 'secondary_credential',
    }));
  });

  it('does not validate, enqueue, or reserve a domain while the queue is disabled', async () => {
    const { enqueue, post } = buildApp({ user: linkedUser() });
    vi.stubEnv('PUBLISHER_CRAWL_QUEUE_ENABLED', 'false');

    const unavailable = await post();

    expect(unavailable.status).toBe(503);
    expect(unavailable.body.code).toBe('crawl_queue_unavailable');
    expect(unavailable.headers['retry-after']).toBe('60');
    expect(validateCrawlDomainMock).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    vi.stubEnv('PUBLISHER_CRAWL_QUEUE_ENABLED', 'true');
    expect((await post()).status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue or reserve a domain rejected by validation', async () => {
    const { enqueue, post } = buildApp({ user: linkedUser() });
    validateCrawlDomainMock.mockRejectedValueOnce(new Error('Invalid domain'));

    expect((await post()).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await post()).status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('charges one exact credential across canonical changes and keeps linked credentials separate', async () => {
    const { state, enqueue, post } = buildApp({ user: linkedUser() });
    for (let index = 0; index < 30; index++) {
      expect((await post(`quota-${index}.example`)).status).toBe(202);
    }
    state.user = { ...linkedUser(), id: 'changed_canonical' };

    const denied = await post('quota-exhausted.example');

    expect(denied.status).toBe(429);
    expect(denied.body.error).toBe('Hourly crawl request limit exceeded');
    expect(enqueue).toHaveBeenCalledTimes(30);
    state.user = { ...state.user, authWorkosUserId: 'primary_credential' };
    expect((await post('quota-exhausted.example')).status).toBe(202);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      requesterType: 'user',
      requestedByUserId: 'primary_credential',
    }));
  });

  it.each([
    { label: 'database unavailable', error: new Error('database unavailable'), status: 503 },
    { label: 'queue capacity', error: new CrawlQueueCapacityError(10_000), status: 503 },
    { label: 'durable requester limit', error: new CrawlRequestRateLimitError('requester', 60), status: 429 },
    { label: 'durable domain limit', error: new CrawlRequestRateLimitError('domain', 60), status: 429 },
  ])('releases domain and exact-credential hourly reservations on $label after request mutation', async ({ error, status }) => {
    const { state, enqueue, post } = buildApp({ user: linkedUser() });
    for (let index = 0; index < 29; index++) {
      expect((await post(`reservation-${index}.example`)).status).toBe(202);
    }
    enqueue.mockImplementationOnce(async () => {
      await Promise.resolve();
      state.request!.user = { id: 'replacement_credential', email: 'replacement@example.com' } as Request['user'];
      state.request!.isStaticAdminApiKey = true;
      throw error;
    });

    expect((await post('reservation-retry.example')).status).toBe(status);
    expect(enqueue).toHaveBeenCalledTimes(30);
    expect((await post('reservation-retry.example')).status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(31);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      requesterType: 'user',
      requestedByUserId: 'secondary_credential',
    }));
    expect((await post('reservation-over-limit.example')).status).toBe(429);
    expect(enqueue).toHaveBeenCalledTimes(31);
  });
});
