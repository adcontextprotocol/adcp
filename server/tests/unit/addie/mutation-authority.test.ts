import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  epoch: vi.fn(),
  isAdmin: vi.fn(),
}));

vi.mock('../../../src/db/authorization-epoch-db.js', () => ({
  getExactCredentialAuthorizationEpoch: mocks.epoch,
}));

vi.mock('../../../src/addie/admin-status-lookup.js', () => {
  class AAOAdminLookupUnavailableError extends Error {}
  return {
    AAOAdminLookupUnavailableError,
    isAuthenticatedUserAAOAdmin: mocks.isAdmin,
  };
});

import {
  captureAddieMutationAuthority,
  revalidateAddieMutationAuthority,
} from '../../../src/addie/mutation-authority.js';

describe('Addie exact-credential mutation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue('7');
    mocks.isAdmin.mockImplementation(async (principal) =>
      (principal.authWorkosUserId ?? principal.id) === 'credential_admin');
  });

  it.each([
    ['does not inherit canonical privilege', 'canonical_admin', 'credential_member', false],
    ['does not lose authenticated privilege', 'canonical_member', 'credential_admin', true],
  ] as const)('%s', async (_label, canonical, credential, allowed) => {
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: canonical, authWorkosUserId: credential, email: `${credential}@example.test` },
      platformAdminMutationTools: ['resolve_escalation'],
    });

    await expect(revalidateAddieMutationAuthority(snapshot, 'resolve_escalation'))
      .resolves.toEqual(allowed
        ? { allowed: true }
        : { allowed: false, status: 'access_denied' });
    expect(mocks.epoch).toHaveBeenLastCalledWith(credential);
    expect(mocks.isAdmin).toHaveBeenCalledWith({
      id: credential,
      authWorkosUserId: credential,
      email: `${credential}@example.test`,
    });
  });

  it('rejects a stale assembled surface when another request bumps the epoch', async () => {
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical_admin', authWorkosUserId: 'credential_admin' },
      platformAdminMutationTools: ['resolve_escalation'],
    });
    mocks.epoch.mockResolvedValueOnce('8');

    await expect(revalidateAddieMutationAuthority(snapshot, 'resolve_escalation'))
      .resolves.toEqual({ allowed: false, status: 'access_denied' });
    expect(mocks.isAdmin).not.toHaveBeenCalled();
  });

  it('fails retryably when the persisted epoch cannot be read', async () => {
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'credential_admin' },
      platformAdminMutationTools: ['resolve_escalation'],
    });
    mocks.epoch.mockRejectedValueOnce(new Error('replica unavailable'));

    await expect(revalidateAddieMutationAuthority(snapshot, 'resolve_escalation'))
      .resolves.toEqual({ allowed: false, status: 'recoverable_error' });
    expect(mocks.isAdmin).not.toHaveBeenCalled();
  });

  it('still validates the exact epoch for non-platform mutations', async () => {
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical_member', authWorkosUserId: 'credential_member' },
      platformAdminMutationTools: [],
    });

    await expect(revalidateAddieMutationAuthority(snapshot, 'update_member_profile'))
      .resolves.toEqual({ allowed: true });
    expect(mocks.isAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ['forbidden', { allowed: false, status: 'access_denied' }],
    ['unavailable', { allowed: false, status: 'recoverable_error' }],
  ] as const)('revalidates Slack mapping/admin authority as %s', async (decision, expected) => {
    const revalidatePlatformAdmin = vi.fn().mockResolvedValue(decision);
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'credential_admin', authWorkosUserId: 'credential_admin' },
      platformAdminMutationTools: ['resolve_escalation'],
      revalidatePlatformAdmin,
    });

    await expect(revalidateAddieMutationAuthority(snapshot, 'resolve_escalation'))
      .resolves.toEqual(expected);
    expect(revalidatePlatformAdmin).toHaveBeenCalledWith('credential_admin');
    expect(mocks.isAdmin).not.toHaveBeenCalled();
  });
});
