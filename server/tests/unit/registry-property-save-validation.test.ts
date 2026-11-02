import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_property_save';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_property_save';
});
vi.mock('../../src/middleware/rate-limit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/middleware/rate-limit.js')>()),
  brandCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/services/hosted-property-sync.js', () => ({ syncHostedPropertyToFederatedIndex: vi.fn() }));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const propertyDb = {
  getHostedPropertyByDomain: vi.fn().mockResolvedValue(null),
  createHostedProperty: vi.fn().mockResolvedValue({ id: 'property_1' }),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  const auth: import('express').RequestHandler = (req, _res, next) => {
    req.user = { id: 'test_user', email: 'buyer@pinnacle.example' } as typeof req.user;
    next();
  };
  app.use('/api', createRegistryApiRouter({
    brandManager: {}, brandDb: {}, adagentsManager: {}, healthChecker: {},
    crawler: {}, capabilityDiscovery: {}, propertyDb,
    requireAuth: auth, optionalAuth: auth,
  } as unknown as RegistryApiConfig));
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('property save domain validation', () => {
  it('rejects missing and non-string domains', async () => {
    for (const publisher_domain of [undefined, null, 123, {}]) {
      const response = await request(buildApp()).post('/api/properties/save').send({ publisher_domain });
      expect(response.status).toBe(400);
    }
    expect(propertyDb.getHostedPropertyByDomain).not.toHaveBeenCalled();
    expect(propertyDb.createHostedProperty).not.toHaveBeenCalled();
  });

  it.each(['publisher.example', 'publisher.test', 'example.com', 'https://publisher.com/path', 'publisher.com:443', 'Publisher.com', ' publisher.com', 'publisher.com\n', '*.publisher.com', '127.0.0.1'])(
    'rejects invalid or reserved production input before accessing the catalog: %s', async publisher_domain => {
      const response = await request(buildApp()).post('/api/properties/save').send({ publisher_domain });
      expect(response.status).toBe(400);
      expect(propertyDb.getHostedPropertyByDomain).not.toHaveBeenCalled();
      expect(propertyDb.createHostedProperty).not.toHaveBeenCalled();
    },
  );

  it('simulates a sandbox save without a hosted-property lookup or write', async () => {
    const response = await request(buildApp()).post('/api/properties/save').send({
      publisher_domain: 'publisher.example', sandbox: true,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, sandbox: true });
    expect(response.body.id).toBeTruthy();
    expect(propertyDb.getHostedPropertyByDomain).not.toHaveBeenCalled();
    expect(propertyDb.createHostedProperty).not.toHaveBeenCalled();
  });

  it('does not allow sandbox to bypass hostname syntax validation', async () => {
    const response = await request(buildApp()).post('/api/properties/save').send({
      publisher_domain: 'https://publisher.example/path', sandbox: true,
    });
    expect(response.status).toBe(400);
    expect(propertyDb.createHostedProperty).not.toHaveBeenCalled();
  });

  it('rejects non-boolean sandbox values', async () => {
    for (const sandbox of ['true', 'false', null, 1]) {
      const response = await request(buildApp()).post('/api/properties/save').send({ publisher_domain: 'publisher.com', sandbox });
      expect(response.status).toBe(400);
    }
    expect(propertyDb.createHostedProperty).not.toHaveBeenCalled();
  });

  it('preserves production saves and the identity-only authorization boundary', async () => {
    const response = await request(buildApp()).post('/api/properties/save').send({
      publisher_domain: 'publisher.com', authorized_agents: [{ url: 'https://agent.example' }],
    });
    expect(response.status).toBe(200);
    expect(propertyDb.createHostedProperty).toHaveBeenCalledWith(expect.objectContaining({
      publisher_domain: 'publisher.com', adagents_json: expect.objectContaining({ authorized_agents: [] }),
    }));
    expect(response.body.sandbox).toBeUndefined();
  });
});
