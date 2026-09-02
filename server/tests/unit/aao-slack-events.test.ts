import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBySlackUserId: vi.fn(),
  recordActivity: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getBySlackUserId = (...args: unknown[]) => mocks.getBySlackUserId(...args);
    recordActivity = (...args: unknown[]) => mocks.recordActivity(...args);
  },
}));
vi.mock('../../src/db/addie-db.js', () => ({ AddieDatabase: class {} }));
vi.mock('../../src/db/working-group-db.js', () => ({ WorkingGroupDatabase: class {} }));
vi.mock('../../src/db/client.js', () => ({ getPool: vi.fn() }));
vi.mock('../../src/slack/client.js', () => ({ getSlackUser: vi.fn(), getChannelInfo: vi.fn() }));
vi.mock('../../src/slack/sync.js', () => ({ syncUserToChaptersFromSlackChannels: vi.fn() }));
vi.mock('../../src/cache/unified-users.js', () => ({ invalidateUnifiedUsersCache: vi.fn() }));
vi.mock('../../src/addie/index.js', () => ({ invalidateMemberContextCache: vi.fn() }));
vi.mock('../../src/addie/mcp/admin-tools.js', () => ({
  invalidateAdminStatusCache: vi.fn(),
  invalidateWebAdminStatusCache: vi.fn(),
}));
vi.mock('../../src/services/prospect-triage.js', () => ({ triageAndCreateProspect: vi.fn() }));
vi.mock('../../src/notifications/welcome-social-posts.js', () => ({ sendWelcomeSocialPosts: vi.fn() }));
vi.mock('../../src/notifications/marketing-optin-dm.js', () => ({ sendMarketingOptInDM: vi.fn() }));

import { handleMessage } from '../../src/slack/events.js';

describe('AAO Slack message activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBySlackUserId.mockResolvedValue(null);
    mocks.recordActivity.mockResolvedValue(undefined);
  });

  it('continues recording direct-message activity without dispatching Addie', async () => {
    await handleMessage({
      type: 'message',
      user: 'U_MEMBER',
      channel: 'D_MEMBER',
      channel_type: 'im',
      ts: '1700000000.000001',
      text: 'hello',
    });

    expect(mocks.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      slack_user_id: 'U_MEMBER',
      activity_type: 'message',
      channel_id: 'D_MEMBER',
      metadata: expect.objectContaining({ channel_type: 'im', message_length: 5 }),
    }));
  });
});
