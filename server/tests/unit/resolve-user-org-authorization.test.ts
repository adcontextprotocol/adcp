import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkOS } from '@workos-inc/node';
import type { AuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';

const snapshotMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/user-authorization-snapshot-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/user-authorization-snapshot-db.js')>(),
  loadAuthorizationSnapshot: snapshotMock,
}));
import { evaluateUserOrgRoleAuthorization, resolveUserOrgAuthorization } from '../../src/utils/resolve-user-org-authorization.js';

const ORGANIZATION_ID = 'org_pinnacle';
const AUTHENTICATED_ID = 'user_authenticated';
function snapshot(overrides: Partial<AuthorizationSnapshot> = {}): AuthorizationSnapshot {
  return {
    authenticatedUserId: AUTHENTICATED_ID, canonicalUserId: 'user_canonical',
    identityId: 'identity_linked', selectedOrganizationId: ORGANIZATION_ID, authorizationEpoch: '1',
    credential: { email: 'sam@example.test', firstName: 'Sam', lastName: 'Adeyemi', emailVerified: true },
    credentialGrant: null, ...overrides,
  };
}
function grant(role: 'owner' | 'admin' | 'member' = 'member'): NonNullable<AuthorizationSnapshot['credentialGrant']> {
  return {
    id: 'grant_pinnacle', organizationId: ORGANIZATION_ID, role,
    effectiveFrom: '2026-01-01T00:00:00.000000Z', effectiveUntil: null,
  };
}
function principal(authorizationSnapshot?: AuthorizationSnapshot) {
  return { id: 'user_canonical', authWorkosUserId: AUTHENTICATED_ID, authorizationSnapshot };
}
function workosWithMemberships(data: unknown[] = []): WorkOS {
  return {
    userManagement: { listOrganizationMemberships: vi.fn().mockResolvedValue({ data }) },
  } as unknown as WorkOS;
}
function membership(organizationId = ORGANIZATION_ID, role = 'member', userId = AUTHENTICATED_ID) {
  return { userId, organizationId, status: 'active', role: { slug: role } };
}
const FORBIDDEN = { status: 'forbidden', complete: true, unavailableSources: [] };
const SNAPSHOT_UNAVAILABLE = { status: 'unavailable', complete: false, unavailableSources: ['authorization_snapshot'] };

