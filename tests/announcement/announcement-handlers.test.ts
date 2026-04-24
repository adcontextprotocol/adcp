import { describe, it, test, expect, vi, beforeEach } from 'vitest';

const {
  mockQuery,
  mockSendChannelMessage,
  mockDeleteChannelMessage,
  mockGetAnnouncementChannel,
  mockIsSlackUserAAOAdmin,
} = vi.hoisted(() => ({
  mockQuery: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
  mockDeleteChannelMessage: vi.fn<any>(),
  mockGetAnnouncementChannel: vi.fn<any>(),
  mockIsSlackUserAAOAdmin: vi.fn<any>(),
}));

// Handlers now take their txn connection from `getPool().connect()` — we
// hand back a client whose `query` routes to `mockQuery` so assertions in
// existing tests (which inspect `mockQuery.mock.calls`) keep working.
vi.mock('../../server/src/db/client.js', () => {
  const fakeClient = {
    query: (...args: unknown[]) => {
      const sql = args[0];
      if (typeof sql === 'string' && /^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock)/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return mockQuery(...args);
    },
    release: vi.fn(),
  };
  return {
    query: (...args: unknown[]) => mockQuery(...args),
    getPool: () => ({ connect: async () => fakeClient }),
  };
});

vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mockSendChannelMessage(...args),
  deleteChannelMessage: (...args: unknown[]) => mockDeleteChannelMessage(...args),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getAnnouncementChannel: (...args: unknown[]) => mockGetAnnouncementChannel(...args),
}));

vi.mock('../../server/src/addie/mcp/admin-tools.js', () => ({
  isSlackUserAAOAdmin: (...args: unknown[]) => mockIsSlackUserAAOAdmin(...args),
}));

async function loadModule() {
  return await import('../../server/src/addie/jobs/announcement-handlers.js');
}

const ORG_ID = 'org_ACME123';
const ADMIN_USER = 'U0ADMIN42';
const REVIEW_CHANNEL = 'C0REVIEW01';
const REVIEW_TS = '1700000000.001';
const ANNOUNCE_CHANNEL = 'C0ANNOUNCE';
const POSTED_TS = '1700000000.100';

const DRAFT_METADATA = {
  review_channel_id: REVIEW_CHANNEL,
  review_message_ts: REVIEW_TS,
  slack_text: 'Welcome Acme — they build buyer agents.',
  linkedin_text: 'Welcome Acme.\n\n#AdvertisingAgents',
  visual_url: 'https://cdn.example/acme.png',
  visual_alt_text: 'Acme logo',
  visual_source: 'brand_logo',
  org_name: 'Acme Ad Tech',
  profile_slug: 'acme',
};

function buildActionBody(overrides: Record<string, unknown> = {}): any {
  return {
    actions: [{ value: ORG_ID, ...(overrides.action as object ?? {}) }],
    user: { id: ADMIN_USER, ...(overrides.user as object ?? {}) },
    channel: { id: REVIEW_CHANNEL, ...(overrides.channel as object ?? {}) },
    message: { ts: REVIEW_TS, ...(overrides.message as object ?? {}) },
  };
}

function buildClient() {
  return {
    chat: {
      update: vi.fn<any>().mockResolvedValue({ ok: true }),
      postEphemeral: vi.fn<any>().mockResolvedValue({ ok: true }),
    },
  };
}

/**
 * Queue up `mockQuery` results in the order the handler reads them:
 *   1) draft row  2) published/skipped activity rows  3) any writes
 * Callers pass the state rows and, for INSERTs, a resolved row.
 */
