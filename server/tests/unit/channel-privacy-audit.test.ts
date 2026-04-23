import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * #2849 — daily audit job for admin-channel privacy drift.
 *
 * Mocks at the module seam (`system-settings-db` + `slack/client`)
 * rather than driving real Slack calls — the audit's logic lives in
 * the orchestration (which channels get checked, what happens to
 * the summary when admin itself drifts), not in Slack plumbing. The
 * send-time recheck helpers already have their own integration-ish
 * tests in `slack-channel-privacy.test.ts`.
 */

const { mockChannels, mockVerify, mockSend } = vi.hoisted(() => ({
  mockChannels: {
    getBillingChannel: vi.fn(),
    getEscalationChannel: vi.fn(),
    getAdminChannel: vi.fn(),
    getProspectChannel: vi.fn(),
    getErrorChannel: vi.fn(),
    getEditorialChannel: vi.fn(),
  },
  mockVerify: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock('../../src/db/system-settings-db.js', () => mockChannels);

vi.mock('../../src/slack/client.js', () => ({
  verifyChannelStillPrivate: mockVerify,
  sendChannelMessage: mockSend,
}));

import { runChannelPrivacyAudit } from '../../src/addie/jobs/channel-privacy-audit.js';

/** Default: every channel is configured and private (clean run). */
function seedAllPrivate() {
  mockChannels.getBillingChannel.mockResolvedValue({ channel_id: 'C_billing', channel_name: 'billing' });
  mockChannels.getEscalationChannel.mockResolvedValue({ channel_id: 'C_escalation', channel_name: 'escalation' });
  mockChannels.getAdminChannel.mockResolvedValue({ channel_id: 'C_admin', channel_name: 'admin' });
  mockChannels.getProspectChannel.mockResolvedValue({ channel_id: 'C_prospect', channel_name: 'prospect' });
  mockChannels.getErrorChannel.mockResolvedValue({ channel_id: 'C_error', channel_name: 'error' });
  mockChannels.getEditorialChannel.mockResolvedValue({ channel_id: 'C_editorial', channel_name: 'editorial' });
  mockVerify.mockResolvedValue('private');
  mockSend.mockResolvedValue({ ok: true, ts: '1.1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedAllPrivate();
});

describe('runChannelPrivacyAudit', () => {
  it('checks every configured channel', async () => {
    const result = await runChannelPrivacyAudit();
    expect(result.checked).toBe(6);
    expect(result.drifted).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(mockVerify).toHaveBeenCalledTimes(6);
  });

  it('skips unconfigured channels (empty channel_id)', async () => {
    mockChannels.getBillingChannel.mockResolvedValue({ channel_id: null, channel_name: null });
    mockChannels.getProspectChannel.mockResolvedValue({ channel_id: '', channel_name: null });

    const result = await runChannelPrivacyAudit();
    expect(result.checked).toBe(4);
    expect(mockVerify).toHaveBeenCalledTimes(4);
    const verifiedIds = mockVerify.mock.calls.map((c: unknown[]) => c[0]);
    expect(verifiedIds).not.toContain('C_billing');
    expect(verifiedIds).not.toContain('C_prospect');
  });

  it('does not post a summary when everything is private', async () => {
    const result = await runChannelPrivacyAudit();
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts a summary to the admin channel when a non-admin channel drifts', async () => {
    // billing is drifted; admin is still private so we can notify there.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_billing') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].settingName).toBe('billing_slack_channel');
    expect(result.summaryPosted).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [channel, message] = mockSend.mock.calls[0];
    expect(channel).toBe('C_admin');
    expect(message.text).toContain('billing_slack_channel');
  });

  it('refuses to post the summary to the admin channel when the admin channel itself drifted (#2849 acceptance)', async () => {
    // Don't post sensitive drift info into the drifted channel.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_admin') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted.map((d) => d.settingName)).toContain('admin_slack_channel');
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('records unknown states separately from drift', async () => {
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_error') return 'unknown';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted).toEqual([]);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].settingName).toBe('error_slack_channel');
  });

  it('posts a summary mentioning unknown channels even when nothing is drifted', async () => {
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_error') return 'unknown';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.summaryPosted).toBe(true);
    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain('error_slack_channel');
    expect(text).toMatch(/Unverifiable|unknown/i);
  });

  it('treats a throw from verifyChannelStillPrivate as unknown, not drift', async () => {
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_escalation') throw new Error('network flake');
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted).toEqual([]);
    expect(result.unknown.map((u) => u.settingName)).toContain('escalation_slack_channel');
  });

  it('does not auto-null a drifted setting (non-destructive)', async () => {
    // The PR description explicitly leaves auto-null out of scope —
    // enforcement is the send-time gate's job. This test pins that
    // decision so a future refactor that "helpfully" clears the
    // setting flips this red.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_billing') return 'public';
      return 'private';
    });

    await runChannelPrivacyAudit();
    // No settings-update helpers are imported by the audit module; the
    // only mock that writes is `sendChannelMessage` (summary) and even
    // that goes to the admin channel, not the billing setting.
    const sendTargets = mockSend.mock.calls.map((c: unknown[]) => c[0]);
    expect(sendTargets).not.toContain('C_billing');
  });
});
