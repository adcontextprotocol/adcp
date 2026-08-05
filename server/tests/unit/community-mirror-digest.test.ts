import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listProposals: vi.fn(),
  getAdminChannel: vi.fn(),
  sendChannelMessage: vi.fn(),
}));

vi.mock('../../src/db/community-mirror-db.js', () => ({
  CommunityMirrorDatabase: class {
    listProposals = mocks.listProposals;
  },
}));
vi.mock('../../src/db/system-settings-db.js', () => ({ getAdminChannel: mocks.getAdminChannel }));
vi.mock('../../src/slack/client.js', () => ({ sendChannelMessage: mocks.sendChannelMessage }));

import { runCommunityMirrorDigestJob } from '../../src/addie/jobs/community-mirror-digest.js';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const proposal = (platform: string, hours: number) => ({ platform, proposed_at: hoursAgo(hours) });

describe('community-mirror-digest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendChannelMessage.mockResolvedValue({ ok: true });
  });

  it('does nothing when no proposals are pending', async () => {
    mocks.listProposals.mockResolvedValue({ proposals: [], total: 0 });
    await expect(runCommunityMirrorDigestJob()).resolves.toEqual({
      pendingCount: 0, staleCount: 0, posted: false,
    });
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('does not post when pending proposals are fresh', async () => {
    mocks.listProposals.mockResolvedValue({ proposals: [proposal('acme_ads', 2)], total: 1 });
    await expect(runCommunityMirrorDigestJob()).resolves.toEqual({
      pendingCount: 1, staleCount: 0, posted: false,
    });
  });

  it('posts stale proposals with a link to the review queue', async () => {
    mocks.listProposals.mockResolvedValue({
      proposals: [proposal('acme_ads', 48), proposal('pinnacle_audio', 3)],
      total: 2,
    });
    mocks.getAdminChannel.mockResolvedValue({ channel_id: 'C123' });

    await expect(runCommunityMirrorDigestJob()).resolves.toEqual({
      pendingCount: 2, staleCount: 1, posted: true,
    });
    const [channelId, message] = mocks.sendChannelMessage.mock.calls[0];
    expect(channelId).toBe('C123');
    expect(message.blocks[0].text.text).toContain('acme_ads');
    expect(message.blocks[0].text.text).not.toContain('pinnacle_audio');
    expect(message.blocks[0].text.text).toContain('/admin/community-mirrors');
  });
});
