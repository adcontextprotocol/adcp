/**
 * Integration tests for the write-time privacy gate on admin-settings
 * PUT routes (#3003).
 *
 * Exercises the 400 response shape for each of the three branches:
 *   - cannot_verify → distinct message telling admin to invite the bot
 *   - wrong_privacy (private required, channel is public)
 *   - wrong_privacy (public required, channel is private)
 *
 * Previously the cannot_verify branch was silently accepted. We only
 * test two representative endpoints (billing = private-required,
 * announcement = public-required) because all seven routes share the
 * same `requireChannelPrivacy` helper — adding coverage for the other
 * five would duplicate the helper test in `slack-channel-privacy.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const {
  mockVerifyPrivacy,
  mockIsSlackConfigured,
  mockSetBillingChannel,
  mockSetAnnouncementChannel,
  mockGetBillingChannel,
  mockGetAnnouncementChannel,
  mockGetSlackChannels,
} = vi.hoisted(() => ({
  mockVerifyPrivacy: vi.fn<any>(),
  mockIsSlackConfigured: vi.fn<any>(),
  mockSetBillingChannel: vi.fn<any>(),
  mockSetAnnouncementChannel: vi.fn<any>(),
  mockGetBillingChannel: vi.fn<any>(),
  mockGetAnnouncementChannel: vi.fn<any>(),
  mockGetSlackChannels: vi.fn<any>(),
}));

vi.mock('../../src/slack/client.js', () => ({
  isSlackConfigured: (...args: unknown[]) => mockIsSlackConfigured(...args),
  verifyChannelPrivacyForWrite: (...args: unknown[]) => mockVerifyPrivacy(...args),
  getSlackChannels: (...args: unknown[]) => mockGetSlackChannels(...args),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin_01', email: 'admin@test', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getAllSettings: vi.fn().mockResolvedValue([]),
  getBillingChannel: (...args: unknown[]) => mockGetBillingChannel(...args),
  setBillingChannel: (...args: unknown[]) => mockSetBillingChannel(...args),
  getEscalationChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  setEscalationChannel: vi.fn(),
  getAdminChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  setAdminChannel: vi.fn(),
  getProspectChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  setProspectChannel: vi.fn(),
  getProspectTriageEnabled: vi.fn().mockResolvedValue(true),
  setProspectTriageEnabled: vi.fn(),
  getErrorChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  setErrorChannel: vi.fn(),
  getEditorialChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
  setEditorialChannel: vi.fn(),
  getAnnouncementChannel: (...args: unknown[]) => mockGetAnnouncementChannel(...args),
  setAnnouncementChannel: (...args: unknown[]) => mockSetAnnouncementChannel(...args),
}));

async function buildApp() {
  const { createAdminSettingsRouter } = await import('../../src/routes/admin/settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settings', createAdminSettingsRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSlackConfigured.mockReturnValue(true);
  mockSetBillingChannel.mockResolvedValue(undefined);
  mockSetAnnouncementChannel.mockResolvedValue(undefined);
  mockGetBillingChannel.mockResolvedValue({
    channel_id: 'C_BILLING',
    channel_name: 'billing',
  });
  mockGetAnnouncementChannel.mockResolvedValue({
    channel_id: 'C_ANNOUNCE',
    channel_name: 'all-agentic-ads',
  });
});

describe('PUT /api/admin/settings/billing-channel — privacy gate (#3003)', () => {
  it('accepts when channel is confirmed private', async () => {
    mockVerifyPrivacy.mockResolvedValueOnce({ ok: true });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/billing-channel')
      .send({ channel_id: 'C1234567', channel_name: 'billing' });
    expect(res.status).toBe(200);
    expect(mockSetBillingChannel).toHaveBeenCalled();
    expect(mockVerifyPrivacy).toHaveBeenCalledWith('C1234567', 'private');
  });

  it('rejects on cannot_verify with a distinct "invite the bot" message', async () => {
    // Previously: `channelInfo && !channelInfo.is_private` short-
    // circuited to `false` on null → write accepted silently.
    mockVerifyPrivacy.mockResolvedValueOnce({ ok: false, reason: 'cannot_verify' });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/billing-channel')
      .send({ channel_id: 'C1234567', channel_name: 'billing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Could not verify channel');
    expect(res.body.message).toMatch(/Invite @Addie/i);
    expect(mockSetBillingChannel).not.toHaveBeenCalled();
  });

  it('rejects on wrong_privacy (public channel for private-required endpoint)', async () => {
    mockVerifyPrivacy.mockResolvedValueOnce({
      ok: false,
      reason: 'wrong_privacy',
      actual: 'public',
      expected: 'private',
    });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/billing-channel')
      .send({ channel_id: 'C1234567', channel_name: 'billing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid channel');
    expect(res.body.message).toMatch(/Only private channels.*billing/i);
    expect(mockSetBillingChannel).not.toHaveBeenCalled();
  });

  it('skips the check when Slack is not configured (local dev)', async () => {
    mockIsSlackConfigured.mockReturnValue(false);
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/billing-channel')
      .send({ channel_id: 'C1234567', channel_name: 'billing' });
    expect(res.status).toBe(200);
    expect(mockVerifyPrivacy).not.toHaveBeenCalled();
    expect(mockSetBillingChannel).toHaveBeenCalled();
  });
});

describe('PUT /api/admin/settings/announcement-channel — privacy gate (#3003)', () => {
  it('accepts when channel is confirmed public', async () => {
    mockVerifyPrivacy.mockResolvedValueOnce({ ok: true });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/announcement-channel')
      .send({ channel_id: 'C1234567', channel_name: 'all-agentic-ads' });
    expect(res.status).toBe(200);
    expect(mockVerifyPrivacy).toHaveBeenCalledWith('C1234567', 'public');
    expect(mockSetAnnouncementChannel).toHaveBeenCalled();
  });

  it('rejects on cannot_verify — the inverted-direction endpoint had no downstream gate', async () => {
    // Private-required endpoints had a send-time backstop
    // (`requirePrivate: true` on `sendChannelMessage`). The
    // announcement endpoint inverts: it requires public. A null
    // getChannelInfo used to let a *private* channel id through
    // here, which would silently never post. This test pins the
    // write-time rejection.
    mockVerifyPrivacy.mockResolvedValueOnce({ ok: false, reason: 'cannot_verify' });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/announcement-channel')
      .send({ channel_id: 'C1234567', channel_name: 'announce' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Could not verify channel');
    expect(mockSetAnnouncementChannel).not.toHaveBeenCalled();
  });

  it('rejects on wrong_privacy (private channel for public-required endpoint)', async () => {
    mockVerifyPrivacy.mockResolvedValueOnce({
      ok: false,
      reason: 'wrong_privacy',
      actual: 'private',
      expected: 'public',
    });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/admin/settings/announcement-channel')
      .send({ channel_id: 'C1234567', channel_name: 'announce' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid channel');
    expect(res.body.message).toMatch(/must be public/i);
    expect(mockSetAnnouncementChannel).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/settings/slack-channels — is_member pre-filter', () => {
  // Without this filter, the public-channel picker (used by the
  // announcement setting) would list every public channel in the
  // workspace — including ones the bot isn't a member of — and a
  // "valid" pick would then hit cannot_verify at save time. Shifting
  // the filter to the read side keeps the dropdown honest.
  it('drops channels where is_member is false', async () => {
    mockGetSlackChannels.mockResolvedValueOnce([
      { id: 'C_IN', name: 'all-agentic-ads', is_private: false, is_member: true, num_members: 42 },
      { id: 'C_OUT', name: 'random-public', is_private: false, is_member: false, num_members: 99 },
    ]);
    const app = await buildApp();
    const res = await request(app).get('/api/admin/settings/slack-channels?visibility=public');
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([
      expect.objectContaining({ id: 'C_IN', name: 'all-agentic-ads' }),
    ]);
    expect(res.body.channels).not.toContainEqual(expect.objectContaining({ id: 'C_OUT' }));
  });

  it('treats missing is_member as still-a-member (conservative default)', async () => {
    // Private-channel listings don't return is_member at all because
    // conversations.list only surfaces private channels the bot is
    // already in. Don't filter those out based on an absent field.
    mockGetSlackChannels.mockResolvedValueOnce([
      { id: 'C_PRIV', name: 'admin-editorial-review', is_private: true },
    ]);
    const app = await buildApp();
    const res = await request(app).get('/api/admin/settings/slack-channels');
    expect(res.body.channels).toEqual([
      expect.objectContaining({ id: 'C_PRIV' }),
    ]);
  });
});

/**
 * Invariant lint: every PUT handler on admin/settings.ts that accepts
 * a `channel_id` MUST go through `requireChannelPrivacy`. A new
 * channel-setting endpoint that forgets the gate would be a silent
 * regression of #3003 — adding per-endpoint supertest coverage for
 * all seven routes is low-signal duplication, but pinning the
 * invariant in one grep-style test catches a future omission.
 */
describe('invariant: channel-setting PUT handlers call requireChannelPrivacy', () => {
  it('every PUT handler that reads channel_id also goes through the privacy gate', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../src/routes/admin/settings.ts', import.meta.url),
      'utf8',
    );
    // Split on `router.put(` — each section is one handler body. The
    // prospect-triage-enabled handler also uses `router.put` but
    // doesn't take a channel_id; we detect channel handlers by a
    // `{ channel_id, channel_name }` destructure and require that
    // `requireChannelPrivacy` appears in the same block.
    const handlers = source.split(/router\.put\(/).slice(1);
    const channelHandlers = handlers.filter((h) =>
      h.slice(0, 2000).includes('{ channel_id, channel_name }'),
    );
    expect(channelHandlers.length).toBe(7);
    for (const body of channelHandlers) {
      // Expected shape: `const privacyErr = await requireChannelPrivacy(...)`
      expect(body.slice(0, 2000)).toMatch(/requireChannelPrivacy\(/);
    }
  });
});
