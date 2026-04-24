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

vi.mock('../../server/src/db/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: () => ({ connect: async () => ({ query: vi.fn(), release: () => {} }) }),
}));

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
  vi.clearAllMocks();
  mockQuery.mockReset();
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

  it('coerces days_since_slack to an integer and falls back on null org_name', async () => {
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
    expect(rows[0].days_since_slack).toBe(8);
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

  it('posts a threaded reply + records the activity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();

    expect(result).toEqual({ candidates: 1, reminded: 1, failed: 0 });

    // Threaded reply — thread_ts is the review card's ts.
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, message, opts] = mockSendChannelMessage.mock.calls[0];
    expect(channel).toBe(REVIEW_CHANNEL);
    expect(message.thread_ts).toBe(REVIEW_TS);
    expect(message.text).toContain('Alpha Co');
    expect(message.text).toContain('8 days');
    expect(message.text).toMatch(/Reminder 1 of 3/);
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

  it('increments reminder_number across runs (uses reminder_count + 1 from the SQL)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate({ reminder_count: '2' })] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runAnnouncementReminderJob();
    const message = mockSendChannelMessage.mock.calls[0][1];
    expect(message.text).toMatch(/Reminder 3 of 3/);
  });

  it('Slack post failure: increments failed, no activity row written', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate()] });
    mockSendChannelMessage.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' });

    const { runAnnouncementReminderJob } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runAnnouncementReminderJob();
    expect(result).toMatchObject({ candidates: 1, reminded: 0, failed: 1 });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeUndefined();
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
  it('renders all the key fields in a Slack mrkdwn format', async () => {
    const { buildReminderText } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const text = buildReminderText({
      orgName: 'Summit Foods',
      daysSinceSlack: 12,
      reminderNumber: 2,
      max: 3,
    });
    expect(text).toContain('*Summit Foods*');
    expect(text).toContain('12 days');
    expect(text).toMatch(/Reminder 2 of 3/);
    // Link to admin backlog in Slack's <url|label> format.
    expect(text).toMatch(/<https:\/\/[^|>]+\/admin\/announcements\|the admin backlog>/);
  });
});
