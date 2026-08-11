import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const AGENT_URL = 'https://badge.example.com/mcp';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_registry_badges';
  process.env.WORKOS_CLIENT_ID ||= 'client_registry_badges';
});

const complianceMocks = vi.hoisted(() => ({
  bulkGetComplianceStatus: vi.fn(),
  bulkGetRegistryMetadata: vi.fn(),
  bulkGetActiveBadges: vi.fn(),
  getHighestVersionActiveBadge: vi.fn(),
  getActiveBadge: vi.fn(),
  getBadgesForAgent: vi.fn(),
}));

vi.mock('../../src/middleware/rate-limit.js', () => {
  const pass: import('express').RequestHandler = (_req, _res, next) => next();
  return {
    bulkResolveRateLimiter: pass,
    brandBulkDomainRateLimiter: pass,
    brandCreationRateLimiter: pass,
    storyboardEvalRateLimiter: pass,
    storyboardStepRateLimiter: pass,
    agentReadRateLimiter: pass,
    registryPublisherRateLimiter: pass,
    registryReadRateLimiter: pass,
  };
});

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    bulkGetComplianceStatus = complianceMocks.bulkGetComplianceStatus;
    bulkGetRegistryMetadata = complianceMocks.bulkGetRegistryMetadata;
    bulkGetActiveBadges = complianceMocks.bulkGetActiveBadges;
    getHighestVersionActiveBadge = complianceMocks.getHighestVersionActiveBadge;
    getActiveBadge = complianceMocks.getActiveBadge;
    getBadgesForAgent = complianceMocks.getBadgesForAgent;
  },
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const VALID_ROLES = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'brand',
  'sponsored-intelligence',
];

function buildApp(): express.Express {
  const app = express();
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const config: RegistryApiConfig = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {
      getFederatedIndex: () => ({
        listAllAgents: vi.fn().mockResolvedValue([{
          name: 'Badge Agent',
          url: AGENT_URL,
          type: 'sales',
          protocol: 'mcp',
        }]),
      }),
    } as unknown as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  };
  app.use('/api', createRegistryApiRouter(config));
  return app;
}

describe('registry badge routes', () => {
  beforeEach(() => {
    for (const mock of Object.values(complianceMocks)) mock.mockReset();
    complianceMocks.getHighestVersionActiveBadge.mockResolvedValue(null);
    complianceMocks.getActiveBadge.mockResolvedValue(null);
    complianceMocks.getBadgesForAgent.mockResolvedValue([]);
  });

  it('reports every active version per verified role in newest-first order', async () => {
    complianceMocks.bulkGetComplianceStatus.mockResolvedValue(new Map([[AGENT_URL, {
      status: 'passing',
      requested_compliance_target: '3.1',
      adcp_version: '3.1.0',
      lifecycle_stage: 'production',
      tracks_summary_json: {},
      track_details_json: [],
      streak_days: 2,
      last_checked_at: new Date('2026-08-11T10:00:00Z'),
      headline: 'Passing',
    }]]));
    complianceMocks.bulkGetRegistryMetadata.mockResolvedValue(new Map([[AGENT_URL, {
      compliance_opt_out: false,
      monitoring_paused: false,
      check_interval_hours: 12,
    }]]));
    complianceMocks.bulkGetActiveBadges.mockResolvedValue(new Map([[AGENT_URL, [
      { role: 'media-buy', adcp_version: '3.2', verification_modes: ['spec'] },
      { role: 'creative', adcp_version: '3.0', verification_modes: ['spec'] },
      { role: 'media-buy', adcp_version: '3.10', verification_modes: ['spec'] },
    ]]]));

    const response = await request(buildApp()).get('/api/registry/agents?compliance=true');

    expect(response.status).toBe(200);
    expect(response.body.agents[0].compliance).toMatchObject({
      verified: true,
      verified_roles: ['media-buy', 'creative'],
      verified_role_versions: {
        'media-buy': ['3.10', '3.2'],
        creative: ['3.0'],
      },
    });
  });

  it.each([
    'badge/buying.svg',
    'badge/buying/3.1.svg',
    'badge/buying/embed',
    'badge/buying/3.1/embed',
  ])('returns a structured invalid-role error from %s', async (suffix) => {
    const encodedUrl = encodeURIComponent(AGENT_URL);
    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/${suffix}`);

    expect(response.status).toBe(400);
    const detail = `Invalid role "buying". Valid roles: ${VALID_ROLES.join(', ')}`;
    expect(response.body).toEqual({
      error: detail,
      code: 'invalid_role',
      message: detail,
      valid_roles: VALID_ROLES,
    });
  });

  it('keeps a missing version-pinned badge embeddable as a grey 200 SVG', async () => {
    complianceMocks.getActiveBadge.mockResolvedValue(null);
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/badge/media-buy/3.1.svg`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(response.headers['cache-control']).toBe('public, max-age=300, s-maxage=300, must-revalidate');
    expect(response.body.toString()).toContain('Not Verified');
  });

  it('reports an absent version-pinned badge with its requested version', async () => {
    complianceMocks.getActiveBadge.mockResolvedValue(null);
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/badge/media-buy/3.1/embed`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      agent_url: AGENT_URL,
      role: 'media-buy',
      verified: false,
      adcp_version: '3.1',
    });
  });

  it('reports an exact active role-version badge as verified', async () => {
    complianceMocks.getActiveBadge.mockResolvedValue({
      role: 'media-buy',
      adcp_version: '3.1',
      verification_modes: ['spec'],
    });
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/badge/media-buy/3.1/embed`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      role: 'media-buy',
      verified: true,
      adcp_version: '3.1',
    });
  });

  it('reports the highest active version from the unversioned embed', async () => {
    complianceMocks.getHighestVersionActiveBadge.mockResolvedValue({
      role: 'media-buy',
      adcp_version: '3.10',
      verification_modes: ['spec'],
    });
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/badge/media-buy/embed`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      role: 'media-buy',
      verified: true,
      adcp_version: '3.10',
    });
  });

  it.each([
    ['verification', 'all badges'],
    ['badge/media-buy.svg', 'highest-version badge'],
    ['badge/media-buy/embed', 'highest-version embed'],
    ['badge/media-buy/3.1.svg', 'version-pinned badge'],
    ['badge/media-buy/3.1/embed', 'version-pinned embed'],
  ])('returns an uncached 503 when the %s lookup fails (%s)', async (suffix) => {
    if (suffix === 'verification') {
      complianceMocks.getBadgesForAgent.mockRejectedValueOnce(new Error('database unavailable'));
    } else if (suffix.includes('/3.1')) {
      complianceMocks.getActiveBadge.mockRejectedValueOnce(new Error('database unavailable'));
    } else {
      complianceMocks.getHighestVersionActiveBadge.mockRejectedValueOnce(new Error('database unavailable'));
    }
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/${suffix}`);

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Badge status temporarily unavailable' });
  });
});