function queueDbReads(opts: {
  draft?: Record<string, unknown> | null;
  activityRows?: Array<{
    activity_type: 'announcement_published' | 'announcement_skipped';
    activity_date: Date;
    metadata: Record<string, unknown>;
  }>;
}) {
  const draftRow = opts.draft === null
    ? []
    : [{ metadata: opts.draft ?? DRAFT_METADATA }];
  mockQuery.mockResolvedValueOnce({ rows: draftRow });
  mockQuery.mockResolvedValueOnce({ rows: opts.activityRows ?? [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSlackUserAAOAdmin.mockResolvedValue(true);
  mockGetAnnouncementChannel.mockResolvedValue({
    channel_id: ANNOUNCE_CHANNEL,
    channel_name: 'all-agentic-ads',
  });
  mockSendChannelMessage.mockResolvedValue({ ok: true, ts: POSTED_TS });
  mockDeleteChannelMessage.mockResolvedValue({ ok: true });
});

describe('renderReviewCard', () => {
  it('initial state: three buttons, status pending-pending', async () => {
    const { renderReviewCard } = await loadModule();
    const { blocks, text } = renderReviewCard({
      orgId: ORG_ID,
      draft: DRAFT_METADATA,
      state: {
        slackTs: null,
        slackApproverUserId: null,
        slackAnnouncementChannelId: null,
        linkedinMarkerUserId: null,
        linkedinMarkedAt: null,
        skipperUserId: null,
        skippedAt: null,
      },
    });
    expect(text).toContain('Acme Ad Tech');
    const status = blocks.find((b) => b.type === 'context' && b.elements?.[0]?.text?.includes('pending'));
    expect(status?.elements?.[0]?.text).toContain('⏳ Slack pending');
    expect(status?.elements?.[0]?.text).toContain('⏳ LinkedIn pending');
    const actions = blocks.find((b) => b.type === 'actions');
    const ids = (actions?.elements ?? []).map((e: any) => e.action_id);
    expect(ids).toEqual([
      'announcement_approve_slack',
      'announcement_mark_linkedin',
      'announcement_skip',
    ]);
  });

  it('after slack posted: shows approver, drops approve + skip buttons, keeps LI button', async () => {
    const { renderReviewCard } = await loadModule();
    const { blocks } = renderReviewCard({
      orgId: ORG_ID,
      draft: DRAFT_METADATA,
      state: {
        slackTs: POSTED_TS,
        slackApproverUserId: ADMIN_USER,
        slackAnnouncementChannelId: ANNOUNCE_CHANNEL,
        linkedinMarkerUserId: null,
        linkedinMarkedAt: null,
        skipperUserId: null,
        skippedAt: null,
      },
    });
    const statusBlock = blocks.find(
      (b) => b.type === 'context' && b.elements?.[0]?.text?.includes('✓ Slack posted'),
    );
    expect(statusBlock?.elements?.[0]?.text).toContain(`<@${ADMIN_USER}>`);
    expect(statusBlock?.elements?.[0]?.text).toContain('⏳ LinkedIn pending');
    const actions = blocks.find((b) => b.type === 'actions');
    const ids = (actions?.elements ?? []).map((e: any) => e.action_id);
    expect(ids).toEqual(['announcement_mark_linkedin']);
  });

  it('after both channels posted: no actions block (terminal)', async () => {
    const { renderReviewCard } = await loadModule();
    const { blocks } = renderReviewCard({
      orgId: ORG_ID,
      draft: DRAFT_METADATA,
      state: {
        slackTs: POSTED_TS,
        slackApproverUserId: ADMIN_USER,
        slackAnnouncementChannelId: ANNOUNCE_CHANNEL,
        linkedinMarkerUserId: 'U0LIPOSTER',
        linkedinMarkedAt: new Date(),
        skipperUserId: null,
        skippedAt: null,
      },
    });
    expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
    const statusBlock = blocks.find(
      (b) => b.type === 'context' && b.elements?.[0]?.text?.includes('✓ Slack posted'),
    );
    expect(statusBlock?.elements?.[0]?.text).toContain('✓ LinkedIn posted by <@U0LIPOSTER>');
  });

  it('skipped: shows skipper, no actions', async () => {
    const { renderReviewCard } = await loadModule();
    const { blocks } = renderReviewCard({
      orgId: ORG_ID,
      draft: DRAFT_METADATA,
      state: {
        slackTs: null,
        slackApproverUserId: null,
        slackAnnouncementChannelId: null,
        linkedinMarkerUserId: null,
        linkedinMarkedAt: null,
        skipperUserId: ADMIN_USER,
        skippedAt: new Date(),
      },
    });
    expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
    const statusBlock = blocks.find(
      (b) => b.type === 'context' && b.elements?.[0]?.text?.includes('⊘'),
    );
    expect(statusBlock?.elements?.[0]?.text).toContain(`Skipped by <@${ADMIN_USER}>`);
  });

  it('sanitizes Slack-breakout tokens in the re-rendered drafts', async () => {
    const { renderReviewCard } = await loadModule();
    const { blocks } = renderReviewCard({
      orgId: ORG_ID,
      draft: {
        ...DRAFT_METADATA,
        slack_text: 'ping <!channel> and <@U123>',
        linkedin_text: 'shell `rm -rf` #AAO',
      },
      state: {
        slackTs: null,
        slackApproverUserId: null,
        slackAnnouncementChannelId: null,
        linkedinMarkerUserId: null,
        linkedinMarkedAt: null,
        skipperUserId: null,
        skippedAt: null,
      },
    });
    const slackBlock = blocks.find((b) => b.type === 'section' && b.text?.text?.includes('Slack draft'));
    expect(slackBlock?.text?.text).not.toMatch(/<!channel>/);
    expect(slackBlock?.text?.text).toMatch(/\[channel\]/);
    expect(slackBlock?.text?.text).toMatch(/@user/);
    const liBlock = blocks.find((b) => b.type === 'section' && b.text?.text?.includes('LinkedIn draft'));
    const inside = liBlock?.text?.text.split('```')[1] ?? '';
    expect(inside).not.toMatch(/`/);
  });
});

describe('buildPublicAnnouncementPayload', () => {
  it('produces section + image blocks with sanitized text', async () => {
    const { buildPublicAnnouncementPayload } = await loadModule();
    const payload = buildPublicAnnouncementPayload({
      ...DRAFT_METADATA,
      slack_text: 'Welcome <!channel>!',
    });
    expect(payload).not.toBeNull();
    expect(payload!.text).toBe('Welcome [channel]!');
    expect(payload!.blocks[0].type).toBe('section');
    expect(payload!.blocks[0].text?.text).toBe('Welcome [channel]!');
    expect(payload!.blocks[1].type).toBe('image');
    expect(payload!.blocks[1].image_url).toBe(DRAFT_METADATA.visual_url);
    expect(payload!.blocks[1].alt_text).toBe('Acme logo');
  });

  it('returns null when stored visual_url would fail isSafeVisualUrl', async () => {
    const { buildPublicAnnouncementPayload } = await loadModule();
    // loopback IP is explicitly rejected by isSafeVisualUrl
    const payload = buildPublicAnnouncementPayload({
      ...DRAFT_METADATA,
      visual_url: 'https://127.0.0.1/pwn.png',
    });
    expect(payload).toBeNull();
  });

  it('strips bare URLs not on the AAO host from the public slack text', async () => {
    const { buildPublicAnnouncementPayload } = await loadModule();
    const payload = buildPublicAnnouncementPayload({
      ...DRAFT_METADATA,
      slack_text:
        'Welcome Acme! Learn more at https://evil.example/landing and see https://agenticadvertising.org/members/acme',
    });
    expect(payload).not.toBeNull();
    expect(payload!.text).toContain('[link removed]');
    expect(payload!.text).not.toContain('evil.example');
    expect(payload!.text).toContain('https://agenticadvertising.org/members/acme');
  });
});

describe('scrubBareUrlsForPublicPost', () => {
  it('replaces off-host URLs with [link removed], keeps on-host URLs intact', async () => {
    const { scrubBareUrlsForPublicPost } = await loadModule();
    expect(
      scrubBareUrlsForPublicPost(
        'a https://evil.example/ b https://agenticadvertising.org/ok',
        'https://agenticadvertising.org',
      ),
    ).toBe('a [link removed] b https://agenticadvertising.org/ok');
  });

  it('handles malformed URL-like fragments gracefully', async () => {
    const { scrubBareUrlsForPublicPost } = await loadModule();
    const out = scrubBareUrlsForPublicPost(
      'check https://.malformed and normal text',
      'https://agenticadvertising.org',
    );
    expect(out).toMatch(/\[link removed\]/);
    expect(out).toContain('normal text');
  });
});

describe('handleAnnouncementApproveSlack', () => {
  test('happy path: posts to announcement channel, records activity, refreshes card', async () => {
    queueDbReads({});
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT activity

    const { handleAnnouncementApproveSlack } = await loadModule();
    const ack = vi.fn<any>().mockResolvedValue(undefined);
    const client = buildClient();
    await handleAnnouncementApproveSlack({ ack, body: buildActionBody(), client });

    expect(ack).toHaveBeenCalled();
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    const [postChannel, payload] = mockSendChannelMessage.mock.calls[0];
    expect(postChannel).toBe(ANNOUNCE_CHANNEL);
    expect(payload.blocks?.[0].text?.text).toContain('Welcome Acme');
    // Activity insert
    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.channel).toBe('slack');
    expect(metadata.slack_ts).toBe(POSTED_TS);
    expect(metadata.approver_user_id).toBe(ADMIN_USER);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
  });

  test('idempotent: if slack activity row already exists, skip post, just refresh card', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_published',
          activity_date: new Date(),
          metadata: { channel: 'slack', slack_ts: POSTED_TS, approver_user_id: 'U0OLD' },
        },
      ],
    });

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(client.chat.update).toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/already/) }),
    );
  });

  test('unwinds Slack post when activity write fails', async () => {
    queueDbReads({});
    mockQuery.mockRejectedValueOnce(new Error('db down')); // INSERT fails

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    expect(mockDeleteChannelMessage).toHaveBeenCalledWith(ANNOUNCE_CHANNEL, POSTED_TS);
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/failed to record/i) }),
    );
  });

  test('refuses when announcement channel is not configured', async () => {
    queueDbReads({});
    mockGetAnnouncementChannel.mockResolvedValueOnce({ channel_id: null, channel_name: null });

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/not configured/i) }),
    );
  });

  test('refuses when the draft was already skipped', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_skipped',
          activity_date: new Date(),
          metadata: { skipper_user_id: 'U0OTHER' },
        },
      ],
    });

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/skipped/i) }),
    );
  });

  test('refuses non-admin', async () => {
    mockIsSlackUserAAOAdmin.mockResolvedValueOnce(false);

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/only aao admins/i) }),
    );
  });

  test('ignores bodies missing required fields', async () => {
    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    const ack = vi.fn<any>().mockResolvedValue(undefined);
    await handleAnnouncementApproveSlack({
      ack,
      body: { actions: [{}], user: { id: ADMIN_USER } },
      client,
    });
    expect(ack).toHaveBeenCalled();
    expect(mockIsSlackUserAAOAdmin).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('ignores action value that does not look like an org ID', async () => {
    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody({ action: { value: "'; DROP TABLE orgs;--" } }),
      client,
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('refuses when stored visual_url fails safety revalidation', async () => {
    queueDbReads({
      draft: {
        ...DRAFT_METADATA,
        visual_url: 'https://127.0.0.1/pwn.png',
      },
    });

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/safety check/i) }),
    );
  });

  test('rejects body with non-slack channel id shape', async () => {
    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody({ channel: { id: 'evil-channel' } }),
      client,
    });
    expect(mockIsSlackUserAAOAdmin).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('rejects body with non-slack message ts shape', async () => {
    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody({ message: { ts: 'not-a-timestamp' } }),
      client,
    });
    expect(mockIsSlackUserAAOAdmin).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('tells user to retry when Slack post fails (no activity row written)', async () => {
    queueDbReads({});
    mockSendChannelMessage.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' });

    const { handleAnnouncementApproveSlack } = await loadModule();
    const client = buildClient();
    await handleAnnouncementApproveSlack({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/channel_not_found/) }),
    );
  });
});

describe('handleAnnouncementMarkLinkedIn', () => {
  test('happy path: inserts linkedin row + refreshes card', async () => {
    queueDbReads({});
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { handleAnnouncementMarkLinkedIn } = await loadModule();
    const client = buildClient();
    await handleAnnouncementMarkLinkedIn({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.channel).toBe('linkedin');
    expect(metadata.marked_by_user_id).toBe(ADMIN_USER);
    expect(client.chat.update).toHaveBeenCalled();
  });

  test('succeeds when slack was already posted — records linkedin row, reaches terminal state', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_published',
          activity_date: new Date(),
          metadata: { channel: 'slack', slack_ts: POSTED_TS, approver_user_id: 'U0PRIOR01' },
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT linkedin

    const { handleAnnouncementMarkLinkedIn } = await loadModule();
    const client = buildClient();
    await handleAnnouncementMarkLinkedIn({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.channel).toBe('linkedin');
    // The refreshed card should be the terminal "no actions" shape since
    // both channels are now done.
    const updateCall = client.chat.update.mock.calls[0][0];
    const actionsBlock = updateCall.blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeUndefined();
  });

  test('idempotent: already marked → no duplicate insert', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_published',
          activity_date: new Date(),
          metadata: { channel: 'linkedin', marked_by_user_id: 'U0PRIOR' },
        },
      ],
    });

    const { handleAnnouncementMarkLinkedIn } = await loadModule();
    const client = buildClient();
    await handleAnnouncementMarkLinkedIn({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();
    expect(client.chat.update).toHaveBeenCalled();
  });

  test('refuses if draft was skipped', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_skipped',
          activity_date: new Date(),
          metadata: { skipper_user_id: 'U0OTHER' },
        },
      ],
    });

    const { handleAnnouncementMarkLinkedIn } = await loadModule();
    const client = buildClient();
    await handleAnnouncementMarkLinkedIn({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();
  });
});

describe('handleAnnouncementSkip', () => {
  test('happy path: inserts skipped row + refreshes card', async () => {
    queueDbReads({});
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { handleAnnouncementSkip } = await loadModule();
    const client = buildClient();
    await handleAnnouncementSkip({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.skipper_user_id).toBe(ADMIN_USER);
    expect(client.chat.update).toHaveBeenCalled();
  });

  test('refuses skipping after a channel has been posted', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_published',
          activity_date: new Date(),
          metadata: { channel: 'slack', slack_ts: POSTED_TS, approver_user_id: 'U0PRIOR' },
        },
      ],
    });

    const { handleAnnouncementSkip } = await loadModule();
    const client = buildClient();
    await handleAnnouncementSkip({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/already been published/) }),
    );
  });

  test('idempotent: re-click on a skipped draft just refreshes', async () => {
    queueDbReads({
      activityRows: [
        {
          activity_type: 'announcement_skipped',
          activity_date: new Date(),
          metadata: { skipper_user_id: 'U0PRIOR' },
        },
      ],
    });

    const { handleAnnouncementSkip } = await loadModule();
    const client = buildClient();
    await handleAnnouncementSkip({
      ack: vi.fn<any>().mockResolvedValue(undefined),
      body: buildActionBody(),
      client,
    });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.includes('INSERT'),
    );
    expect(insertCall).toBeUndefined();
    expect(client.chat.update).toHaveBeenCalled();
  });
});
