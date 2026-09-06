import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  evaluateCanaryMock,
  recordCanaryDecisionMock,
  getEnforcementWorkosMock,
  legacyMembershipMock,
  getStalledLearnersMock,
} = vi.hoisted(() => {
  process.env.WORKOS_API_KEY ||= 'sk_test_certification_stalled_canary';
  process.env.WORKOS_CLIENT_ID ||= 'client_test_certification_stalled_canary';
  process.env.WORKOS_COOKIE_PASSWORD ||= 'test-cookie-password-32chars-min-len-1234';
  return {
    evaluateCanaryMock: vi.fn(),
    recordCanaryDecisionMock: vi.fn(),
    getEnforcementWorkosMock: vi.fn(() => ({ bounded: true })),
    legacyMembershipMock: vi.fn(),
    getStalledLearnersMock: vi.fn(),
  };
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    userManagement = { listOrganizationMemberships: legacyMembershipMock };
  },
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
  requireAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    req.user = {
      id: 'user_canonical',
      authWorkosUserId: 'user_authenticated',
      email: 'linked@example.test',
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    next();
  },
  isDevModeEnabled: () => false,
}));

vi.mock('../../src/auth/workos-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-client.js')>()),
  getAuthorizationEnforcementWorkos: getEnforcementWorkosMock,
}));

vi.mock('../../src/middleware/organization-authorization-canary.js', () => ({
  ORGANIZATION_AUTHORIZATION_BOUNDARIES: {
    ORGANIZATION_CERTIFICATION_STALLED_COUNT_READ:
      'organization_certification_stalled_count_read',
  },
  evaluateOrganizationAuthorizationCanary: evaluateCanaryMock,
  recordOrganizationAuthorizationCanaryDecision: recordCanaryDecisionMock,
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getStalledLearners: getStalledLearnersMock,
}));

import { createCertificationRouters } from '../../src/routes/certification.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', createCertificationRouters().orgRouter);
  return app;
}

describe('GET organization certification stalled count authorization canary', () => {
  beforeEach(() => {
    evaluateCanaryMock.mockReset().mockResolvedValue({ enforced: false });
    recordCanaryDecisionMock.mockReset();
    legacyMembershipMock.mockReset().mockResolvedValue({ data: [{}] });
    getStalledLearnersMock.mockReset().mockResolvedValue([{}, {}]);
  });

  it('preserves the legacy membership success and count-only response while disabled', async () => {
    const response = await request(createApp()).get(
      '/api/organizations/org_test/certification-stalled',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 2 });
    expect(Object.keys(response.body)).toEqual(['count']);
    expect(legacyMembershipMock).toHaveBeenCalledWith({
      userId: 'user_canonical', organizationId: 'org_test',
    });
    expect(evaluateCanaryMock).toHaveBeenCalledWith(expect.objectContaining({
      boundary: 'organization_certification_stalled_count_read',
      principal: expect.objectContaining({ id: 'user_canonical', authWorkosUserId: 'user_authenticated' }),
      organizationId: 'org_test',
      getWorkos: getEnforcementWorkosMock,
      minimumRole: 'member',
    }));
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(getStalledLearnersMock).toHaveBeenCalledWith('org_test');
  });

  it('preserves legacy denial without reading learner data while disabled', async () => {
    legacyMembershipMock.mockResolvedValueOnce({ data: [] });

    const response = await request(createApp()).get(
      '/api/organizations/org_test/certification-stalled',
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'You are not a member of this organization' });
    expect(recordCanaryDecisionMock).not.toHaveBeenCalled();
    expect(getStalledLearnersMock).not.toHaveBeenCalled();
  });

  it('uses an authorized exact member grant without legacy membership lookup', async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: 'authorized',
      membership: { organizationId: 'org_test', role: 'member', source: 'credential_grant' },
    });

    const response = await request(createApp()).get(
      '/api/organizations/org_test/certification-stalled',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 2 });
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      'organization_certification_stalled_count_read',
      expect.objectContaining({ enforced: true, status: 'authorized' }),
    );
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
  });

  it('denies before legacy membership or learner reads when enforced credentials are forbidden', async () => {
    evaluateCanaryMock.mockResolvedValue({ enforced: true, status: 'forbidden' });

    const response = await request(createApp()).get(
      '/api/organizations/org_test/certification-stalled',
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'You are not a member of this organization' });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      'organization_certification_stalled_count_read',
      { enforced: true, status: 'forbidden' },
    );
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(getStalledLearnersMock).not.toHaveBeenCalled();
  });

  it('returns the standard unavailable response before learner reads', async () => {
    evaluateCanaryMock.mockResolvedValue({
      enforced: true,
      status: 'unavailable',
      unavailableSources: ['credential_grant'],
    });

    const response = await request(createApp()).get(
      '/api/organizations/org_test/certification-stalled',
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Authorization temporarily unavailable',
      message: 'Organization access could not be verified. Please retry.',
    });
    expect(recordCanaryDecisionMock).toHaveBeenCalledWith(
      'organization_certification_stalled_count_read',
      expect.objectContaining({ enforced: true, status: 'unavailable' }),
    );
    expect(recordCanaryDecisionMock).toHaveBeenCalledOnce();
    expect(legacyMembershipMock).not.toHaveBeenCalled();
    expect(getStalledLearnersMock).not.toHaveBeenCalled();
  });
});
