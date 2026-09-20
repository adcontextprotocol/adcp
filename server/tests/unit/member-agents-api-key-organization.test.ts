import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../src/middleware/rate-limit.js', () => ({
  brandCreationRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { createMemberAgentsRouter } from '../../src/routes/member-agents.js';

const memberDb = { getProfileByOrgId: vi.fn() };
const orgDb = { getOrganization: vi.fn() };
const listOrganizationMemberships = vi.fn();

function buildApp(apiKeyOrg: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 'api_key_key_existing' };
    (req as any).apiKey = {
      id: 'key_existing',
      organizationId: apiKeyOrg,
      name: 'Registry Automation',
      permissions: [],
    };
    next();
  });
  app.use('/api/me/agents', createMemberAgentsRouter({
    memberDb: memberDb as any,
    orgDb: orgDb as any,
    workos: { userManagement: { listOrganizationMemberships } } as any,
    invalidateMemberContextCache: () => {},
  }));
  return app;
}

describe('/api/me/agents API-key organization selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgDb.getOrganization.mockResolvedValue({
      workos_organization_id: 'org_existing',
      name: 'Existing organization',
    });
    memberDb.getProfileByOrgId.mockResolvedValue({
      agents: [{ url: 'https://agent.example.test/mcp', type: 'sales', visibility: 'private' }],
    });
  });

  it('uses the validated key scope without looking up a synthetic user membership', async () => {
    const response = await request(buildApp('org_existing')).get('/api/me/agents');

    expect(response.status).toBe(200);
    expect(response.body.agents).toHaveLength(1);
    expect(orgDb.getOrganization).toHaveBeenCalledWith('org_existing');
    expect(memberDb.getProfileByOrgId).toHaveBeenCalledWith('org_existing');
    expect(listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it('returns a stable conflict instead of a POST/GET 500 when local provisioning is absent', async () => {
    orgDb.getOrganization.mockResolvedValue(null);

    const response = await request(buildApp('org_missing')).get('/api/me/agents');

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('api_key_organization_not_provisioned');
    expect(memberDb.getProfileByOrgId).not.toHaveBeenCalled();
  });

  it('rejects a selector that conflicts with the key scope', async () => {
    const response = await request(buildApp('org_existing'))
      .get('/api/me/agents')
      .query({ org: 'org_other' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('organization_selection_conflict');
    expect(orgDb.getOrganization).not.toHaveBeenCalled();
  });
});
