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
import { decideAAOAdminAccess, isBreakGlassAdmin } from '../../src/auth/admin-access.js';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

function snapshot(overrides: Partial<AuthorizationSnapshot['credential']> = {}): AuthorizationSnapshot {
  return {
    authenticatedUserId: 'user_no_membership', canonicalUserId: 'user_no_membership',
    identityId: 'identity_admin_test', selectedOrganizationId: null, authorizationEpoch: '1',
    credentialGrant: null,
    credential: { email: 'BREAK-GLASS@example.test', emailVerified: true, emailMutationPending: false, firstName: null, lastName: null, ...overrides },
  };
}
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
    expect(isBreakGlassAdmin(snapshot())).toBe(true);
    await expect(resolveWebUserAAOAdminAccess('user_no_membership', snapshot()))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });

  it.each([true, undefined, null, 'false'])('denies unresolved or malformed mutation state %s', (emailMutationPending) => {
    const state = snapshot({ emailMutationPending: emailMutationPending as boolean });
    expect(isBreakGlassAdmin(state)).toBe(false);
    expect(decideAAOAdminAccess(false, state)).toEqual({ isAdmin: false, mechanism: null });
  });

  it.each([undefined, null])('denies missing authoritative snapshot %s', (state) => {
    expect(isBreakGlassAdmin(state)).toBe(false);
  });

  it('requires verified local email and never a provider email fallback', () => {
    expect(isBreakGlassAdmin(snapshot({ emailVerified: false }))).toBe(false);
    expect(isBreakGlassAdmin(snapshot({ email: 'ordinary@example.test' }))).toBe(false);
    expect(isBreakGlassAdmin(snapshot({ email: null }))).toBe(false);
  });

  it('rechecks mutation state instead of caching an email-based admin grant', async () => {
    mocks.isMember.mockResolvedValue(false);
    await expect(resolveWebUserAAOAdminAccess('user_no_membership', snapshot()))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
    await expect(resolveWebUserAAOAdminAccess('user_no_membership', snapshot({ emailMutationPending: true })))
      .resolves.toEqual({ isAdmin: false, mechanism: null });
    await expect(resolveWebUserAAOAdminAccess('user_no_membership', snapshot()))
      .resolves.toEqual({ isAdmin: true, mechanism: 'break_glass_admin_email' });
  });

  it('keeps independently granted working-group authority distinct from break glass', () => {
    expect(decideAAOAdminAccess(true, snapshot({ emailMutationPending: true })))
      .toEqual({ isAdmin: true, mechanism: 'aao_admin_working_group' });
  });

});
