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
  getRegistryMetadata: vi.fn(),
  upsertRegistryMetadata: vi.fn(),
  setComplianceOptOut: vi.fn(),
  revokeAllBadges: vi.fn(),
  getComplianceRun: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  notifyVerificationChange: vi.fn(),
}));

const ownershipMocks = vi.hoisted(() => ({
  findOwnedAgentVisibility: vi.fn(),
  findOwnerOrgForUser: vi.fn(),
  isOrgOwnerOfAgent: vi.fn(),
  resolveOwnerOrgForUser: vi.fn(),
  canManageAgentForOrg: vi.fn(),
}));

const gradingMocks = vi.hoisted(() => ({
  selectGradingProfile: vi.fn(),
  completeGradingProfileProjectionJob: vi.fn(),
}));
const badgeIssuanceMocks = vi.hoisted(() => ({ runBadgeFanOut: vi.fn() }));
const adminStatusMocks = vi.hoisted(() => ({
  isWebUserAAOAdmin: vi.fn(),
  isAuthenticatedUserAAOAdmin: vi.fn(),
}));
const databaseMocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../../src/services/agent-ownership.js', () => ownershipMocks);
vi.mock('../../src/notifications/compliance.js', () => notificationMocks);
vi.mock('../../src/addie/admin-status-lookup.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/addie/admin-status-lookup.js')>(),
  ...adminStatusMocks,
}));
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  query: databaseMocks.query,
}));

vi.mock('../../src/middleware/rate-limit.js', () => {
  const pass: import('express').RequestHandler = (_req, _res, next) => next();
  return {
    bulkResolveRateLimiter: pass,
    brandBulkDomainRateLimiter: pass,
    brandCreationRateLimiter: pass,
    capabilityProbeRateLimiter: pass,
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
    getRegistryMetadata = complianceMocks.getRegistryMetadata;
    upsertRegistryMetadata = complianceMocks.upsertRegistryMetadata;
    setComplianceOptOut = complianceMocks.setComplianceOptOut;
    revokeAllBadges = complianceMocks.revokeAllBadges;
    getComplianceRun = complianceMocks.getComplianceRun;
  },
}));

vi.mock('../../src/db/verification-profile-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/verification-profile-db.js')>();
  return {
    ...actual,
    selectGradingProfile: gradingMocks.selectGradingProfile,
    completeGradingProfileProjectionJob: gradingMocks.completeGradingProfileProjectionJob,
    getEffectiveGradingDecision: vi.fn().mockResolvedValue({
      profile: 'legacy',
      revision: '0',
      assessment: null,
      spec_failure_since: null,
    }),
  };
});

vi.mock('../../src/services/badge-issuance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/badge-issuance.js')>();
  return { ...actual, runBadgeFanOut: badgeIssuanceMocks.runBadgeFanOut };
});

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

const VALID_ROLES = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'brand',
  'sponsored-intelligence',
];

