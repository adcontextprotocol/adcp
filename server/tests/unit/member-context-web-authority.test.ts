import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  query: vi.fn(),
  workingGroups: vi.fn(),
  isLeader: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../src/addie/admin-status-lookup.js', async (original) => ({
  ...await original<typeof import('../../src/addie/admin-status-lookup.js')>(),
  isAuthenticatedUserAAOAdmin: mocks.isAdmin,
}));
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ query: mocks.query, getPool: () => ({ query: mocks.query }) }));
vi.mock('../../src/middleware/auth.js', () => ({
  isDevModeEnabled: () => true,
  DEV_USERS: [{ id: 'user_dev_canonical', email: 'canonical@example.test', organizationId: 'org_example' }],
}));
vi.mock('../../src/db/slack-db.js', () => ({ SlackDatabase: class {} }));
vi.mock('../../src/db/member-db.js', () => ({ MemberDatabase: class { async getProfileByOrgId() { return null; } } }));
vi.mock('../../src/db/organization-db.js', () => ({ OrganizationDatabase: class { async getOrganization() { return null; } } }));
vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupsForUser = mocks.workingGroups;
    isLeader = mocks.isLeader;
  },
}));
vi.mock('../../src/db/email-preferences-db.js', () => ({ EmailPreferencesDatabase: class {} }));
vi.mock('../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));
vi.mock('../../src/db/join-request-db.js', () => ({ JoinRequestDatabase: class {} }));
vi.mock('../../src/db/org-knowledge-db.js', () => ({ OrgKnowledgeDatabase: class {} }));
vi.mock('../../src/db/agent-context-db.js', () => ({ AgentContextDatabase: class {} }));
vi.mock('../../src/db/users-db.js', () => ({ UsersDatabase: class { async getUserTimezone() { return null; } } }));
vi.mock('../../src/addie/thread-service.js', () => ({ getThreadService: () => ({ getUserActivityStats: vi.fn().mockResolvedValue({}) }) }));
vi.mock('../../src/slack/client.js', () => ({ resolveSlackUserDisplayName: vi.fn() }));

import { getWebMemberContext, resolveWebMemberAuthority } from '../../src/addie/member-context.js';
import { AAOAdminLookupUnavailableError } from '../../src/addie/admin-status-lookup.js';

describe('web member context authority boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.workingGroups.mockResolvedValue([{ id: 'canonical_group', name: 'Canonical committee', slug: 'canonical' }]);
    mocks.isLeader.mockResolvedValue(true);
    mocks.isAdmin.mockImplementation(async (principal) => principal.id === 'credential_admin');
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM working_group_leaders wgl')) {
        return { rows: params?.[0] === 'credential_leader' ? [{ id: 'credential_group', slug: 'credential' }] : [] };
      }
      if (sql.includes('GROUP BY wg.slug')) {
        return { rows: [{ committee_slug: 'credential', count: '2' }] };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it.each([
    ['credential_admin', true],
    ['credential_member', false],
  ] as const)('uses exact %s for platform content access despite canonical leader/admin state', async (credential, allowed) => {
    const context = await getWebMemberContext('user_dev_canonical', undefined, {
      id: 'user_dev_canonical', authWorkosUserId: credential, email: 'authenticated@example.test',
    });
    expect(mocks.isAdmin).toHaveBeenCalledWith({ id: credential, authWorkosUserId: credential, email: 'authenticated@example.test' });
    expect(context.working_groups?.[0].is_leader).toBe(true);
    expect(context.pending_content?.total).toBe(allowed ? 2 : undefined);
    const leaderLookups = mocks.query.mock.calls.filter(([sql]) => sql.includes('FROM working_group_leaders wgl'));
    expect(leaderLookups.map(([, params]) => params)).toEqual([[credential]]);
  });

  it('retains an authenticated committee leader even when the canonical identity leads nothing', async () => {
    mocks.workingGroups.mockResolvedValue([]);
    const context = await getWebMemberContext('user_dev_canonical', undefined, {
      id: 'user_dev_canonical', authWorkosUserId: 'credential_leader',
    });
    expect(context.pending_content?.total).toBe(2);
    const scopedQuery = mocks.query.mock.calls.find(([sql]) => sql.includes('GROUP BY wg.slug'));
    expect(scopedQuery?.[0]).toContain('p.working_group_id = ANY($1)');
    expect(scopedQuery?.[1]).toEqual([['credential_group']]);
  });

  it('does not expose pending moderation content from a person-state-only preview', async () => {
    const context = await getWebMemberContext('user_dev_canonical');
    expect(context.working_groups?.[0].is_leader).toBe(true);
    expect(context.pending_content).toBeUndefined();
    expect(mocks.isAdmin).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('FROM working_group_leaders wgl'))).toBe(false);
  });

  it('returns an immutable decision and drops caller-supplied admin flags and canonical ids', async () => {
    const authority = await resolveWebMemberAuthority({
      id: 'canonical_admin', authWorkosUserId: 'credential_member', isAAOAdmin: true,
    } as Parameters<typeof resolveWebMemberAuthority>[0]);
    expect(authority).toMatchObject({ authenticatedWorkosUserId: 'credential_member', isAAOAdmin: false });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(mocks.isAdmin).toHaveBeenCalledWith({ id: 'credential_member', authWorkosUserId: 'credential_member', email: undefined });
  });

  it('propagates an unavailable authorization lookup before person-state hydration', async () => {
    mocks.isAdmin.mockRejectedValue(new AAOAdminLookupUnavailableError());
    await expect(getWebMemberContext('user_dev_canonical', undefined, { id: 'credential_member' }))
      .rejects.toBeInstanceOf(AAOAdminLookupUnavailableError);
    expect(mocks.workingGroups).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['', ' credential_member '])('rejects malformed exact credential %j instead of falling back to canonical authority', async (credential) => {
    await expect(resolveWebMemberAuthority({ id: 'canonical_admin', authWorkosUserId: credential }))
      .rejects.toBeInstanceOf(AAOAdminLookupUnavailableError);
    expect(mocks.isAdmin).not.toHaveBeenCalled();
  });
});
