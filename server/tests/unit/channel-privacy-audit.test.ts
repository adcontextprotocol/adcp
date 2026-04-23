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

const { mockChannels, mockVerify, mockSend, mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
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
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../src/db/system-settings-db.js', () => mockChannels);

vi.mock('../../src/slack/client.js', () => ({
  verifyChannelStillPrivate: mockVerify,
  sendChannelMessage: mockSend,
}));

// Spy on the logger so we can assert the structured audit record
// fires even when the summary send is suppressed — the log is the
// primary alert signal per the #2849 acceptance.
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { child: () => ({ info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() }) },
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

/** Pull the `driftedSettings` / `unknownSettings` off the audit's structured log call. */
function auditLogPayload(): Record<string, unknown> | undefined {
  const call = mockLoggerInfo.mock.calls.find(
    (args: unknown[]) =>
      typeof args[0] === 'object' &&
      args[0] !== null &&
      (args[0] as Record<string, unknown>).event === 'channel_privacy_drift_audit',
  );
  return call ? (call[0] as Record<string, unknown>) : undefined;
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

  it('groups every drifted setting into a single summary call (#2849 fan-out)', async () => {
    // billing + editorial both drifted → one summary mentioning both;
    // guards against a future refactor that sends per-channel posts.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_billing' || channelId === 'C_editorial') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted.map((d) => d.settingName).sort()).toEqual([
      'billing_slack_channel',
      'editorial_slack_channel',
    ]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const text = mockSend.mock.calls[0][1].text;
    expect(text).toContain('billing_slack_channel');
    expect(text).toContain('editorial_slack_channel');
  });

  it('suppresses the summary when admin_slack_channel is drifted AND logs the drift in the structured audit record (#2849 acceptance)', async () => {
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_admin') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted.map((d) => d.settingName)).toContain('admin_slack_channel');
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    // The structured log is the only signal in this case — assert it
    // fired with the drift information intact so log aggregation
    // alerting can pick it up.
    const payload = auditLogPayload();
    expect(payload).toBeDefined();
    expect(payload!.driftedSettings).toContain('admin_slack_channel');
  });

  it('suppresses the summary when admin is in the unknown bucket (narrow leak window)', async () => {
    // If we can't prove admin is private and another channel is
    // confirmed public, posting the drift summary into admin risks
    // leaking details to a channel whose privacy flipped between the
    // last audit and this one (with Slack's info endpoint failing
    // exactly during this run). Conservative: suppress, rely on log.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_admin') return 'unknown';
      if (channelId === 'C_billing') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted.map((d) => d.settingName)).toEqual(['billing_slack_channel']);
    expect(result.unknown.map((u) => u.settingName)).toEqual(['admin_slack_channel']);
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('suppresses the summary when both admin AND another channel are drifted (admin drop does not accidentally drop the billing record)', async () => {
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_admin' || channelId === 'C_billing') return 'public';
      return 'private';
    });

    const result = await runChannelPrivacyAudit();
    expect(result.drifted.map((d) => d.settingName).sort()).toEqual([
      'admin_slack_channel',
      'billing_slack_channel',
    ]);
    expect(result.summaryPosted).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    // Both settings must be in the structured log, even though the
    // summary was suppressed.
    const payload = auditLogPayload();
    expect(payload!.driftedSettings).toContain('admin_slack_channel');
    expect(payload!.driftedSettings).toContain('billing_slack_channel');
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

  it('does not write to the drifted setting — audit is pure observability (non-destructive invariant)', async () => {
    // The real guarantee here is structural: the audit module imports
    // no setting-mutation helpers. If a future refactor "helpfully"
    // auto-nulls a drifted setting, the new import will require the
    // test to expand — catching the drift at review time.
    mockVerify.mockImplementation(async (channelId: string) => {
      if (channelId === 'C_billing') return 'public';
      return 'private';
    });

    await runChannelPrivacyAudit();
    // sendChannelMessage is the only mocked write; confirm it's not
    // called against the drifted channel (only the admin channel).
    const sendTargets = mockSend.mock.calls.map((c: unknown[]) => c[0]);
    expect(sendTargets).not.toContain('C_billing');
  });
});
