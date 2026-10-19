/**
 * Agent-controlled text must never reach a Slack notification title (adcp#8320).
 *
 * The compliance notifiers describe an agent to its owner and to the shared
 * registry channel, and almost everything they have to say about it comes
 * from the agent: the stored `headline` for an unreachable agent is derived
 * from that agent's own error, and badge roles, specialisms and revocation
 * reasons come from the capabilities it declared. Slack parses a DM's text
 * as mrkdwn, so an unsanitized interpolation lets a hostile agent put
 * `<!channel>`, a forged link, or ten kilobytes of prose into the headline
 * of a message the owner reads as platform-authored.
 *
 * These tests hold the boundary from both sides: the title is a fixed
 * template plus short sanitized identifiers, and the agent's own words are
 * quoted in the body, flattened, capped and escaped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CHANNEL_ID = 'C_REGISTRY_EDITS';
const AGENT_URL = 'https://hostile.example.com/mcp';
const OWNER_USER_ID = 'user_owner_1';
const SLACK_USER_ID = 'U_OWNER_1';

vi.hoisted(() => {
  process.env.REGISTRY_EDITS_CHANNEL_ID = 'C_REGISTRY_EDITS';
  process.env.BASE_URL = 'https://agenticadvertising.org';
});

const slackMocks = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(async () => ({ ok: true })),
  sendChannelMessage: vi.fn(async () => ({ ok: true, ts: '1.0' })),
  isSlackConfigured: vi.fn(() => true),
}));

const notificationDbMocks = vi.hoisted(() => ({
  createNotification: vi.fn(async (data: unknown) => data),
  exists: vi.fn(async () => false),
  invalidateCountCache: vi.fn(),
}));

const slackDbMocks = vi.hoisted(() => ({
  getByWorkosUserId: vi.fn(async () => ({ slack_user_id: SLACK_USER_ID })),
}));

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));
const eventMocks = vi.hoisted(() => ({ writeEvent: vi.fn(async () => undefined) }));
const complianceDbMocks = vi.hoisted(() => ({
  publishVerificationChangeEventsIfCurrent: vi.fn(async () => undefined),
}));

vi.mock('../../src/slack/client.js', () => slackMocks);
vi.mock('../../src/db/notification-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/notification-db.js')>(),
  NotificationDatabase: class {
    createNotification = notificationDbMocks.createNotification;
    exists = notificationDbMocks.exists;
    invalidateCountCache = notificationDbMocks.invalidateCountCache;
  },
}));
vi.mock('../../src/db/slack-db.js', () => ({
  SlackDatabase: class {
    getByWorkosUserId = slackDbMocks.getByWorkosUserId;
  },
}));
vi.mock('../../src/db/client.js', () => ({ query: dbMocks.query }));
vi.mock('../../src/db/catalog-events-db.js', () => ({
  CatalogEventsDatabase: class {
    writeEvent = eventMocks.writeEvent;
  },
}));
vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    publishVerificationChangeEventsIfCurrent =
      complianceDbMocks.publishVerificationChangeEventsIfCurrent;
  },
}));

const {
  notifyComplianceChange,
  notifyComplianceTimeout,
  notifyExtendedOutages,
  notifyVerificationChange,
} = await import('../../src/notifications/compliance.js');
const { notifyUser } = await import('../../src/notifications/notification-service.js');
const { NOTIFICATION_BODY_MAX_LENGTH, NOTIFICATION_TITLE_MAX_LENGTH } =
  await import('../../src/db/notification-db.js');

/**
 * Every shape an agent can use to take over a Slack surface: a broadcast
 * ping, a user ping, a link whose label lies about its destination, mrkdwn
 * emphasis, and newlines that forge extra lines in a message the reader
 * trusts the shape of.
 */
const HOSTILE_HEADLINE =
  '<!channel> *URGENT* <https://evil.example/phish|agenticadvertising.org> ' +
  '<@U0ADMIN> & co\nStatus: passing\nVerified: yes';

/** A misbehaving agent echoing its whole response body into an error. */
const HUGE_HEADLINE = `Unreachable: ${'A'.repeat(10_000)}`;

/** Substrings that must never survive into a Slack message. */
function expectNoLiveMrkdwn(text: string): void {
  expect(text).not.toContain('<!channel>');
  expect(text).not.toContain('<@U0ADMIN>');
  expect(text).not.toContain('<https://evil.example/phish|');
  expect(text).not.toContain('<!here>');
}

function dmText(): string {
  expect(slackMocks.sendDirectMessage).toHaveBeenCalled();
  const [, message] = slackMocks.sendDirectMessage.mock.calls.at(-1) as [string, { text: string }];
  return message.text;
}

