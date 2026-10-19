import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const owner = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_clear_auth';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_clear_auth';
});
vi.mock('../../src/services/agent-ownership.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/agent-ownership.js')>()),
  resolveOwnerOrgForUser: owner,
}));

import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function app(authenticated = true) {
  const app = express();
  app.use(express.json());
  const requireAuth: import('express').RequestHandler = (req, _res, next) => {
    if (authenticated) req.user = { id: 'user_owner', email: 'owner@example.com' } as typeof req.user;
    next();
  };
  app.use('/api', createRegistryApiRouter({
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: { trackRequest: async () => {}, markResolved: async () => true },
    requireAuth,
    optionalAuth: requireAuth,
  }));
  return app;
}

const endpoint = '/api/registry/agents/' + encodeURIComponent('https://agent.example/mcp') + '/connect';

describe('DELETE saved static agent credentials', () => {
  let getContext: ReturnType<typeof vi.spyOn>;
  let removeToken: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    owner.mockReset().mockResolvedValue('org_owner');
    getContext = vi.spyOn(AgentContextDatabase.prototype, 'getByOrgAndUrl').mockResolvedValue({ id: 'ctx_owner' } as never);
    removeToken = vi.spyOn(AgentContextDatabase.prototype, 'removeAuthToken').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it('clears only the selected owner context without removing the agent', async () => {
    const response = await request(app()).delete(endpoint).query({ org: 'org_owner' });
    expect(response.status).toBe(204);
    expect(owner).toHaveBeenCalledWith('user_owner', 'https://agent.example/mcp', 'org_owner');
    expect(getContext).toHaveBeenCalledWith('org_owner', 'https://agent.example/mcp');
    expect(removeToken).toHaveBeenCalledExactlyOnceWith('ctx_owner');
  });

  it('is idempotent when no credential context exists', async () => {
    getContext.mockResolvedValue(null);
    expect((await request(app()).delete(endpoint)).status).toBe(204);
    expect(removeToken).not.toHaveBeenCalled();
  });

  it('refuses non-owners before reading or clearing credentials', async () => {
    owner.mockResolvedValue(null);
    expect((await request(app()).delete(endpoint).query({ org: 'org_other' })).status).toBe(403);
    expect(getContext).not.toHaveBeenCalled();
    expect(removeToken).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    expect((await request(app(false)).delete(endpoint)).status).toBe(401);
    expect(owner).not.toHaveBeenCalled();
    expect(removeToken).not.toHaveBeenCalled();
  });

  it('rejects malformed organization selectors', async () => {
    expect((await request(app()).delete(endpoint).query({ org: '' })).status).toBe(400);
    expect(owner).not.toHaveBeenCalled();
    expect(removeToken).not.toHaveBeenCalled();
  });

  it('reports storage failures instead of confirming credential removal', async () => {
    removeToken.mockRejectedValue(new Error('store unavailable'));
    expect((await request(app()).delete(endpoint)).status).toBe(500);
  });
});
