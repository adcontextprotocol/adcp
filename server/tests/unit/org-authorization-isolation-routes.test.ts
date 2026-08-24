import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFile } from 'node:fs/promises';

const { resolveUserOrgMembership } = vi.hoisted(() => ({
  resolveUserOrgMembership: vi.fn(),
}));

vi.mock('../../src/utils/resolve-user-org-membership.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/resolve-user-org-membership.js')>()),
  resolveUserOrgMembership,
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({}),
  workos: {},
}));

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_primary_b',
      authWorkosUserId: 'user_authenticated_a',
      email: 'a@test.example',
    };
    next();
  };
  return { ...actual, requireAuth };
});

import { createEngagementRouter } from '../../src/routes/engagement.js';
import { createCertificationRouters } from '../../src/routes/certification.js';
import { createBrandFeedsRouter } from '../../src/routes/brand-feeds.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/me/engagement', createEngagementRouter({
    orgDb: {} as any,
    orgKnowledgeDb: {} as any,
    workingGroupDb: {} as any,
  }));
  const certification = createCertificationRouters();
  app.use('/api/me', certification.userRouter);
  app.use('/api/organizations', certification.orgRouter);
  app.use('/api', createBrandFeedsRouter({
    brandDb: { getDiscoveredBrandByDomain: vi.fn() } as any,
  }));
  return app;
}

describe('organization authorization route isolation', () => {
  beforeEach(() => resolveUserOrgMembership.mockReset());

  it.each([
    ['/api/me/engagement', 'GET'],
    ['/api/me/certification/expectation', 'GET'],
    ['/api/brands/example.test/feeds', 'GET'],
  ])('fails closed when %s has no explicit organization', async (path, method) => {
    const app = buildApp();
    const response = method === 'GET'
      ? await request(app).get(path)
      : await request(app).post(path);
    expect(response.status).toBe(400);
    expect(resolveUserOrgMembership).not.toHaveBeenCalled();
  });

  it.each([
    '/api/me/engagement?org=org_b_only',
    '/api/me/certification/expectation?org=org_b_only',
    '/api/brands/example.test/feeds?org=org_b_only',
  ])('denies linked credential A access to organization B at %s', async (path) => {
    resolveUserOrgMembership.mockResolvedValue(null);
    const response = await request(buildApp()).get(path);
    expect(response.status).toBe(403);
    expect(resolveUserOrgMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'user_primary_b', authWorkosUserId: 'user_authenticated_a' }),
      'org_b_only',
    );
  });

  it('uses the authenticated credential for organization self-state and mutation actors', async () => {
    const source = await readFile(new URL('../../src/routes/organizations.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('getUserPendingRequests(user.id)');
    expect(source).not.toContain('inviterUserId: adminUser.id');
    expect(source).not.toContain('workos_user_id: adminUser.id');
    expect(source).toContain('getUserPendingRequests(authorizationUserId)');
    expect(source).toContain('inviterUserId: actorCredentialId');
  });

  it('rechecks live organization authority at the remaining mutation boundaries', async () => {
    const source = await readFile(new URL('../../src/routes/organizations.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/if \(!slackUser\.workos_user_id\)[\s\S]+?currentCallerMembership[\s\S]+?sendInvitation/);
    expect(source).toMatch(/Directly add user to organization[\s\S]+?currentCallerMembership[\s\S]+?createOrganizationMembership/);
    expect(source).toMatch(/Generate portal link for domain verification[\s\S]+?currentMembership[\s\S]+?adminPortal\.generateLink/);
  });
});
