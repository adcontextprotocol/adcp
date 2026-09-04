import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  revoke: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireGlobalAdmin: [
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: 'admin_1', email: 'admin@example.test' } as never;
      if (req.get('X-Test-Omit-Admin-Mechanism') !== 'true') {
        req.adminAccessMechanism = 'break_glass_admin_email';
      }
      next();
    },
  ],
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    grantAAOAdminMembership = mocks.grant;
    revokeAAOAdminMembership = mocks.revoke;
  },
}));

vi.mock('../../src/addie/admin-status-cache.js', () => ({
  invalidateAllAdminStatusCaches: mocks.invalidate,
}));

import { createAAOAdminRouter } from '../../src/routes/aao-admin.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/aao-admin', createAAOAdminRouter());
  return app;
}

describe('AAO site-admin mutation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.grant.mockResolvedValue({ workos_user_id: 'user_target' });
    mocks.revoke.mockResolvedValue('user_target');
  });

  it('rejects a blank reason before it attempts a grant', async () => {
    const response = await request(createApp())
      .post('/api/admin/aao-admin/grant')
      .send({ workos_user_id: 'user_target', reason: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('reason_required');
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('fails closed when middleware does not provide an audit authorization mechanism', async () => {
    const response = await request(createApp())
      .post('/api/admin/aao-admin/grant')
      .set('X-Test-Omit-Admin-Mechanism', 'true')
      .send({ workos_user_id: 'user_target', reason: 'Coverage rotation' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('admin_authorization_unavailable');
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('grants through the dedicated slug-pinned database operation and clears the local cache', async () => {
    const response = await request(createApp())
      .post('/api/admin/aao-admin/grant')
      .send({ workos_user_id: ' user_target ', reason: 'Coverage rotation' , working_group_id: 'attacker-controlled' });

    expect(response.status).toBe(201);
    expect(mocks.grant).toHaveBeenCalledWith({
      targetUserId: 'user_target',
      actorUserId: 'admin_1',
      actorAuthorizationMechanism: 'break_glass_admin_email',
      reason: 'Coverage rotation',
    });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it('records a revoke through the dedicated operation and invalidates its canonical target', async () => {
    const response = await request(createApp())
      .post('/api/admin/aao-admin/revoke')
      .send({ workos_user_id: 'slack_alias', reason: 'Offboarding' });

    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: 'slack_alias',
      reason: 'Offboarding',
    }));
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it('does not clear a cache entry when no active membership was revoked', async () => {
    mocks.revoke.mockResolvedValue(null);
    const response = await request(createApp())
      .post('/api/admin/aao-admin/revoke')
      .send({ workos_user_id: 'user_target', reason: 'Offboarding' });

    expect(response.status).toBe(404);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
