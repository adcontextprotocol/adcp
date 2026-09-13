import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorkingGroupBySlug: vi.fn(),
  isMember: vi.fn(),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    getWorkingGroupBySlug = mocks.getWorkingGroupBySlug;
    isMember = mocks.isMember;
  },
}));

import {
  AAO_ADMIN_POSITIVE_CACHE_TTL_MS,
  AAOAdminLookupUnavailableError,
  isAuthenticatedUserAAOAdmin,
  isWebUserAAOAdmin,
  resolveWebUserAAOAdminAccess,
} from '../../src/addie/admin-status-lookup.js';
import { isBreakGlassAdminEmail } from '../../src/auth/admin-access.js';
import {
  getSlackAdminStatusCache,
  getWebAdminStatusCache,
  invalidateAllAdminStatusCaches,
  invalidateWebAdminStatusCache,
} from '../../src/addie/admin-status-cache.js';

describe('site-admin access decisions', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.clearAllMocks();
    invalidateAllAdminStatusCaches();
    process.env.ADMIN_EMAILS = ' break-glass@example.test , other@example.test ';
    mocks.getWorkingGroupBySlug.mockResolvedValue({ id: 'wg_aao_admin' });
    mocks.isMember.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateAllAdminStatusCaches();
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  });

  it('bounds cached positive membership decisions to one minute', async () => {
    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(true);
    const cached = getWebAdminStatusCache().get('user_admin');

    expect(cached?.expiresAt).toBe(Date.now() + AAO_ADMIN_POSITIVE_CACHE_TTL_MS);
    vi.advanceTimersByTime(AAO_ADMIN_POSITIVE_CACHE_TTL_MS + 1);
    await isWebUserAAOAdmin('user_admin');
    expect(mocks.isMember).toHaveBeenCalledTimes(2);
  });

  it('clears the current process cache immediately', async () => {
    await isWebUserAAOAdmin('user_admin');
    invalidateWebAdminStatusCache('user_admin');
    mocks.isMember.mockResolvedValue(false);

    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(false);
    expect(mocks.isMember).toHaveBeenCalledTimes(2);
  });

  it('clears both web and Slack process-local admin cache forms', () => {
    getWebAdminStatusCache().set('user_admin', { isAdmin: true, expiresAt: Date.now() + 60_000 });
    getSlackAdminStatusCache().set('slack_admin', { isAdmin: true, expiresAt: Date.now() + 60_000 });

    invalidateAllAdminStatusCaches();

    expect(getWebAdminStatusCache().size).toBe(0);
    expect(getSlackAdminStatusCache().size).toBe(0);
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
    expect(getWebAdminStatusCache().has(canonical)).toBe(false);
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
    expect(getWebAdminStatusCache().has('user_admin')).toBe(false);
    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(true);
  });

  it('never reuses an expired positive decision while its refresh is unavailable', async () => {
    await isWebUserAAOAdmin('user_admin');
    vi.advanceTimersByTime(AAO_ADMIN_POSITIVE_CACHE_TTL_MS + 1);
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin' })).rejects.toMatchObject({
      code: 'admin_authorization_unavailable', statusCode: 503,
    });
    expect(getWebAdminStatusCache().has('user_admin')).toBe(false);
  });

  it('treats a missing authority group as unavailable', async () => {
    mocks.getWorkingGroupBySlug.mockResolvedValue(null);
    await expect(resolveWebUserAAOAdminAccess({ id: 'user_admin' })).rejects.toBeInstanceOf(AAOAdminLookupUnavailableError);
    expect(mocks.isMember).not.toHaveBeenCalled();
    expect(getWebAdminStatusCache().size).toBe(0);
  });

  it('keeps legacy boolean callers fail-closed during an outage', async () => {
    mocks.isMember.mockRejectedValue(new Error('database unavailable'));
    await expect(isWebUserAAOAdmin('user_admin')).resolves.toBe(false);
    await expect(resolveWebUserAAOAdminAccess('user_admin', 'ordinary@example.test'))
      .resolves.toEqual({ isAdmin: false, mechanism: null });
    expect(getWebAdminStatusCache().has('user_admin')).toBe(false);
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