function buildApp(
  visibility: 'public' | 'members_only' | 'private' = 'public',
  authenticated: boolean | { id: string; authWorkosUserId?: string; email?: string } = false,
): express.Express {
  const app = express();
  app.use(express.json());
  const passAuth: import('express').RequestHandler = (req, _res, next) => {
    if (authenticated) {
      req.user = (typeof authenticated === 'boolean'
        ? { id: 'user_badge_owner' }
        : authenticated) as typeof req.user;
    }
    next();
  };
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
          visibility,
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
    complianceMocks.getRegistryMetadata.mockResolvedValue(null);
    complianceMocks.upsertRegistryMetadata.mockResolvedValue({ compliance_opt_out: false });
    complianceMocks.setComplianceOptOut.mockResolvedValue({
      metadata: { compliance_opt_out: false },
      revoked: [],
    });
    complianceMocks.revokeAllBadges.mockResolvedValue([]);
    notificationMocks.notifyVerificationChange.mockReset();
    notificationMocks.notifyVerificationChange.mockResolvedValue(undefined);
    ownershipMocks.findOwnerOrgForUser.mockResolvedValue('org_badge_owner');
    ownershipMocks.findOwnedAgentVisibility.mockResolvedValue('public');
    ownershipMocks.canManageAgentForOrg.mockResolvedValue(true);
    adminStatusMocks.isWebUserAAOAdmin.mockReset();
    adminStatusMocks.isWebUserAAOAdmin.mockResolvedValue(false);
    adminStatusMocks.isAuthenticatedUserAAOAdmin.mockReset();
    adminStatusMocks.isAuthenticatedUserAAOAdmin.mockResolvedValue(false);
    databaseMocks.query.mockReset();
    databaseMocks.query.mockResolvedValue({ rowCount: 1, rows: [{}] });
    gradingMocks.selectGradingProfile.mockReset();
    gradingMocks.completeGradingProfileProjectionJob.mockReset();
    gradingMocks.completeGradingProfileProjectionJob.mockResolvedValue(undefined);
    gradingMocks.selectGradingProfile.mockResolvedValue({
      selected_profile: 'spec', revision: '1', public_effect: 'regrade', replayed: false,
      source_run_id: '33333333-3333-4333-8333-333333333333',
    });
    complianceMocks.getComplianceRun.mockResolvedValue({
      agent_profile_json: {
        specialisms: ['sales-non-guaranteed'],
        adcp_supported_versions: ['3.1.4'],
      },
    });
    badgeIssuanceMocks.runBadgeFanOut.mockReset();
    badgeIssuanceMocks.runBadgeFanOut.mockResolvedValue({ issued: [], revoked: [], degraded: [], unchanged: [] });
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
    expect(response.headers['cache-control']).toBe('public, max-age=0, s-maxage=0, must-revalidate');
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
    expect(response.headers['cache-control']).toBe('no-store');
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
    expect(response.headers['cache-control']).toBe('no-store');
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
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps badge verification independent from private registry discoverability', async () => {
    complianceMocks.getHighestVersionActiveBadge.mockResolvedValue({
      role: 'media-buy',
      adcp_version: '3.1',
      verification_modes: ['spec'],
    });
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp('private'))
      .get(`/api/registry/agents/${encodedUrl}/badge/media-buy/embed`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      agent_url: AGENT_URL,
      role: 'media-buy',
      verified: true,
      adcp_version: '3.1',
    });
  });

  it.each([
    ['verification', 'json'],
    ['badge/media-buy.svg', 'svg'],
    ['badge/media-buy/embed', 'embed'],
    ['badge/media-buy/3.1.svg', 'svg'],
    ['badge/media-buy/3.1/embed', 'embed'],
  ] as const)('renders database-suppressed badge state on %s', async (suffix, responseKind) => {
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp())
      .get(`/api/registry/agents/${encodedUrl}/${suffix}`);

    expect(response.status).toBe(200);
    if (responseKind === 'svg') {
      expect(response.body.toString()).toContain('Not Verified');
      expect(response.headers['cache-control']).toBe('public, max-age=0, s-maxage=0, must-revalidate');
    } else if (responseKind === 'embed') {
      expect(response.body.verified).toBe(false);
      expect(response.headers['cache-control']).toBe('no-store');
    } else {
      expect(response.body).toMatchObject({ verified: false, badges: [] });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(complianceMocks.getRegistryMetadata).not.toHaveBeenCalled();
  });

  it('revokes every badge immediately when an owner opts out', async () => {
    complianceMocks.setComplianceOptOut.mockResolvedValue({
      metadata: { agent_url: AGENT_URL, compliance_opt_out: true },
      revoked: [
        { role: 'media-buy', adcp_version: '3.0' },
        { role: 'creative', adcp_version: '3.1' },
      ],
    });
    const encodedUrl = encodeURIComponent(AGENT_URL);

    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodedUrl}/compliance/opt-out`)
      .send({ opt_out: true });

    expect(response.status).toBe(200);
    expect(complianceMocks.setComplianceOptOut).toHaveBeenCalledWith(
      AGENT_URL,
      true,
      'user:user_badge_owner',
      true,
    );
    expect(notificationMocks.notifyVerificationChange).toHaveBeenCalledWith({
      agentUrl: AGENT_URL,
      issued: [],
      revoked: [
        { role: 'media-buy', adcp_version: '3.0', reason: 'Compliance monitoring opted out' },
        { role: 'creative', adcp_version: '3.1', reason: 'Compliance monitoring opted out' },
      ],
      actor: 'user:user_badge_owner',
      emitFeedEvents: false,
    });
  });

  it('canonicalizes the agent URL before ownership and opt-out writes', async () => {
    const rawAgentUrl = 'HTTPS://BADGE.EXAMPLE.COM/MCP/';
    const canonicalAgentUrl = 'https://badge.example.com/mcp';

    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(rawAgentUrl)}/compliance/opt-out`)
      .send({ opt_out: true });

    expect(response.status).toBe(200);
    expect(ownershipMocks.findOwnerOrgForUser).toHaveBeenCalledWith(
      'user_badge_owner',
      canonicalAgentUrl,
    );
    expect(complianceMocks.setComplianceOptOut).toHaveBeenCalledWith(
      canonicalAgentUrl,
      true,
      'user:user_badge_owner',
      true,
    );
  });

  it('keeps private-agent revocation notifications out of shared channels and feeds', async () => {
    ownershipMocks.findOwnedAgentVisibility.mockResolvedValue('private');
    complianceMocks.setComplianceOptOut.mockResolvedValue({
      metadata: { agent_url: AGENT_URL, compliance_opt_out: true },
      revoked: [{ role: 'media-buy', adcp_version: '3.1' }],
    });

    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/compliance/opt-out`)
      .send({ opt_out: true });

    expect(response.status).toBe(200);
    expect(complianceMocks.setComplianceOptOut).toHaveBeenCalledWith(
      AGENT_URL,
      true,
      'user:user_badge_owner',
      false,
    );
    expect(notificationMocks.notifyVerificationChange).toHaveBeenCalledWith(
      expect.objectContaining({ emitFeedEvents: false, notifyChannel: false }),
    );
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

  it('requires an authenticated user for grading-profile selection', async () => {
    const response = await request(buildApp())
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({});

    expect(response.status).toBe(401);
  });

  it('rejects Sandbox selection before authorization or database access', async () => {
    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_badge_owner',
        role: 'media-buy',
        adcp_version: '3.1',
        selected_profile: 'sandbox',
        assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0,
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Sandbox is preview-only');
  });

  it('commits an owner selection and refreshes only the exact role', async () => {
    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_badge_owner', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ selected_profile: 'spec', token_refresh: 'completed' });
    expect(badgeIssuanceMocks.runBadgeFanOut).toHaveBeenCalledWith(expect.objectContaining({
      roles: ['media-buy'], adcpVersions: ['3.1'], throwOnFailure: true,
    }));
  });

  it('rejects a cross-tenant selection before profile mutation', async () => {
    ownershipMocks.canManageAgentForOrg.mockResolvedValueOnce(false);
    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_other', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
      });

    expect(response.status).toBe(403);
    expect(gradingMocks.selectGradingProfile).not.toHaveBeenCalled();
  });

  it('does not inherit grading-profile admin authority from a linked canonical profile', async () => {
    ownershipMocks.canManageAgentForOrg.mockResolvedValueOnce(false);
    adminStatusMocks.isAuthenticatedUserAAOAdmin.mockImplementation(async ({ id }) => id === 'user_badge_owner');

    const response = await request(buildApp('private', {
      id: 'user_badge_owner',
      authWorkosUserId: 'credential_non_admin',
      email: 'credential@example.test',
    }))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_other', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
        admin_override_reason: 'Support request',
      });

    expect(response.status).toBe(403);
    expect(adminStatusMocks.isAuthenticatedUserAAOAdmin).toHaveBeenCalledWith({
      id: 'credential_non_admin',
      email: 'credential@example.test',
    });
    expect(databaseMocks.query).not.toHaveBeenCalled();
    expect(gradingMocks.selectGradingProfile).not.toHaveBeenCalled();
  });

  it('rechecks and audits exact credential authority for a registry-admin override', async () => {
    ownershipMocks.canManageAgentForOrg.mockResolvedValueOnce(false);
    adminStatusMocks.isAuthenticatedUserAAOAdmin.mockResolvedValue(true);

    const response = await request(buildApp('private', {
      id: 'user_linked_profile',
      authWorkosUserId: 'credential_admin',
      email: 'admin-credential@example.test',
    }))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_other', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
        admin_override_reason: 'Support request',
      });

    expect(response.status).toBe(200);
    expect(adminStatusMocks.isAuthenticatedUserAAOAdmin).toHaveBeenCalledTimes(2);
    expect(gradingMocks.selectGradingProfile).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'credential_admin',
      actorKind: 'registry_admin',
      adminOverrideReason: 'Support request',
    }));
  });

  it('fails closed when exact registry-admin authority is revoked before dispatch', async () => {
    ownershipMocks.canManageAgentForOrg.mockResolvedValueOnce(false);
    adminStatusMocks.isAuthenticatedUserAAOAdmin
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const response = await request(buildApp('private', {
      id: 'user_linked_profile',
      authWorkosUserId: 'credential_revoked',
    }))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_other', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
        admin_override_reason: 'Support request',
      });

    expect(response.status).toBe(403);
    expect(gradingMocks.selectGradingProfile).not.toHaveBeenCalled();
  });

  it('durably schedules convergence when post-commit token refresh fails', async () => {
    badgeIssuanceMocks.runBadgeFanOut.mockRejectedValueOnce(new Error('signing unavailable'));
    const response = await request(buildApp('private', true))
      .put(`/api/registry/agents/${encodeURIComponent(AGENT_URL)}/grading-profile`)
      .send({
        organization_id: 'org_badge_owner', role: 'media-buy', adcp_version: '3.1',
        selected_profile: 'spec', assessment_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: 0, idempotency_key: '22222222-2222-4222-8222-222222222222',
      });

    expect(response.status).toBe(200);
    expect(response.body.token_refresh).toBe('scheduled');
    expect(gradingMocks.completeGradingProfileProjectionJob).not.toHaveBeenCalled();
  });
});
