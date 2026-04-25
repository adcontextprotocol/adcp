/**
 * Tests for `runAnnouncementReminderJob` + `findStaleLiCandidates`.
 *
 * Covers: SQL parameter shape (the rate-limit + cap are SQL-enforced,
 * not client-enforced), happy-path threaded reply + activity write,
 * post-failure isolation, activity-write failure degrades to "will
 * re-ping next run" (not a hard error), empty candidate list short-
 * circuits cleanly, reminder text formatting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const { mockQuery, mockSendChannelMessage } = vi.hoisted(() => ({
  mockQuery: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
}));

// The reminder job opens a pooled client for its advisory lock and
// acquire/release via pg_try_advisory_lock / pg_advisory_unlock.
let lockAcquireReturnsFalse = false;
vi.mock('../../server/src/db/client.js', () => {
  const fakeClient = {
    query: (sql: unknown, _params?: unknown[]) => {
      if (typeof sql === 'string') {
        if (sql.startsWith('SELECT pg_try_advisory_lock')) {
          return Promise.resolve({
            rows: [{ pg_try_advisory_lock: !lockAcquireReturnsFalse }],
          });
        }
        if (sql.startsWith('SELECT pg_advisory_unlock')) {
          return Promise.resolve({ rows: [] });
        }
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  };
  return {
    query: (...args: unknown[]) => mockQuery(...args),
    getPool: () => ({ connect: async () => fakeClient }),
  };
});

vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mockSendChannelMessage(...args),
  deleteChannelMessage: vi.fn(),
}));

vi.mock('../../server/src/services/announcement-drafter.js', () => ({
  draftAnnouncement: vi.fn(),
}));

vi.mock('../../server/src/services/announcement-visual.js', () => ({
  resolveAnnouncementVisual: vi.fn(),
  isSafeVisualUrl: () => true,
  AAO_FALLBACK_VISUAL_URL: '',
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getEditorialChannel: vi.fn().mockResolvedValue({ channel_id: null, channel_name: null }),
}));

const REVIEW_CHANNEL = 'C0EDITORIAL';
const REVIEW_TS = '1700000000.123';

function candidate(overrides: Partial<any> = {}) {
  return {
    workos_organization_id: 'org_ALPHA',
    org_name: 'Alpha Co',
    review_channel_id: REVIEW_CHANNEL,
    review_message_ts: REVIEW_TS,
    slack_posted_at: new Date('2026-04-01T12:00:00Z'),
    days_since_slack: '8.3',
    reminder_count: '0',
    last_reminder_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Under pool:'threads' (see vitest.config.ts), the module registry is shared
  // across concurrent test files. Without this, a cached module from another
  // thread bleeds into this file's await import() calls — causing stale-mock
  // TypeErrors that only appear under Conductor multi-workspace load.
  vi.resetModules();
  vi.clearAllMocks();
  mockQuery.mockReset();
  lockAcquireReturnsFalse = false;
  mockSendChannelMessage.mockResolvedValue({ ok: true, ts: '1700000000.999' });
});

describe('findStaleLiCandidates', () => {
  it('passes the cap + interval + stale-days as SQL parameters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const {
      findStaleLiCandidates,
      REMINDER_STALE_DAYS,
      REMINDER_INTERVAL_DAYS,
      MAX_REMINDERS_PER_ORG,
    } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await findStaleLiCandidates();

    const [, params] = mockQuery.mock.calls[0];
    // Rate-limit is SQL-enforced, not client-enforced; the test
    // pins the exact params so changes are visible in the diff.
    expect(params).toEqual([
      String(REMINDER_STALE_DAYS),
      String(REMINDER_INTERVAL_DAYS),
      MAX_REMINDERS_PER_ORG,
    ]);
  });

  it('SQL filters out orgs with a linkedin post or a skip row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { findStaleLiCandidates } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await findStaleLiCandidates();
    const sql = mockQuery.mock.calls[0][0] as string;
    // Both exclusion clauses are load-bearing — missing either
    // would produce reminders for already-finished or skipped orgs.
    expect(sql).toMatch(/li\.organization_id IS NULL/);
    expect(sql).toMatch(/sk\.organization_id IS NULL/);
    // Reminder cap enforced in SQL too, not just by client logic.
    expect(sql).toMatch(/COALESCE\(r\.reminder_count, 0\) < \$3/);
  });

  it('rounds days_since_slack and falls back on null org_name', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          workos_organization_id: 'org_GONE',
          org_name: null,
          review_channel_id: REVIEW_CHANNEL,
          review_message_ts: REVIEW_TS,
          slack_posted_at: new Date(),
          days_since_slack: '8.7',
          reminder_count: '1',
          last_reminder_at: new Date(),
        },
      ],
    });
    const { findStaleLiCandidates } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const rows = await findStaleLiCandidates();
    expect(rows[0].org_name).toBe('org_GONE');
    // 8.7 rounds to 9 — matches how an operator reads a duration,
    // and keeps the rendered reminder text intuitive ("9 days", not
    // "8 days") when the candidate crossed the threshold yesterday.
    expect(rows[0].days_since_slack).toBe(9);
    expect(rows[0].reminder_count).toBe(1);
  });
});

describe('runAnnouncementReminderJob', () => {
  it('empty candidate list: no Slack calls, no INSERTs, clean result', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toEqual({ candidates: 0, reminded: 0, failed: 0 });
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  it('refuses when another run holds the advisory lock', async () => {
    lockAcquireReturnsFalse = true;
    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result.lockedOut).toBe(true);
    expect(result.candidates).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  it('posts a threaded reply + records the activity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();

    expect(result).toMatchObject({ candidates: 1, reminded: 1, failed: 0 });

    // Threaded reply — thread_ts is the review card's ts.
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, message, opts] = mockSendChannelMessage.mock.calls[0];
    expect(channel).toBe(REVIEW_CHANNEL);
    expect(message.thread_ts).toBe(REVIEW_TS);
    expect(message.text).toContain('Alpha Co');
    expect(message.text).toContain('8 days');
    // The reminder number is recorded in the activity row but not
    // surfaced to editorial — "Reminder X of 3" reads as a countdown
    // to punishment in a community context.
    expect(message.text).not.toMatch(/Reminder \d+ of \d+/);
    expect(opts).toEqual({ requirePrivate: true });

    // Activity row with reminder_number and reply_ts.
    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata).toMatchObject({
      reminder_number: 1,
      days_stale: 8,
      reply_ts: '1700000000.999',
    });
  });

  it('records the reminder_number in metadata even though user-facing text does not mention it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate({ reminder_count: '2' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runAnnouncementReminderJob();
    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.reminder_number).toBe(3);
  });

  it('transient Slack failure: increments failed, no activity row (will retry next run)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockSendChannelMessage.mockResolvedValueOnce({ ok: false, error: 'rate_limited' });

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toMatchObject({ candidates: 1, reminded: 0, failed: 1 });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeUndefined();
  });

  it('terminal message_not_found: posts fresh non-threaded notice + records dead-parent row', async () => {
    // Review card deleted/archived — retrying the thread will never
    // succeed. Surface a non-threaded notice so editorial has a
    // signal + link to the admin backlog, then burn one of the three
    // slots so we stop retrying indefinitely.
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockSendChannelMessage
      .mockResolvedValueOnce({ ok: false, error: 'message_not_found' }) // failed thread reply
      .mockResolvedValueOnce({ ok: true, ts: '1700000000.555' }); // fresh notice
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT dead-parent

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toMatchObject({ candidates: 1, reminded: 0, failed: 1 });

    // Two Slack calls: the failed thread reply + the fresh notice.
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(2);
    const [, freshMessage] = mockSendChannelMessage.mock.calls[1];
    // Fresh notice is not threaded — editorial gets a top-level
    // message pointing at the admin backlog.
    expect(freshMessage.thread_ts).toBeUndefined();
    expect(freshMessage.text).toContain('Alpha Co');
    expect(freshMessage.text).toMatch(/admin\/announcements/);

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.failed).toBe('thread_parent_gone');
    expect(metadata.reply_ts).toBeUndefined();
  });

  it('activity-write failure: counts as reminded (Slack landed) but logs — next run may re-ping', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockQuery.mockRejectedValueOnce(new Error('db write failed'));

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    // Slack message is already sent; unwinding it would be bad UX
    // (deleting an admin-visible thread reply). We accept the edge
    // case that next run may re-ping this org early.
    expect(result.reminded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('per-candidate failure does not stop the batch', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        candidate({ workos_organization_id: 'org_A' }),
        candidate({ workos_organization_id: 'org_B' }),
      ],
    });
    mockSendChannelMessage
      .mockResolvedValueOnce({ ok: false, error: 'rate_limited' })
      .mockResolvedValueOnce({ ok: true, ts: '1.2' });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT for org_B

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toMatchObject({ candidates: 2, reminded: 1, failed: 1 });
  });

  it('candidate-load failure returns {0,0,0} instead of throwing', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db connection reset'));
    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toEqual({ candidates: 0, reminded: 0, failed: 0 });
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });
});

describe('buildReminderText', () => {
  it('renders org name, days since Slack, and admin backlog link', async () => {
    const { buildReminderText } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const text = buildReminderText({
      orgName: 'Summit Foods',
      daysSinceSlack: 12,
    });
    expect(text).toContain('*Summit Foods*');
    expect(text).toContain('12 days');
    // Neutral state-reporting tone: no "still waiting", no reminder
    // count, no countdown.
    expect(text).not.toMatch(/still waiting/i);
    expect(text).not.toMatch(/reminder \d+ of/i);
    // Link to admin backlog in Slack's <url|label> format.
    expect(text).toMatch(/<https:\/\/[^|>]+\/admin\/announcements\|the admin backlog>/);
  });

  it('escapes Slack mrkdwn formatting chars in org names so rendering stays correct', async () => {
    const { buildReminderText } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const text = buildReminderText({
      orgName: 'Foo*Bar_Inc',
      daysSinceSlack: 9,
    });
    // The org-name bold wrapper (`*...*`) must be the outer tokens;
    // inner formatting chars are prefixed with a zero-width space
    // (U+200B) so Slack treats them as literal.
    expect(text).toMatch(/\*Foo​\*Bar​_Inc\*/);
  });

  it('neutralizes Slack-link syntax + bare URL schemes so a hostile org name cannot phishing-link', async () => {
    // A WorkOS org name containing `<url|label>` would render as a
    // clickable Slack link; a bare `https://evil/` would auto-link.
    // Both paths have to be shut down.
    const { buildReminderText } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const text = buildReminderText({
      orgName: 'Acme<https://evil/|click>Co',
      daysSinceSlack: 9,
    });
    // The only `<url|label>` pair left is our own admin-backlog link.
    const explicitLinks = [...text.matchAll(/<https?:\/\/[^|>\s]+\|[^>]+>/g)];
    expect(explicitLinks).toHaveLength(1);
    expect(explicitLinks[0][0]).toMatch(/admin\/announcements/);
    // Bare URL from the org name would auto-link without the scheme
    // break. Assert the scheme is broken (Slack won't auto-link
    // `https:/​/…`).
    expect(text).not.toMatch(/https:\/\/evil/);
  });
});

describe('buildDeadParentText', () => {
  it('points editorial at the admin backlog + neutralizes hostile chars', async () => {
    const { buildDeadParentText } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const text = buildDeadParentText({
      orgName: 'Summit<https://evil|x>Foods',
      daysSinceSlack: 21,
    });
    // Admin backlog is the one link in the message.
    const links = [...text.matchAll(/<https?:\/\/[^|>\s]+\|[^>]+>/g)];
    expect(links).toHaveLength(1);
    expect(links[0][0]).toMatch(/admin\/announcements/);
    expect(text).toContain('21 days');
    // Bare URL scheme from the injected payload is broken.
    expect(text).not.toMatch(/https:\/\/evil/);
  });
});
