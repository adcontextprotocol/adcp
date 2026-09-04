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
});
