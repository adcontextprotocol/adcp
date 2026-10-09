import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberContext } from '../../src/addie/member-context.js';

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  slackAdmin: vi.fn(),
  ledGroups: vi.fn(),
  group: vi.fn(),
  leader: vi.fn(),
  scheduleMeeting: vi.fn(),
}));

vi.mock('../../src/addie/admin-status-lookup.js', async (original) => ({
  ...await original<typeof import('../../src/addie/admin-status-lookup.js')>(),
  isAuthenticatedUserAAOAdmin: mocks.admin,
}));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ isSlackUserAAOAdmin: mocks.slackAdmin }));
vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    getCommitteesLedByUser = mocks.ledGroups;
    getWorkingGroupBySlug = mocks.group;
    isLeader = mocks.leader;
  },
}));
vi.mock('../../src/db/meetings-db.js', () => ({ MeetingsDatabase: class {} }));
vi.mock('../../src/services/meeting-service.js', () => ({ scheduleMeeting: mocks.scheduleMeeting }));
vi.mock('../../src/integrations/zoom.js', () => ({}));
vi.mock('../../src/integrations/google-calendar.js', () => ({}));

import { createMeetingToolHandlers } from '../../src/addie/mcp/meeting-tools.js';
import { AAOAdminLookupUnavailableError } from '../../src/addie/admin-status-lookup.js';

function memberContext(userId: string, role = 'member'): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    workos_user: { workos_user_id: userId, email: 'canonical@example.test' },
    org_membership: { role },
  } as MemberContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockImplementation(async (principal) => (principal.authWorkosUserId ?? principal.id) === 'credential_admin');
  mocks.slackAdmin.mockResolvedValue(true);
  mocks.ledGroups.mockResolvedValue([]);
  mocks.group.mockResolvedValue({ id: 'wg_target', name: 'Target committee' });
  mocks.leader.mockResolvedValue(false);
});

describe('meeting tool authenticated administrator precheck', () => {
  it('lets an authenticated admin linked to an ordinary canonical member reach scheduling', async () => {
    const principal = { id: 'canonical_member', authWorkosUserId: 'credential_admin' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({})).toContain('No working group specified');
    expect(mocks.admin).toHaveBeenCalledWith(principal);
    expect(mocks.ledGroups).not.toHaveBeenCalled();
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('does not inherit a canonical admin or linked Slack admin grant', async () => {
    const principal = { id: 'canonical_admin', authWorkosUserId: 'credential_member' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id, 'admin'), 'U_LINKED_ADMIN', undefined, principal).get('schedule_meeting')!;

    expect(await schedule({})).toContain('You need to be an admin or committee leader');
    expect(mocks.admin).toHaveBeenCalledWith(principal);
    expect(mocks.ledGroups).toHaveBeenCalledWith('credential_member');
    expect(mocks.slackAdmin).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('does not grant platform meeting access from organization ownership', async () => {
    const principal = { id: 'credential_owner' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id, 'owner'), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({})).toContain('You need to be an admin or committee leader');
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('propagates an unavailable administrator lookup before any action', async () => {
    const error = new AAOAdminLookupUnavailableError();
    mocks.admin.mockRejectedValueOnce(error);
    const schedule = createMeetingToolHandlers(memberContext('canonical_admin', 'admin'), undefined, undefined, {
      id: 'canonical_admin', authWorkosUserId: 'credential_member',
    }).get('schedule_meeting')!;

    await expect(schedule({ working_group_slug: 'target' })).rejects.toBe(error);
    expect(mocks.ledGroups).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('lets an actual committee leader enter scheduling without organization admin status', async () => {
    mocks.ledGroups.mockResolvedValueOnce([{ id: 'wg_led' }]);
    const principal = { id: 'canonical_member', authWorkosUserId: 'credential_leader' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({})).toContain('No working group specified');
    expect(mocks.ledGroups).toHaveBeenCalledWith('credential_leader');
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('keeps the target committee leader check after the precheck', async () => {
    mocks.ledGroups.mockResolvedValueOnce([{ id: 'wg_other' }]);
    const principal = { id: 'credential_leader' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({ working_group_slug: 'target' })).toContain('You can only schedule meetings for committees you lead');
    expect(mocks.leader).toHaveBeenCalledWith('wg_target', principal.id);
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('does not inherit target committee leadership from a linked canonical leader', async () => {
    mocks.ledGroups.mockResolvedValueOnce([{ id: 'wg_other' }]);
    mocks.leader.mockImplementation(async (_group, userId) => userId === 'canonical_target_leader');
    const principal = { id: 'canonical_target_leader', authWorkosUserId: 'credential_other_leader' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({ working_group_slug: 'target' })).toContain('You can only schedule meetings for committees you lead');
    expect(mocks.leader).toHaveBeenCalledWith('wg_target', 'credential_other_leader');
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('retains target committee leadership when linked to an ordinary canonical member', async () => {
    mocks.ledGroups.mockResolvedValueOnce([{ id: 'wg_target' }]);
    mocks.leader.mockImplementation(async (_group, userId) => userId === 'credential_target_leader');
    const principal = { id: 'canonical_member', authWorkosUserId: 'credential_target_leader' };
    const schedule = createMeetingToolHandlers(memberContext(principal.id), undefined, undefined, principal).get('schedule_meeting')!;

    expect(await schedule({ working_group_slug: 'target', start_time: 'invalid' })).toContain('Invalid start_time');
    expect(mocks.leader).toHaveBeenCalledWith('wg_target', 'credential_target_leader');
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });

  it('preserves the Slack administrator path when no web principal is supplied', async () => {
    const schedule = createMeetingToolHandlers(memberContext('user_slack'), 'U_ADMIN').get('schedule_meeting')!;

    expect(await schedule({})).toContain('No working group specified');
    expect(mocks.slackAdmin).toHaveBeenCalledWith('U_ADMIN');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.scheduleMeeting).not.toHaveBeenCalled();
  });
});
