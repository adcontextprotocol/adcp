import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorkingGroupBySlug: vi.fn(),
  isMember: vi.fn(),
  getBySlackUserId: vi.fn(),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    getWorkingGroupBySlug = mocks.getWorkingGroupBySlug;
    isMember = mocks.isMember;
  },
}));
vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class SlackDatabase {
    getBySlackUserId = mocks.getBySlackUserId;
  },
}));

import {
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
  isWebUserAAOAdmin,
  resolveWebUserAAOAdminAccess,
} from '../../src/addie/admin-status-lookup.js';
import { isBreakGlassAdminEmail } from '../../src/auth/admin-access.js';
import { invalidateAllAdminStatusCaches } from '../../src/addie/admin-status-cache.js';

describe('site-admin access decisions', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAllAdminStatusCaches();
    process.env.ADMIN_EMAILS = ' break-glass@example.test , other@example.test ';
    mocks.getWorkingGroupBySlug.mockResolvedValue({ id: 'wg_aao_admin' });
    mocks.isMember.mockResolvedValue(true);
    mocks.getBySlackUserId.mockResolvedValue({ workos_user_id: 'user_admin' });
  });

  afterEach(() => {
    invalidateAllAdminStatusCaches();
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  });

  it('makes a grant immediately visible to an independent replica after its prior denial', async () => {
    mocks.isMember.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    vi.resetModules();
    const replicaA = await import('../../src/addie/admin-status-lookup.js');
    await expect(replicaA.isWebUserAAOAdmin('user_admin')).resolves.toBe(false);
    vi.resetModules();
    const replicaB = await import('../../src/addie/admin-status-lookup.js');
    await expect(replicaB.isWebUserAAOAdmin('user_admin')).resolves.toBe(true);
    expect(mocks.isMember).toHaveBeenCalledTimes(2);
  });

  it('makes a revocation immediately visible to an independent replica after its prior grant', async () => {
    mocks.isMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    vi.resetModules();
    const replicaA = await import('../../src/addie/admin-status-lookup.js');
    await expect(replicaA.isWebUserAAOAdmin('user_admin')).resolves.toBe(true);
    vi.resetModules();
    const replicaB = await import('../../src/addie/admin-status-lookup.js');
    await expect(replicaB.isWebUserAAOAdmin('user_admin')).resolves.toBe(false);
    expect(mocks.isMember).toHaveBeenCalledTimes(2);
  });

  it('re-queries Slack AAO-admin membership across fresh replicas for denial, grant, and revocation', async () => {
    mocks.isMember.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    vi.resetModules();
    const replicaA = await import('../../src/addie/mcp/admin-tools.js');
    await expect(replicaA.isSlackUserAAOAdmin('slack_admin')).resolves.toBe(false);
    vi.resetModules();
    const replicaB = await import('../../src/addie/mcp/admin-tools.js');
    await expect(replicaB.isSlackUserAAOAdmin('slack_admin')).resolves.toBe(true);
    vi.resetModules();
    const replicaC = await import('../../src/addie/mcp/admin-tools.js');
    await expect(replicaC.isSlackUserAAOAdmin('slack_admin')).resolves.toBe(false);

    expect(mocks.getBySlackUserId).toHaveBeenCalledTimes(3);
    expect(mocks.isMember).toHaveBeenCalledTimes(3);
  });

  it('identifies the environment-only break-glass mechanism separately', async () => {
    mocks.isMember.mockResolvedValue(false);
    expect(isBreakGlassAdminEmail('BREAK-GLASS@example.test')).toBe(true);
    await expect(resolveWebUserAAOAdminAccess('user_no_membership', 'break-glass@example.test'))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });

  it.each([
    { authenticated: 'user_admin', canonical: 'user_member', expected: true },
    { authenticated: 'user_member', canonical: 'user_admin', expected: false },
  ])('authorizes $authenticated independently of linked $canonical', async ({ authenticated, canonical, expected }) => {
    mocks.isMember.mockImplementation(async (_group, userId) => userId === 'user_admin');
    await expect(isAuthenticatedUserAAOAdmin({
      id: canonical,
      authWorkosUserId: authenticated,
      email: 'ordinary@example.test',
    })).resolves.toBe(expected);
    expect(mocks.isMember).toHaveBeenCalledWith('wg_aao_admin', authenticated);
  });

  it('uses only the authenticated email for a break-glass decision', async () => {
    mocks.isMember.mockResolvedValue(false);
    await expect(resolveWebUserAAOAdminAccess({
      id: 'user_admin', authWorkosUserId: 'user_member', email: 'ordinary@example.test',
    })).resolves.toEqual({ isAdmin: false, mechanism: null });
    await expect(resolveWebUserAAOAdminAccess({
      id: 'user_member', authWorkosUserId: 'user_admin', email: 'BREAK-GLASS@example.test',
    })).resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });

  it('reports a lookup outage separately and retries without caching a denial', async () => {
    mocks.isMember.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin' })).rejects.toBeInstanceOf(AAOAdminLookupUnavailableError);
    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(true);
  });

  it('never reuses a prior positive decision while a later lookup is unavailable', async () => {
    await isWebUserAAOAdmin('user_admin');
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin' })).rejects.toMatchObject({
      code: 'admin_authorization_unavailable', statusCode: 503,
    });
  });

  it('treats a missing authority group as unavailable', async () => {
    mocks.getWorkingGroupBySlug.mockResolvedValue(null);
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin' })).rejects.toBeInstanceOf(AAOAdminLookupUnavailableError);
    expect(mocks.isMember).not.toHaveBeenCalled();
  });

  it('keeps legacy boolean callers fail-closed during an outage', async () => {
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(false);
    await expect(resolveWebUserAAOAdminAccess('user_admin', 'ordinary@example.test'))
      .resolves.toEqual({ isAdmin: false, mechanism: null });
  });

  it('preserves independent break-glass authority for legacy string callers', async () => {
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveWebUserAAOAdminAccess('user_admin', 'break-glass@example.test'))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });

  it('honors an independent break-glass grant during a lookup outage', async () => {
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin', email: 'break-glass@example.test' }))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });
});
