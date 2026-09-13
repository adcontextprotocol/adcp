import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  epoch: vi.fn(),
  isAdmin: vi.fn(),
  orgResolve: vi.fn(),
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

vi.mock('../../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: () => ({ userManagement: {} }),
}));

vi.mock('../../../src/utils/resolve-user-org-authorization.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/utils/resolve-user-org-authorization.js')>(),
  resolveUserOrgAuthorization: mocks.orgResolve,
}));

import {
  captureAddieMutationAuthority,
  revalidateExactOrganizationAuthority,
  revalidateAddieMutationAuthority,
} from '../../../src/addie/mutation-authority.js';
import { createAddieToolExecutor } from '../../../src/addie/model-providers/tool-orchestration.js';
import type { AddieTool } from '../../../src/addie/types.js';

const organizationMutationTool: AddieTool = {
  name: 'update_organization',
  description: 'Update organization',
  input_schema: { type: 'object', properties: {} },
};

describe('Addie exact-credential mutation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue('7');
    mocks.isAdmin.mockImplementation(async (principal) =>
      (principal.authWorkosUserId ?? principal.id) === 'credential_admin');
    mocks.orgResolve.mockReset();
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

  it.each([
    ['live sufficient role', {
      status: 'authorized',
      membership: { organizationId: 'org_selected', role: 'admin', source: 'workos' },
      complete: true,
      unavailableSources: [],
    }, 'authorized'],
    ['live role downgrade', {
      status: 'authorized',
      membership: { organizationId: 'org_selected', role: 'member', source: 'workos' },
      complete: true,
      unavailableSources: [],
    }, 'forbidden'],
    ['revoked or expired grant', {
      status: 'forbidden', complete: true, unavailableSources: [],
    }, 'forbidden'],
    ['WorkOS outage despite a local grant', {
      status: 'authorized',
      membership: { organizationId: 'org_selected', role: 'admin', source: 'credential_grant' },
      complete: false,
      unavailableSources: ['workos'],
    }, 'unavailable'],
    ['authority-store outage', {
      status: 'unavailable', complete: false, unavailableSources: ['credential_grant'],
    }, 'unavailable'],
  ] as const)('maps %s to a tri-state exact organization proof', async (_label, resolution, expected) => {
    mocks.orgResolve.mockResolvedValue(resolution);
    await expect(revalidateExactOrganizationAuthority(
      'credential_b',
      'org_selected',
      'admin',
    )).resolves.toBe(expected);
    expect(mocks.orgResolve).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'credential_b', authWorkosUserId: 'credential_b' },
      'org_selected',
    );
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

  it.each([
    ['forbidden', { allowed: false, status: 'access_denied' }],
    ['unavailable', { allowed: false, status: 'recoverable_error' }],
  ] as const)('re-proves selected-organization authority as %s immediately before dispatch', async (decision, expected) => {
    const revalidateOrganization = vi.fn().mockResolvedValue(decision);
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical_a', authWorkosUserId: 'credential_b' },
      platformAdminMutationTools: [],
      organizationAuthority: {
        organizationId: 'org_selected',
        minimumRole: 'admin',
        revalidate: revalidateOrganization,
      },
    });

    await expect(revalidateAddieMutationAuthority(snapshot, 'update_organization'))
      .resolves.toEqual(expected);
    expect(revalidateOrganization).toHaveBeenCalledWith(
      'credential_b',
      'org_selected',
      'admin',
    );
  });

  it('does not broaden an assembled member surface after a linked credential is promoted', async () => {
    const revalidateOrganization = vi.fn().mockResolvedValue('authorized');
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical_a', authWorkosUserId: 'credential_b' },
      platformAdminMutationTools: [],
      organizationAuthority: {
        organizationId: 'org_selected',
        minimumRole: 'member',
        revalidate: revalidateOrganization,
      },
    });

    await expect(revalidateAddieMutationAuthority(snapshot, 'update_member_profile'))
      .resolves.toEqual({ allowed: true });
    expect(revalidateOrganization).toHaveBeenCalledWith('credential_b', 'org_selected', 'member');
  });

  it.each([
    ['membership removal', 'forbidden', 'access_denied'],
    ['role downgrade', 'forbidden', 'access_denied'],
    ['provider outage', 'unavailable', 'recoverable_error'],
  ] as const)('blocks %s committed after reservation and before handler dispatch', async (_label, postReservation, status) => {
    const decisions: Array<'authorized' | 'forbidden' | 'unavailable'> = ['authorized', postReservation];
    const revalidateOrganization = vi.fn()
      .mockImplementation(async () => decisions.shift() ?? postReservation);
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical_a', authWorkosUserId: 'credential_b' },
      platformAdminMutationTools: [],
      organizationAuthority: {
        organizationId: 'org_selected',
        minimumRole: 'admin',
        revalidate: revalidateOrganization,
      },
    });
    const handler = vi.fn();
    const reserveSideEffect = vi.fn();
    const execute = createAddieToolExecutor(
      [organizationMutationTool],
      new Map([[organizationMutationTool.name, handler]]),
      {
        executionMode: 'production',
        policy: () => ({ allowed: true }),
        reserveSideEffect,
        revalidateSideEffectAuthority: ({ toolName }) =>
          revalidateAddieMutationAuthority(snapshot, toolName),
      },
    );

    const result = await execute({
      type: 'tool_call', id: 'org-call', name: organizationMutationTool.name, input: {},
    }, 1);

    expect(reserveSideEffect).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(result.execution).toMatchObject({
      dispatch_status: 'not_dispatched',
      normalized_result: { status },
    });
    expect(revalidateOrganization).toHaveBeenCalledTimes(2);
  });
});
