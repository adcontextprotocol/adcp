import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveUserOrgMembership: vi.fn(),
  getEventBySlug: vi.fn(),
  getWorkos: vi.fn(() => ({ userManagement: {} })),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'user_123', email: 'member@example.test' } as Request['user'];
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  optionalAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: mocks.getWorkos,
}));

vi.mock('../../src/utils/resolve-user-org-membership.js', () => ({
  resolveUserOrgMembership: mocks.resolveUserOrgMembership,
}));

vi.mock('../../src/db/events-db.js', () => ({
  eventsDb: {
    getEventBySlug: mocks.getEventBySlug,
  },
}));

import { createEventsRouter } from '../../src/routes/events.js';

function mountPublicRouter() {
  const app = express();
  app.use(express.json());
  app.use('/api/events', createEventsRouter().publicApiRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveUserOrgMembership.mockResolvedValue(null);
  mocks.getEventBySlug.mockResolvedValue(null);
});

describe('event sponsorship organization authorization', () => {
  it('rejects a caller who is not a current member of the requested organization', async () => {
    const response = await request(mountPublicRouter())
      .post('/api/events/adcp-summit/sponsor')
      .send({ tier_id: 'gold', org_id: 'org_other' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Organization access denied');
    expect(mocks.resolveUserOrgMembership).toHaveBeenCalledWith(
      mocks.getWorkos.mock.results[0]?.value,
      'user_123',
      'org_other',
    );
    expect(mocks.getEventBySlug).not.toHaveBeenCalled();
  });

  it('continues only for an exact active membership in the requested organization', async () => {
    mocks.resolveUserOrgMembership.mockResolvedValue({
      organizationId: 'org_member',
      role: 'member',
      status: 'active',
      via_dev_bypass: false,
    });

    const response = await request(mountPublicRouter())
      .post('/api/events/adcp-summit/sponsor')
      .send({ tier_id: 'gold', org_id: 'org_member' });

    expect(response.status).toBe(404);
    expect(mocks.getEventBySlug).toHaveBeenCalledWith('adcp-summit');
  });

  it.each([
    ['inactive membership', { organizationId: 'org_member', role: 'member', status: 'inactive', via_dev_bypass: false }],
    ['membership for another org', { organizationId: 'org_other', role: 'member', status: 'active', via_dev_bypass: false }],
  ])('rejects an %s returned by the authority resolver', async (_label, resolvedMembership) => {
    mocks.resolveUserOrgMembership.mockResolvedValue(resolvedMembership);

    const response = await request(mountPublicRouter())
      .post('/api/events/adcp-summit/sponsor')
      .send({ tier_id: 'gold', org_id: 'org_member' });

    expect(response.status).toBe(403);
    expect(mocks.getEventBySlug).not.toHaveBeenCalled();
  });
});
