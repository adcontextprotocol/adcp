import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchSlackMessages: vi.fn(),
  getChannelActivity: vi.fn(),
  getAccessiblePrivateChannelIds: vi.fn(),
  findChannelWithAccess: vi.fn(),
}));

vi.mock('../../src/db/addie-db.js', () => ({
  AddieDatabase: class {
    searchSlackMessages = mocks.searchSlackMessages;
    getChannelActivity = mocks.getChannelActivity;
  },
}));

vi.mock('../../src/slack/client.js', () => ({
  getAccessiblePrivateChannelIds: mocks.getAccessiblePrivateChannelIds,
  findChannelWithAccess: mocks.findChannelWithAccess,
}));

import {
  createKnowledgeToolHandlers,
  createSlackKnowledgeRequestTools,
} from '../../src/addie/mcp/knowledge-search.js';

describe('Slack knowledge handler scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchSlackMessages.mockResolvedValue([]);
    mocks.getChannelActivity.mockResolvedValue([]);
    mocks.getAccessiblePrivateChannelIds.mockResolvedValue(['C_ALLOWED']);
    mocks.findChannelWithAccess.mockResolvedValue(null);
  });

  it('treats missing access context as public-only', async () => {
    const handlers = createKnowledgeToolHandlers();
    await handlers.get('search_slack')!({ query: 'roadmap' });
    await handlers.get('get_channel_activity')!({ channel: 'general' });

    expect(mocks.searchSlackMessages).toHaveBeenCalledWith('roadmap', expect.objectContaining({
      accessiblePrivateChannelIds: [],
    }));
    expect(mocks.getChannelActivity).toHaveBeenCalledWith('general', expect.objectContaining({
      accessiblePrivateChannelIds: [],
    }));
    expect(mocks.getAccessiblePrivateChannelIds).not.toHaveBeenCalled();
  });

  it('passes a linked Slack user private-channel allowlist to search and activity', async () => {
    const handlers = createKnowledgeToolHandlers({
      slackAccess: { kind: 'slack-user', slackUserId: 'U_LINKED' },
    });
    await handlers.get('search_slack')!({ query: 'roadmap' });
    await handlers.get('get_channel_activity')!({ channel: 'working-group' });

    expect(mocks.getAccessiblePrivateChannelIds).toHaveBeenCalledWith('U_LINKED');
    expect(mocks.searchSlackMessages).toHaveBeenCalledWith('roadmap', expect.objectContaining({
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    }));
    expect(mocks.getChannelActivity).toHaveBeenCalledWith('working-group', expect.objectContaining({
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    }));
  });

  it('builds both routed definitions and handlers with the same explicit scope', async () => {
    const publicOnly = createSlackKnowledgeRequestTools({ kind: 'public-only' });
    expect(publicOnly.tools.map((tool) => tool.name)).toEqual([
      'search_slack',
      'get_channel_activity',
    ]);
    expect([...publicOnly.handlers.keys()]).toEqual([
      'search_slack',
      'get_channel_activity',
    ]);
    await publicOnly.handlers.get('search_slack')!({ query: 'roadmap' });
    expect(mocks.searchSlackMessages).toHaveBeenLastCalledWith('roadmap', expect.objectContaining({
      accessiblePrivateChannelIds: [],
    }));

    const linked = createSlackKnowledgeRequestTools({
      kind: 'slack-user',
      slackUserId: 'U_LINKED',
    });
    await linked.handlers.get('get_channel_activity')!({ channel: 'working-group' });
    expect(mocks.getChannelActivity).toHaveBeenLastCalledWith('working-group', expect.objectContaining({
      accessiblePrivateChannelIds: ['C_ALLOWED'],
    }));
  });

  it('fails permission lookup errors closed to public-only', async () => {
    mocks.getAccessiblePrivateChannelIds.mockRejectedValue(new Error('permission DB unavailable'));
    const handlers = createKnowledgeToolHandlers({
      slackAccess: { kind: 'slack-user', slackUserId: 'U_LINKED' },
    });

    await handlers.get('search_slack')!({ query: 'roadmap' });
    await handlers.get('get_channel_activity')!({ channel: 'working-group' });

    expect(mocks.searchSlackMessages).toHaveBeenCalledWith('roadmap', expect.objectContaining({
      accessiblePrivateChannelIds: [],
    }));
    expect(mocks.getChannelActivity).toHaveBeenCalledWith('working-group', expect.objectContaining({
      accessiblePrivateChannelIds: [],
    }));
  });

  it('denies an explicitly requested private channel before querying indexed content', async () => {
    mocks.findChannelWithAccess.mockResolvedValue({
      channel: { id: 'C_DENIED', name: 'private-denied', is_private: true },
      hasAccess: false,
      reason: 'not a member',
    });
    const handlers = createKnowledgeToolHandlers({
      slackAccess: { kind: 'slack-user', slackUserId: 'U_LINKED' },
    });

    const searchResult = await handlers.get('search_slack')!({ query: 'roadmap', channel: 'private-denied' });
    const activityResult = await handlers.get('get_channel_activity')!({ channel: 'private-denied' });

    expect(searchResult).toContain('Cannot search #private-denied');
    expect(activityResult).toContain('Cannot access #private-denied');
    expect(mocks.searchSlackMessages).not.toHaveBeenCalled();
    expect(mocks.getChannelActivity).not.toHaveBeenCalled();
  });

  it('formats activity identities and permalinks only from ACL-filtered rows', async () => {
    mocks.getChannelActivity.mockResolvedValue([{
      text: 'Allowed decision',
      channel_name: 'private-allowed',
      username: 'allowed-user',
      permalink: 'https://slack/allowed',
      created_at: new Date('2026-07-30T12:00:00Z'),
    }]);
    const handlers = createKnowledgeToolHandlers({
      slackAccess: { kind: 'slack-user', slackUserId: 'U_LINKED' },
    });

    const result = await handlers.get('get_channel_activity')!({ channel: 'private' });

    expect(result).toContain('@allowed-user');
    expect(result).toContain('https://slack/allowed');
    expect(result).not.toContain('denied-user');
    expect(result).not.toContain('https://slack/denied');
  });
});