describe('resolveUserOrgAuthorization', () => {
  beforeEach(() => {
    snapshotMock.mockReset();
    snapshotMock.mockImplementation(async (id: string, org: string | null) => snapshot({
      authenticatedUserId: id, selectedOrganizationId: org,
    }));
  });
  it.each([
    ['secondary credential', 'user_canonical', AUTHENTICATED_ID],
    ['primary credential', AUTHENTICATED_ID, undefined],
  ])('uses exact %s authority independently of canonical attribution', async (_label, id, authWorkosUserId) => {
    const workos = workosWithMemberships([membership()]);
    const result = await resolveUserOrgAuthorization(workos, { id, authWorkosUserId }, ORGANIZATION_ID);
    expect(result).toMatchObject({ status: 'authorized', membership: { source: 'workos' } });
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledExactlyOnceWith({
      userId: AUTHENTICATED_ID, organizationId: ORGANIZATION_ID,
    });
    expect(snapshotMock).toHaveBeenCalledTimes(2);
    expect(snapshotMock).toHaveBeenNthCalledWith(1, AUTHENTICATED_ID, ORGANIZATION_ID);
    expect(snapshotMock).toHaveBeenNthCalledWith(2, AUTHENTICATED_ID, ORGANIZATION_ID);
  });
  it('returns a definitive denial only when both authority sources are available', async () => {
    expect(await resolveUserOrgAuthorization(workosWithMemberships(), principal(), ORGANIZATION_ID)).toEqual(FORBIDDEN);
  });
  it.each(['', '   '])('never chooses an implicit organization for missing selection %j', async (org) => {
    const workos = workosWithMemberships([membership()]);
    expect(await resolveUserOrgAuthorization(workos, principal(), org)).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });
  it.each([
    ['another linked credential', membership(ORGANIZATION_ID, 'owner', 'user_canonical')],
    ['another organization', membership('org_streamhaus', 'owner')],
  ])('does not inherit membership from %s', async (_label, otherMembership) => {
    const workos = workosWithMemberships([otherMembership]);
    expect(await resolveUserOrgAuthorization(workos, principal(), ORGANIZATION_ID)).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: AUTHENTICATED_ID, organizationId: ORGANIZATION_ID,
    });
  });
  it('rejects replaying a selected organization snapshot against another organization', async () => {
    const workos = workosWithMemberships([membership('org_streamhaus')]);
    const result = await resolveUserOrgAuthorization(workos, principal(snapshot()), 'org_streamhaus');
    expect(result).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });
  it('binds an unselected authenticated snapshot to an explicit organization using fresh authority', async () => {
    const result = await resolveUserOrgAuthorization(
      workosWithMemberships([membership('org_streamhaus')]),
      principal(snapshot({ selectedOrganizationId: null })), 'org_streamhaus',
    );
    expect(result).toMatchObject({ status: 'authorized', membership: { organizationId: 'org_streamhaus', source: 'workos' } });
  });
  it('distinguishes snapshot outage from denial without falling back to valid provider membership', async () => {
    snapshotMock.mockRejectedValue(new Error('database unavailable'));
    const workos = workosWithMemberships([membership(ORGANIZATION_ID, 'owner')]);
    const result = await resolveUserOrgAuthorization(workos, principal(), ORGANIZATION_ID);
    expect(result).toEqual(SNAPSHOT_UNAVAILABLE);
    expect(evaluateUserOrgRoleAuthorization(result)).toEqual({ status: 'unavailable', unavailableSources: ['authorization_snapshot'] });
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });
  it('fails unavailable if the post-provider primary revalidation fails', async () => {
    snapshotMock.mockResolvedValueOnce(snapshot({ credentialGrant: grant('owner') }))
      .mockRejectedValueOnce(new Error('database unavailable'));
    const result = await resolveUserOrgAuthorization(workosWithMemberships([membership()]), principal(), ORGANIZATION_ID);
    expect(result).toEqual(SNAPSHOT_UNAVAILABLE);
  });
  it('uses an active exact-credential grant and preserves partial role uncertainty', async () => {
    snapshotMock.mockResolvedValue(snapshot({ credentialGrant: grant() }));
    const workos = workosWithMemberships();
    vi.mocked(workos.userManagement.listOrganizationMemberships).mockRejectedValue(new Error('WorkOS unavailable'));
    const result = await resolveUserOrgAuthorization(workos, principal(), ORGANIZATION_ID);
    expect(result).toMatchObject({
      status: 'authorized', complete: false, unavailableSources: ['workos'],
      membership: { role: 'member', source: 'credential_grant' },
    });
    expect(evaluateUserOrgRoleAuthorization(result, 'member')).toMatchObject({ status: 'authorized' });
    expect(evaluateUserOrgRoleAuthorization(result, 'admin')).toEqual({ status: 'unavailable', unavailableSources: ['workos'] });
  });
  it('returns unavailable without an independent grant when WorkOS cannot answer', async () => {
    expect(await resolveUserOrgAuthorization(null, principal(), ORGANIZATION_ID)).toEqual({
      status: 'unavailable', complete: false, unavailableSources: ['workos'],
    });
  });
  it('definitively denies a complete exact membership below the required role', () => {
    expect(evaluateUserOrgRoleAuthorization({
      status: 'authorized', complete: true, unavailableSources: [],
      membership: { organizationId: ORGANIZATION_ID, role: 'member', source: 'workos' },
    }, 'admin')).toEqual({ status: 'forbidden' });
  });
  it('chooses the highest role while retaining its authority source', async () => {
    snapshotMock.mockResolvedValue(snapshot({ credentialGrant: grant('owner') }));
    const result = await resolveUserOrgAuthorization(workosWithMemberships([membership(ORGANIZATION_ID, 'admin')]), principal(), ORGANIZATION_ID);
    expect(result).toMatchObject({ status: 'authorized', complete: true, membership: { role: 'owner', source: 'credential_grant' } });
  });
  it.each([
    ['epoch advanced', { authorizationEpoch: '2' }],
    ['epoch moved backwards', { authorizationEpoch: '0' }],
    ['canonical identity changed', { canonicalUserId: 'user_new_primary' }],
    ['binding changed without a matching epoch', { identityId: 'identity_new' }],
    ['credential changed', { authenticatedUserId: 'user_other' }],
  ] as const)('rejects replayed request state when %s', async (_case, change) => {
    const workos = workosWithMemberships([membership()]);
    snapshotMock.mockResolvedValue(snapshot(change));
    expect(await resolveUserOrgAuthorization(workos, principal(snapshot()), ORGANIZATION_ID)).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });
  it.each([
    ['revoked', null], ['replaced', { ...grant('owner'), id: 'grant_replacement' }],
  ])('rejects a %s grant in prior request state even when the epoch is unchanged', async (_label, currentGrant) => {
    snapshotMock.mockResolvedValue(snapshot({ credentialGrant: currentGrant }));
    const workos = workosWithMemberships([membership(ORGANIZATION_ID, 'owner')]);
    const result = await resolveUserOrgAuthorization(workos, principal(snapshot({ credentialGrant: grant('owner') })), ORGANIZATION_ID);
    expect(result).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });
  it.each([
    ['identity binding', { canonicalUserId: 'user_new_primary', identityId: 'identity_new', authorizationEpoch: '2' }],
    ['epoch alone', { authorizationEpoch: '2' }],
    ['grant revoked', { credentialGrant: null }],
    ['grant role', { credentialGrant: grant('member') }],
    ['grant replaced', { credentialGrant: { ...grant('owner'), id: 'grant_replacement' } }],
    ['grant end date', { credentialGrant: { ...grant('owner'), effectiveUntil: '2026-09-13T00:00:00.000000Z' } }],
    ['selected organization', { selectedOrganizationId: 'org_streamhaus' }],
  ] as const)('rejects a %s change while a provider decision is in flight', async (_case, change) => {
    const before = snapshot({ credentialGrant: grant('owner') });
    let current = before;
    snapshotMock.mockImplementation(async () => current);
    let finishProvider!: (value: { data: ReturnType<typeof membership>[] }) => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const workos = workosWithMemberships();
    vi.mocked(workos.userManagement.listOrganizationMemberships).mockImplementation(() => {
      providerStarted();
      return new Promise((resolve) => { finishProvider = resolve as typeof finishProvider; });
    });
    const pending = resolveUserOrgAuthorization(workos, principal(before), ORGANIZATION_ID);
    await started;
    current = snapshot({ ...before, ...change });
    finishProvider({ data: [membership(ORGANIZATION_ID, 'owner')] });
    expect(await pending).toEqual(FORBIDDEN);
    expect(snapshotMock).toHaveBeenCalledTimes(2);
  });
  it('rejects a credential deleted during provider authorization', async () => {
    snapshotMock.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(null);
    expect(await resolveUserOrgAuthorization(workosWithMemberships([membership()]), principal(), ORGANIZATION_ID)).toEqual(FORBIDDEN);
  });
  it('checks persisted epoch each turn and rejects replayed prior context', async () => {
    const before = snapshot();
    const workos = workosWithMemberships([membership()]);
    expect(await resolveUserOrgAuthorization(workos, principal(before), ORGANIZATION_ID)).toMatchObject({ status: 'authorized' });
    snapshotMock.mockResolvedValue(snapshot({ authorizationEpoch: '2' }));
    expect(await resolveUserOrgAuthorization(workos, principal(before), ORGANIZATION_ID)).toEqual(FORBIDDEN);
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledTimes(1);
  });
});
