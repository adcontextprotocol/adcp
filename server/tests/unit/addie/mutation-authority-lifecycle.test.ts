import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lifecycle: vi.fn(), loadSnapshot: vi.fn(), sameSnapshot: vi.fn(), committees: vi.fn() }));
vi.mock('../../../src/db/authorization-epoch-db.js', () => ({ readCredentialAuthorizationLifecycle: mocks.lifecycle }));
vi.mock('../../../src/db/user-authorization-snapshot-db.js', () => ({ loadAuthorizationSnapshot: mocks.loadSnapshot, sameAuthorizationSnapshot: mocks.sameSnapshot }));
vi.mock('../../../src/addie/admin-status-lookup.js', () => ({
  AAOAdminLookupUnavailableError: class extends Error {}, isAuthenticatedUserAAOAdmin: vi.fn(),
}));
vi.mock('../../../src/db/working-group-db.js', () => ({ WorkingGroupDatabase: class { getCommitteesLedByUser = mocks.committees; } }));
import { captureAddieMutationAuthority, revalidateAddieMutationAuthority } from '../../../src/addie/mutation-authority.js';
const active = {
  status: 'active' as const, snapshot: {
    workos_user_id: 'credential', email: 'member@example.test', first_name: null, last_name: null,
    identity_id: 'identity', primary_workos_user_id: 'canonical', fingerprint: 'credential:epoch:7',
  },
};
const capture = () => captureAddieMutationAuthority({
  principal: { id: 'canonical', authWorkosUserId: 'credential', email: 'member@example.test' },
  platformAdminMutationTools: [], revalidateCredentialLifecycle: async () => 'authorized',
});
describe('positive lifecycle proof at mutation dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.lifecycle.mockResolvedValue(active); });
  it('captures a confirmed terminal principal as a denial rather than a storage outage', async () => {
    mocks.lifecycle.mockResolvedValue({ status: 'terminal', reason: 'deleted_or_quarantined' });
    const snapshot = await capture();
    expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
  });
  it('denies a removed committee even when another captured committee survives', async () => {
    mocks.committees.mockResolvedValue([{ id: 'committee-a' }, { id: 'committee-b' }]);
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'credential', email: 'member@example.test' }, platformAdminMutationTools: [],
      committeeMutationTools: ['create_event'], revalidateCredentialLifecycle: async () => 'authorized',
    });
    expect(await revalidateAddieMutationAuthority(snapshot, 'create_event')).toEqual({ allowed: true });
    mocks.committees.mockResolvedValue([{ id: 'committee-b' }]);
    expect(await revalidateAddieMutationAuthority(snapshot, 'create_event')).toEqual({ allowed: false, status: 'access_denied' });
    expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: true });
  });
  it('treats a live committee lookup outage as uncertainty', async () => {
    mocks.committees.mockResolvedValue([{ id: 'committee-a' }]);
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'credential', email: 'member@example.test' }, platformAdminMutationTools: [],
      committeeMutationTools: ['schedule_meeting'], revalidateCredentialLifecycle: async () => 'authorized',
    });
    mocks.committees.mockRejectedValue(new Error('Database unavailable'));
    expect(await revalidateAddieMutationAuthority(snapshot, 'schedule_meeting')).toEqual({ allowed: false, status: 'recoverable_error' });
  });
  it.each(['deleted_or_quarantined', 'missing_user', 'missing_binding', 'missing_primary'])(
    'rejects %s even if an epoch or users row survives', async reason => {
      const snapshot = await capture();
      mocks.lifecycle.mockResolvedValue({ status: 'terminal', reason });
      expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
    },
  );
  it.each(['identity_id', 'primary_workos_user_id', 'email', 'fingerprint', 'workos_user_id'] as const)(
    'rejects changes in %s while other lifecycle fields survive', async field => {
      const snapshot = await capture();
      mocks.lifecycle.mockResolvedValue({ ...active, snapshot: { ...active.snapshot, [field]: 'changed' } });
      expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
    },
  );
  it('rejects quarantine committed while the live credential proof is awaiting', async () => {
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'credential', email: 'member@example.test' }, platformAdminMutationTools: [],
      revalidateCredentialLifecycle: async () => { mocks.lifecycle.mockResolvedValue({ status: 'terminal', reason: 'deleted_or_quarantined' }); return 'authorized'; },
    });
    expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
    expect(mocks.lifecycle).toHaveBeenCalledTimes(3);
  });
  it('treats unavailable lifecycle storage as retryable uncertainty', async () => {
    const snapshot = await capture(); mocks.lifecycle.mockResolvedValue({ status: 'unavailable' });
    expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'recoverable_error' });
  });
  it('rejects stale request attribution or binding even when the capture observes a new valid lifecycle', async () => {
    const requestAuthorization = { selectedOrganizationId: null } as never;
    const snapshot = await captureAddieMutationAuthority({
      principal: { id: 'canonical', authWorkosUserId: 'credential', email: 'member@example.test', authorizationSnapshot: requestAuthorization },
      platformAdminMutationTools: [], revalidateCredentialLifecycle: async () => 'authorized',
    });
    mocks.loadSnapshot.mockResolvedValue({ bindingVersion: 'new' }); mocks.sameSnapshot.mockReturnValue(false);
    expect(await revalidateAddieMutationAuthority(snapshot, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
    expect(mocks.loadSnapshot).toHaveBeenCalledWith('credential', null);
  });
});
