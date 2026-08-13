import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGroup: vi.fn(),
  getMembership: vi.fn(),
  addMembership: vi.fn(),
  getGroupsForUser: vi.fn(),
  hasActiveMembership: vi.fn(),
  getSeatType: vi.fn(),
  query: vi.fn(),
  poolQuery: vi.fn(),
  awardPoints: vi.fn(),
  checkAndAwardBadges: vi.fn(),
  invalidateMemberContext: vi.fn(),
  invalidateAdminStatus: vi.fn(),
  notifyUser: vi.fn(),
  inviteToChannel: vi.fn(),
  sendWelcome: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getWorkingGroupBySlug = mocks.getGroup;
    getMembership = mocks.getMembership;
    addMembership = mocks.addMembership;
    getWorkingGroupsForUser = mocks.getGroupsForUser;
  },
}));

vi.mock('../../src/services/active-membership-service.js', () => ({
  hasActiveMembershipForUser: mocks.hasActiveMembership,
}));

vi.mock('../../src/db/organization-db.js', () => ({ getUserSeatType: mocks.getSeatType }));
vi.mock('../../src/db/community-db.js', () => ({
  CommunityDatabase: class {
    awardPoints = mocks.awardPoints;
    checkAndAwardBadges = mocks.checkAndAwardBadges;
  },
}));
vi.mock('../../src/db/slack-db.js', () => ({ SlackDatabase: class {} }));
vi.mock('../../src/addie/member-context-cache.js', () => ({ invalidateMemberContextCache: mocks.invalidateMemberContext }));
vi.mock('../../src/addie/admin-status-cache.js', () => ({ invalidateWebAdminStatusCache: mocks.invalidateAdminStatus }));
vi.mock('../../src/notifications/notification-service.js', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('../../src/slack/client.js', () => ({ inviteToChannel: mocks.inviteToChannel }));
vi.mock('../../src/addie/services/wg-welcome.js', () => ({ sendWgWelcomeMessage: mocks.sendWelcome }));
vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({
    userManagement: { listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }) },
    organizations: { getOrganization: vi.fn() },
  }),
}));

import {
  expressCommitteeInterest,
  joinWorkingGroup,
  MASTERMIND_COUNCIL_MEMBERSHIP_NOTICE,
} from '../../src/services/working-group-membership-service.js';

const user = { id: 'user_1', email: 'person@example.test', firstName: 'Test', lastName: 'Person' };
const council = {
  id: 'council_growth',
  slug: 'growth',
  name: 'Growth Council',
  status: 'active',
  committee_type: 'council',
  is_private: false,
  leaders: null,
  slack_channel_id: null,
};
const workingGroup = { ...council, id: 'wg_measurement', slug: 'measurement', name: 'Measurement', committee_type: 'working_group' };

describe('Mastermind Council join membership boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGroup.mockResolvedValue(council);
    mocks.getMembership.mockResolvedValue(null);
    mocks.addMembership.mockResolvedValue({ working_group_id: council.id, workos_user_id: user.id, status: 'active' });
    mocks.hasActiveMembership.mockResolvedValue(false);
    mocks.getSeatType.mockResolvedValue('community_only');
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.awardPoints.mockResolvedValue(undefined);
    mocks.checkAndAwardBadges.mockResolvedValue(undefined);
    mocks.sendWelcome.mockResolvedValue(undefined);
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('denies a council join with the exact notice before any membership write or side effect', async () => {
    await expect(joinWorkingGroup({ user, slug: council.slug })).rejects.toMatchObject({
      code: 'council_membership_required',
      message: MASTERMIND_COUNCIL_MEMBERSHIP_NOTICE,
    });

    expect(mocks.getMembership).not.toHaveBeenCalled();
    expect(mocks.addMembership).not.toHaveBeenCalled();
    expect(mocks.invalidateMemberContext).not.toHaveBeenCalled();
    expect(mocks.invalidateAdminStatus).not.toHaveBeenCalled();
    expect(mocks.awardPoints).not.toHaveBeenCalled();
    expect(mocks.checkAndAwardBadges).not.toHaveBeenCalled();
    expect(mocks.notifyUser).not.toHaveBeenCalled();
    expect(mocks.inviteToChannel).not.toHaveBeenCalled();
    expect(mocks.sendWelcome).not.toHaveBeenCalled();
  });

  it('allows an eligible Explorer council member without applying contributor-seat rules', async () => {
    mocks.hasActiveMembership.mockResolvedValue(true);

    await expect(joinWorkingGroup({ user, slug: council.slug })).resolves.toMatchObject({
      groupId: council.id,
      groupSlug: council.slug,
    });

    expect(mocks.getSeatType).not.toHaveBeenCalled();
    expect(mocks.addMembership).toHaveBeenCalledOnce();
    expect(mocks.sendWelcome).toHaveBeenCalledOnce();
  });

  it('allows authenticated AgenticAdvertising.org staff without a paid subscription row', async () => {
    const staffUser = { ...user, email: 'Mary@AgenticAdvertising.org' };

    await expect(joinWorkingGroup({ user: staffUser, slug: council.slug })).resolves.toMatchObject({
      groupId: council.id,
      groupSlug: council.slug,
    });

    expect(mocks.hasActiveMembership).not.toHaveBeenCalled();
    expect(mocks.addMembership).toHaveBeenCalledOnce();
  });

  it.each([
    'mary@notagenticadvertising.org',
    'mary@agenticadvertising.org.evil.test',
    'mary@updates.agenticadvertising.org',
  ])('does not treat the non-staff domain in %s as staff', async (email) => {
    const lookalikeUser = { ...user, email };

    await expect(joinWorkingGroup({ user: lookalikeUser, slug: council.slug })).rejects.toMatchObject({
      code: 'council_membership_required',
    });

    expect(mocks.hasActiveMembership).toHaveBeenCalledWith(lookalikeUser.id);
    expect(mocks.addMembership).not.toHaveBeenCalled();
  });

  it('leaves non-council contributor-seat behavior unchanged', async () => {
    mocks.getGroup.mockResolvedValue(workingGroup);

    await expect(joinWorkingGroup({ user, slug: workingGroup.slug })).rejects.toMatchObject({
      code: 'community_only_seat_blocked',
    });

    expect(mocks.hasActiveMembership).not.toHaveBeenCalled();
    expect(mocks.getSeatType).toHaveBeenCalledWith(user.id);
    expect(mocks.addMembership).not.toHaveBeenCalled();
  });

  it('leaves the pre-launch council interest funnel ungated', async () => {
    await expect(expressCommitteeInterest({ user, slug: council.slug })).resolves.toMatchObject({
      groupId: council.id,
      interestLevel: 'participant',
    });

    expect(mocks.hasActiveMembership).not.toHaveBeenCalled();
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO committee_interest'),
      expect.any(Array),
    );
  });
});
