import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ discovery: vi.fn(), owner: vi.fn() }));
vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_probe_versions';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_probe_versions';
});
vi.mock('@adcp/sdk/testing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  testCapabilityDiscovery: mocks.discovery,
}));
vi.mock('../../src/services/agent-ownership.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/agent-ownership.js')>()),
  resolveOwnerOrgForUser: mocks.owner,
}));

import { createMemberToolHandlers } from '../../src/addie/mcp/member-tools.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

describe('hosted capability discovery callers', () => {
  beforeEach(() => {
    mocks.discovery.mockReset().mockResolvedValue({
      profile: { adcp_supported_versions: ['3.1'], supported_protocols: [], specialisms: [] },
      steps: [],
    });
    mocks.owner.mockReset().mockResolvedValue('org_owner');
  });
  afterEach(() => vi.restoreAllMocks());

  it('recommend_storyboards probes the explicit target rather than the SDK default', async () => {
    await createMemberToolHandlers(null).get('recommend_storyboards')!({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/mcp',
      compliance_target: '3.1.24',
    });
    expect(mocks.discovery).toHaveBeenCalledOnce();
    expect(mocks.discovery.mock.calls[0][1]).toMatchObject({
      adcpVersion: '3.1.24', versionEnvelope: 'auto',
      auth: { type: 'bearer', token: expect.any(String) },
      transport: { fetchFn: expect.any(Function) },
    });
  });

  it('recommend_storyboards uses major-only discovery before selecting a target', async () => {
    await createMemberToolHandlers(null).get('recommend_storyboards')!({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/mcp',
    });
    expect(mocks.discovery).toHaveBeenCalledOnce();
    expect(mocks.discovery.mock.calls[0][1].versionEnvelope).toBe('major-only');
    expect(mocks.discovery.mock.calls[0][1].adcpVersion).toBeUndefined();
  });

  it('applicable-storyboards uses the same major-only discovery strategy', async () => {
    vi.spyOn(AgentContextDatabase.prototype, 'getAuthInfoByOrgAndUrl').mockResolvedValue(null);
    vi.spyOn(AgentContextDatabase.prototype, 'getByOrgAndUrl').mockResolvedValue(null);
    const app = express();
    const requireAuth: import('express').RequestHandler = (req, _res, next) => {
      req.user = { id: 'user_owner', email: 'owner@example.com' } as typeof req.user;
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
      requireAuth, optionalAuth: requireAuth,
    }));
    await request(app).get('/api/registry/agents/' + encodeURIComponent('https://agent.example/mcp') + '/applicable-storyboards');
    expect(mocks.discovery).toHaveBeenCalledOnce();
    expect(mocks.discovery.mock.calls[0][1].versionEnvelope).toBe('major-only');
    expect(mocks.discovery.mock.calls[0][1].adcpVersion).toBeUndefined();
  });
});
