import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isWebUserAAOAdmin } = vi.hoisted(() => ({
  isWebUserAAOAdmin: vi.fn(),
}));

vi.mock('../../src/addie/mcp/admin-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/addie/mcp/admin-tools.js')>()),
  isWebUserAAOAdmin,
}));

import { requireAdmin } from '../../src/middleware/auth.js';

describe('requireAdmin credential isolation', () => {
  beforeEach(() => {
    isWebUserAAOAdmin.mockReset();
    delete process.env.ADMIN_EMAILS;
  });

  it('does not inherit platform admin from the linked primary credential', async () => {
    isWebUserAAOAdmin.mockImplementation(async (userId: string) => userId === 'user_primary_admin');
    const req = {
      user: {
        id: 'user_primary_admin',
        authWorkosUserId: 'user_authenticated_nonadmin',
        email: 'not-admin@test.example',
      },
      originalUrl: '/api/admin/users',
      headers: { accept: 'application/json' },
      accepts: () => false,
    } as any;
    const json = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      json,
      redirect: vi.fn(),
      send: vi.fn(),
    } as any;
    const next = vi.fn();

    await requireAdmin(req, res, next);

    expect(isWebUserAAOAdmin).toHaveBeenCalledWith('user_authenticated_nonadmin');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
