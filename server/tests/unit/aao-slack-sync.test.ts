import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserChannels: vi.fn(),
  isSlackConfigured: vi.fn(),
  getBySlackUserId: vi.fn(),
  listWorkingGroupsWithSlackChannel: vi.fn(),
  isMember: vi.fn(),
  addMembershipWithInterest: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/slack/client.js', () => ({
  getSlackUsers: vi.fn(),
  getChannelMembers: vi.fn(),
  getUserChannels: mocks.getUserChannels,
  isSlackConfigured: mocks.isSlackConfigured,
}));
vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getBySlackUserId = mocks.getBySlackUserId;
    markSlackUserDeleted = vi.fn();
  },
}));
vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class {
    listWorkingGroupsWithSlackChannel = mocks.listWorkingGroupsWithSlackChannel;
    isMember = mocks.isMember;
    addMembershipWithInterest = mocks.addMembershipWithInterest;
  },
}));
vi.mock('../../src/cache/unified-users.js', () => ({ invalidateUnifiedUsersCache: vi.fn() }));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: vi.fn() }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({ invalidateAdminStatusCache: vi.fn(), invalidateWebAdminStatusCache: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({ getPool: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({ getWorkos: vi.fn() }));
vi.mock('../../src/utils/email-domain.js', () => ({ isFreeEmailDomain: vi.fn() }));

import { syncUserToChaptersFromSlackChannels } from '../../src/slack/sync.js';

describe('AAO site-admin Slack channel synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSlackConfigured.mockReturnValue(true);
    mocks.getUserChannels.mockResolvedValue(['C_AAO_ADMIN']);
    mocks.getBySlackUserId.mockResolvedValue({ slack_email: 'target@example.test' });
    mocks.listWorkingGroupsWithSlackChannel.mockResolvedValue([{
      id: 'wg_aao_admin',
      slug: 'aao-admin',
      name: 'AAO Admin',
      slack_channel_id: 'C_AAO_ADMIN',
      // Deliberately false: the slug guard must not depend on private config.
      is_private: false,
      committee_type: 'working_group',
    }]);
  });

  it('does not grant AAO site-admin membership during channel discovery', async () => {
    const result = await syncUserToChaptersFromSlackChannels('user_target', 'U_TARGET');

    expect(result.chapters_joined).toBe(0);
    expect(mocks.isMember).not.toHaveBeenCalled();
    expect(mocks.addMembershipWithInterest).not.toHaveBeenCalled();
  });
});