function storedNotification(): { title: string; body?: string } {
  expect(notificationDbMocks.createNotification).toHaveBeenCalled();
  return notificationDbMocks.createNotification.mock.calls.at(-1)![0] as { title: string; body?: string };
}

function channelText(): string {
  expect(slackMocks.sendChannelMessage).toHaveBeenCalled();
  const [, message] = slackMocks.sendChannelMessage.mock.calls.at(-1) as [
    string,
    { text: string; blocks: Array<{ text?: { text?: string } }> },
  ];
  return [message.text, ...message.blocks.map((b) => b.text?.text ?? '')].join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  slackMocks.sendDirectMessage.mockResolvedValue({ ok: true });
  slackMocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '1.0' });
  slackMocks.isSlackConfigured.mockReturnValue(true);
  notificationDbMocks.createNotification.mockImplementation(async (data: unknown) => data);
  notificationDbMocks.exists.mockResolvedValue(false);
  slackDbMocks.getByWorkosUserId.mockResolvedValue({ slack_user_id: SLACK_USER_ID });
  // resolveAgentOwnerUserIds
  dbMocks.query.mockResolvedValue({ rows: [{ workos_user_id: OWNER_USER_ID }], rowCount: 1 });
});

describe('notifyComplianceChange', () => {
  const regression = (headline: string) => notifyComplianceChange({
    agentUrl: AGENT_URL,
    previousStatus: 'passing',
    currentStatus: 'failing',
    headline,
    tracksJson: [{ track: 'media-buy', status: 'fail' } as never],
  });

  it('keeps the agent-derived headline out of the DM title', async () => {
    await regression(HOSTILE_HEADLINE);

    const stored = storedNotification();
    expect(stored.title).toBe(
      'Your agent hostile.example.com has compliance failures (1 failing track).',
    );
    expect(stored.title).not.toContain('!channel');
    expect(stored.title).not.toContain('URGENT');
    expect(stored.body).toContain('Failing tracks: media-buy (fail).');
  });

  it('quotes the headline in the body, flattened and mrkdwn-escaped', async () => {
    await regression(HOSTILE_HEADLINE);

    const text = dmText();
    expectNoLiveMrkdwn(text);
    expect(text).toContain('&lt;!\u200bchannel&gt;');
    expect(text).toContain('Reported: ');

    // The headline cannot forge a line of its own: the DM is exactly the
    // title, the quoted body, and our link.
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Your agent hostile.example.com has compliance failures (1 failing track).');
    expect(lines[1].startsWith('Failing tracks: media-buy (fail). Reported: ')).toBe(true);
    expect(lines[2]).toBe('<https://agenticadvertising.org/registry?tab=agents|View>');
    expect(lines[1]).not.toMatch(/^Status:/);
  });

  it('caps a 10 KB headline instead of flooding the DM', async () => {
    await regression(HUGE_HEADLINE);

    const stored = storedNotification();
    expect(stored.body!.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_LENGTH + 1);
    expect(stored.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX_LENGTH + 1);
    expect(dmText().length).toBeLessThan(1_000);
  });

  it('omits the body entirely when there is nothing to report', async () => {
    await notifyComplianceChange({
      agentUrl: AGENT_URL,
      previousStatus: 'passing',
      currentStatus: 'failing',
      headline: '',
      tracksJson: [],
    });

    expect(storedNotification().body).toBeUndefined();
    expect(storedNotification().title)
      .toBe('Your agent hostile.example.com has compliance failures.');
    expect(dmText().split('\n')).toHaveLength(2);
  });

  it('keeps reporting the headline when the agent pads it with whitespace', async () => {
    // The flattener has a fast-path window; without the second pass an
    // agent could bury its own error behind kilobytes of spaces and leave
    // the owner a notification with no detail at all.
    await regression(`${' '.repeat(20_000)}ECONNREFUSED at the TLS handshake`);

    expect(storedNotification().body).toContain('ECONNREFUSED at the TLS handshake');
  });

  it('escapes the agent name in the shared-channel message', async () => {
    await notifyComplianceChange({
      agentUrl: 'https://<!channel>.example.com/mcp',
      previousStatus: 'passing',
      currentStatus: 'failing',
      headline: HOSTILE_HEADLINE,
      tracksJson: [],
    });

    const text = channelText();
    expectNoLiveMrkdwn(text);
    // The headline never reaches the public channel at all.
    expect(text).not.toContain('URGENT');
  });
});

