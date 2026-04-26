import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted, so shared spies must be created via vi.hoisted.
const mocks = vi.hoisted(() => ({
  getPendingLogos: vi.fn(),
  getAdminChannel: vi.fn(),
  sendChannelMessage: vi.fn(),
}));

vi.mock('../../src/db/brand-logo-db.js', () => ({
  BrandLogoDatabase: class {
    getPendingLogos = mocks.getPendingLogos;
  },
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getAdminChannel: mocks.getAdminChannel,
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: mocks.sendChannelMessage,
}));

import { runBrandLogoDigestJob } from '../../src/addie/jobs/brand-logo-digest.js';

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function makeLogo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'logo-' + Math.random().toString(36).slice(2, 8),
    domain: 'acme.com',
    brand_name: 'Acme',
    uploaded_by_email: 'jane@acme.com',
    created_at: HOURS_AGO(48),
    ...overrides,
  };
}

describe('brand-logo-digest', () => {
  beforeEach(() => {
    mocks.getPendingLogos.mockReset();
    mocks.getAdminChannel.mockReset();
    mocks.sendChannelMessage.mockReset();
    mocks.sendChannelMessage.mockResolvedValue({ ok: true });
  });

  it('does nothing when the queue is empty', async () => {
    mocks.getPendingLogos.mockResolvedValue([]);
    const result = await runBrandLogoDigestJob();
    expect(result).toEqual({ pendingCount: 0, staleCount: 0, posted: false });
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('does not post when every pending logo is younger than 12 hours', async () => {
    mocks.getPendingLogos.mockResolvedValue([
      makeLogo({ created_at: HOURS_AGO(2) }),
      makeLogo({ created_at: HOURS_AGO(6) }),
    ]);
    const result = await runBrandLogoDigestJob();
    expect(result.pendingCount).toBe(2);
    expect(result.staleCount).toBe(0);
    expect(result.posted).toBe(false);
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('skips posting if the admin channel is not configured', async () => {
    mocks.getPendingLogos.mockResolvedValue([makeLogo({ created_at: HOURS_AGO(48) })]);
    mocks.getAdminChannel.mockResolvedValue({ channel_id: null, channel_name: null });
    const result = await runBrandLogoDigestJob();
    expect(result.staleCount).toBe(1);
    expect(result.posted).toBe(false);
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('posts a digest when stale items exist and the admin channel is configured', async () => {
    mocks.getPendingLogos.mockResolvedValue([
      makeLogo({ domain: 'thehook.es', brand_name: 'The Hook', uploaded_by_email: 'felipe@thehook.es', created_at: HOURS_AGO(72) }),
      makeLogo({ domain: 'kyber1.com', brand_name: 'Kyber1', uploaded_by_email: 'philippe@kyber1.com', created_at: HOURS_AGO(36) }),
      makeLogo({ created_at: HOURS_AGO(2) }), // fresh, excluded from stale count
    ]);
    mocks.getAdminChannel.mockResolvedValue({ channel_id: 'C123', channel_name: 'aao-admin' });

    const result = await runBrandLogoDigestJob();

    expect(result.pendingCount).toBe(3);
    expect(result.staleCount).toBe(2);
    expect(result.posted).toBe(true);
    expect(mocks.sendChannelMessage).toHaveBeenCalledTimes(1);

    const [channelId, message] = mocks.sendChannelMessage.mock.calls[0];
    expect(channelId).toBe('C123');
    expect(message.text).toBe('2 brand logos pending review');
    const body = (message.blocks[0].text.text as string);
    expect(body).toContain('thehook.es');
    expect(body).toContain('felipe@thehook.es');
    expect(body).toContain('kyber1.com');
    expect(body).toContain('Open the moderation queue');
    // Fresh item should not appear
    expect(body).not.toMatch(/2h ago|3h ago|6h ago/);
  });

  it('caps the visible list and adds an overflow marker', async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) =>
      makeLogo({ domain: `brand-${i}.example`, brand_name: `Brand ${i}`, created_at: HOURS_AGO(48) }),
    );
    mocks.getPendingLogos.mockResolvedValue(fifteen);
    mocks.getAdminChannel.mockResolvedValue({ channel_id: 'C123', channel_name: 'aao-admin' });

    const result = await runBrandLogoDigestJob();

    expect(result.staleCount).toBe(15);
    const body = (mocks.sendChannelMessage.mock.calls[0][1].blocks[0].text.text as string);
    expect(body).toContain('and 5 more');
  });
});
