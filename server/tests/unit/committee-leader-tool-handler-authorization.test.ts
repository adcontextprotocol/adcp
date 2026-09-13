import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBySlackUserId: vi.fn(),
  getByWorkosUserId: vi.fn(),
  resolvePrincipal: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getBySlackUserId = mocks.getBySlackUserId;
    getByWorkosUserId = mocks.getByWorkosUserId;
  },
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {},
}));

vi.mock('../../src/services/committee-leader-mutation.js', () => ({
  resolveCommitteeLeaderPrincipal: mocks.resolvePrincipal,
  mutateCommitteeLeader: mocks.mutate,
}));

vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateWebAdminStatusCache: mocks.invalidate,
}));

vi.mock('../../src/slack/client.js', () => ({ inviteToChannel: vi.fn() }));

import { createCommitteeLeaderToolHandlers } from '../../src/addie/mcp/committee-leader-tools.js';

function snapshot(authenticatedUserId: string, canonicalUserId: string) {
  return Object.freeze({
    authenticatedUserId,
    canonicalUserId,
    identityId: `identity_${canonicalUserId}`,
    selectedOrganizationId: null,
    authorizationEpoch: '11',
    credential: Object.freeze({ email: null, emailVerified: true, firstName: null, lastName: null }),
    credentialGrant: null,
  });
}

describe('committee leader Slack mutation handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBySlackUserId.mockResolvedValue({
      slack_user_id: 'U_AUTHENTICATED',
      workos_user_id: 'credential_exact_leader',
      mapping_status: 'mapped',
      slack_is_deleted: false,
      slack_is_bot: false,
    });
    mocks.resolvePrincipal.mockResolvedValue({
      status: 'resolved',
      snapshot: snapshot('credential_exact_leader', 'credential_canonical_nonleader'),
    });
    mocks.mutate.mockResolvedValue({
      status: 'mutated', action: 'added', committeeId: 'committee-id',
      committeeName: 'Creative working group', committeeType: 'working_group',
      slackChannelId: null, targetWorkosUserId: 'target-user',
    });
  });

  it('resolves the signed Slack user to an immutable exact credential instead of MemberContext', async () => {
    const handlers = createCommitteeLeaderToolHandlers(
      { workos_user: { workos_user_id: 'credential_canonical_nonleader' } } as any,
      'U_AUTHENTICATED',
      { surface: 'slack' },
    );
    const response = await handlers.get('add_committee_co_leader')!({
      organization_id: 'org_selected',
      committee_slug: 'creative-working-group',
      user_id: 'target-user',
    });

    expect(response).toContain('Successfully added');
    expect(mocks.resolvePrincipal).toHaveBeenCalledWith('credential_exact_leader');
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({
      selectedOrganizationId: 'org_selected',
      surface: 'slack',
      slackActorUserId: 'U_AUTHENTICATED',
      principal: expect.objectContaining({
        authenticatedUserId: 'credential_exact_leader',
        canonicalUserId: 'credential_canonical_nonleader',
      }),
    }));
  });

  it('distinguishes unavailable authority from a confirmed exact-credential denial', async () => {
    const handler = createCommitteeLeaderToolHandlers(null, 'U_AUTHENTICATED', { surface: 'slack' })
      .get('remove_committee_co_leader')!;

    mocks.resolvePrincipal.mockResolvedValueOnce({ status: 'unavailable', source: 'database' });
    expect(await handler({
      organization_id: 'org_selected', committee_slug: 'creative-working-group', user_id: 'target-user',
    })).toContain('temporarily unavailable');

    mocks.resolvePrincipal.mockResolvedValueOnce({ status: 'forbidden', reason: 'credential_revoked' });
    expect(await handler({
      organization_id: 'org_selected', committee_slug: 'creative-working-group', user_id: 'target-user',
    })).toContain('not authorized');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('rejects a missing organization before resolving or mutating authority', async () => {
    const handler = createCommitteeLeaderToolHandlers(null, 'U_AUTHENTICATED', { surface: 'slack' })
      .get('add_committee_co_leader')!;
    expect(await handler({ committee_slug: 'creative-working-group', user_id: 'target-user' }))
      .toContain('explicitly select an organization_id');
    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ['unmapped status', { mapping_status: 'unmapped' }],
    ['deleted actor', { slack_is_deleted: true }],
    ['bot actor', { slack_is_bot: true }],
    ['mapped-without-credential inconsistency', { workos_user_id: null }],
  ])('rejects a %s before snapshot resolution', async (_label, override) => {
    mocks.getBySlackUserId.mockResolvedValueOnce({
      slack_user_id: 'U_AUTHENTICATED',
      workos_user_id: 'credential_exact_leader',
      mapping_status: 'mapped',
      slack_is_deleted: false,
      slack_is_bot: false,
      ...override,
    });
    const handler = createCommitteeLeaderToolHandlers(
      null,
      'U_AUTHENTICATED',
      { surface: 'slack' },
    ).get('add_committee_co_leader')!;

    expect(await handler({
      organization_id: 'org_selected',
      committee_slug: 'creative-working-group',
      user_id: 'target-user',
    })).toContain('not authorized');
    expect(mocks.resolvePrincipal).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