describe('notifyComplianceTimeout', () => {
  it('builds the title from a fixed template and moves the summary to the body', async () => {
    await notifyComplianceTimeout({
      agentUrl: AGENT_URL,
      summary: 'Last heartbeat timed out at 2026-10-01T10:07:00.000Z after 654s of its 600s budget.',
    });

    const stored = storedNotification();
    expect(stored.title).toBe('Compliance checks for your agent hostile.example.com are not completing.');
    expect(stored.body).toContain('Last heartbeat timed out');
  });

  it('survives a summary that smuggles mrkdwn', async () => {
    await notifyComplianceTimeout({ agentUrl: AGENT_URL, summary: HOSTILE_HEADLINE });

    const text = dmText();
    expectNoLiveMrkdwn(text);
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('notifyVerificationChange', () => {
  it('sanitizes the agent-declared role and moves the revocation reason to the body', async () => {
    await notifyVerificationChange({
      agentUrl: AGENT_URL,
      issued: [],
      revoked: [{ role: '<!channel> sales', reason: HOSTILE_HEADLINE }],
      emitFeedEvents: false,
      notifyChannel: false,
    });

    const stored = storedNotification();
    expect(stored.title).toBe(
      'Your agent hostile.example.com lost its AAO Verified <!channel> sales badge.',
    );
    expect(stored.body).toContain('Reason: ');

    const text = dmText();
    expectNoLiveMrkdwn(text);
    expect(text).toContain('&lt;!\u200bchannel&gt; sales');
    expect(text.split('\n')).toHaveLength(3);
  });

  it('escapes agent-declared role and specialisms in the shared channel', async () => {
    await notifyVerificationChange({
      agentUrl: AGENT_URL,
      issued: [{ role: '<!here> sales', specialisms: ['<https://evil.example/x|safe>'] }],
      revoked: [],
      emitFeedEvents: false,
      notifyChannel: true,
    });

    expectNoLiveMrkdwn(channelText());
  });

  it('falls back to a placeholder when the declared role is only whitespace', async () => {
    await notifyVerificationChange({
      agentUrl: AGENT_URL,
      issued: [],
      revoked: [{ role: '   \n  ', reason: 'requalification window elapsed' }],
      emitFeedEvents: false,
      notifyChannel: false,
    });

    expect(storedNotification().title).toBe(
      'Your agent hostile.example.com lost its AAO Verified unknown role badge.',
    );
  });
});

describe('notifyExtendedOutages', () => {
  it('keeps the stored status out of free-text position', async () => {
    dbMocks.query
      // the outage scan
      .mockResolvedValueOnce({
        rows: [{
          agent_url: AGENT_URL,
          headline: HOSTILE_HEADLINE,
          status: 'failing',
          status_changed_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        }],
        rowCount: 1,
      })
      // resolveAgentOwnerUserIds
      .mockResolvedValue({ rows: [{ workos_user_id: OWNER_USER_ID }], rowCount: 1 });

    const result = await notifyExtendedOutages();

    expect(result.notified).toBe(1);
    const text = dmText();
    expectNoLiveMrkdwn(text);
    expect(text).not.toContain('URGENT');
    expect(storedNotification().title).toContain('has been failing for 9 days');
  });
});

describe('notifyUser', () => {
  // The compliance notifiers sanitize before they call in, but the other
  // eleven callers do not — `notifyUser` is the only thing standing between
  // their input and a Slack DM.
  const hostile = {
    recipientUserId: OWNER_USER_ID,
    type: 'test_event',
    title: `Alice <!channel> joined\nStatus: admin`,
    body: `${'B'.repeat(5_000)}`,
    url: '/working-groups/signals',
  };

  it('escapes and flattens a title it was handed raw', async () => {
    await notifyUser(hostile);

    const lines = dmText().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Alice &lt;!\u200bchannel&gt; joined Status: admin');
    expect(lines[1].length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_LENGTH + 1);
    expect(lines[2]).toBe('<https://agenticadvertising.org/working-groups/signals|View>');
  });

  it('caps an over-long title', async () => {
    await notifyUser({ ...hostile, title: 'T'.repeat(5_000), body: undefined });

    const lines = dmText().split('\n');
    expect(lines[0].length).toBe(NOTIFICATION_TITLE_MAX_LENGTH + 1);
    expect(lines[0].endsWith('…')).toBe(true);
  });

  it('drops a link whose target could break out of Slack link syntax', async () => {
    // `url` is the one field that cannot be escaped — a `>` closes the link
    // and leaves the remainder as top-level mrkdwn.
    for (const url of ['https://evil.example', '//evil.example', '/ok>|<!channel>']) {
      slackMocks.sendDirectMessage.mockClear();
      await notifyUser({ ...hostile, body: undefined, url });
      expect(dmText().split('\n')).toHaveLength(1);
    }
  });
});

describe('channel id wiring', () => {
  it('uses the configured registry channel', () => {
    expect(CHANNEL_ID).toBe(process.env.REGISTRY_EDITS_CHANNEL_ID);
  });
});
