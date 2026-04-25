/**
 * Tests for Workflow B Stage 4 — retroactive announcement backfill.
 *
 * - CLI arg parsing for the standalone script
 * - `findAnnounceCandidates({ requireProfilePublished: false })` includes
 *   orgs that went public before the event emit
 * - `runBackfillAnnouncements` respects `limit`, supports `dry-run` (no
 *   Slack call, no activity write), tags drafts with `[BACKFILL]`
 * - Error shape: empty editorial channel → returns `{drafted:0}` not throw
 */
import { describe, it, test, expect, vi, beforeEach } from 'vitest';

const {
  mockQuery,
  mockSendChannelMessage,
  mockDeleteChannelMessage,
  mockDraftAnnouncement,
  mockResolveVisual,
} = vi.hoisted(() => ({
  mockQuery: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
  mockDeleteChannelMessage: vi.fn<any>(),
  mockDraftAnnouncement: vi.fn<any>(),
  mockResolveVisual: vi.fn<any>(),
}));

// The backfill path opens a pooled client to hold the advisory lock.
// In tests we route lock acquire/release through a simple flag so a
// second call in the same test returns "already held" when we want to
// simulate a concurrent run.
let lockHeld = false;
let lockAcquireReturnsFalse = false;

vi.mock('../../server/src/db/client.js', () => {
  const fakeClient = {
    query: (sql: unknown, params?: unknown[]) => {
      if (typeof sql === 'string') {
        if (sql.startsWith('SELECT pg_try_advisory_lock')) {
          if (lockAcquireReturnsFalse) {
            return Promise.resolve({ rows: [{ pg_try_advisory_lock: false }] });
          }
          lockHeld = true;
          return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
        }
        if (sql.startsWith('SELECT pg_advisory_unlock')) {
          lockHeld = false;
          return Promise.resolve({ rows: [] });
        }
      }
      return mockQuery(sql, params);
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
  deleteChannelMessage: (...args: unknown[]) => mockDeleteChannelMessage(...args),
}));

vi.mock('../../server/src/services/announcement-drafter.js', () => ({
  draftAnnouncement: (...args: unknown[]) => mockDraftAnnouncement(...args),
}));

vi.mock('../../server/src/services/announcement-visual.js', () => ({
  resolveAnnouncementVisual: (...args: unknown[]) => mockResolveVisual(...args),
  isSafeVisualUrl: () => true,
  AAO_FALLBACK_VISUAL_URL: 'https://agenticadvertising.org/AAo-social.png',
}));

const ORG_A = {
  workos_organization_id: 'org_AAA',
  org_name: 'Alpha Co',
  membership_tier: 'company_standard',
  profile_id: 'p1',
  display_name: 'Alpha Co',
  slug: 'alpha',
  tagline: null,
  description: null,
  offerings: null,
  primary_brand_domain: 'alpha.example',
  brand_manifest: { agents: [] },
  last_published_at: null,
};

const ORG_B = {
  ...ORG_A,
  workos_organization_id: 'org_BBB',
  org_name: 'Beta Co',
  slug: 'beta',
  primary_brand_domain: 'beta.example',
};

beforeEach(() => {
  // Clears the module cache so each test's await import() below gets a fresh
  // module instance. vi.clearAllMocks() resets call history but not the module
  // registry — without this the cached instance from a prior test carries stale
  // mock implementations into the next test.
  vi.resetModules();
  vi.clearAllMocks();
  mockQuery.mockReset();
  lockHeld = false;
  lockAcquireReturnsFalse = false;
  mockDraftAnnouncement.mockResolvedValue({
    slackText: 'Welcome.',
    linkedinText: 'Welcome.\n\n#AAO',
  });
  mockResolveVisual.mockResolvedValue({
    url: 'https://agenticadvertising.org/AAo-social.png',
    altText: 'AAO',
    source: 'aao_fallback',
  });
  mockSendChannelMessage.mockResolvedValue({ ok: true, ts: '1700000000.001' });
  mockDeleteChannelMessage.mockResolvedValue({ ok: true });
});

describe('findAnnounceCandidates — requireProfilePublished option', () => {
  it('default: SQL includes the profile_published EXISTS clause', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { findAnnounceCandidates } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await findAnnounceCandidates();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM org_activities[\s\S]+activity_type = 'profile_published'/);
  });

  it('requireProfilePublished:false: SQL omits the profile_published EXISTS clause', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { findAnnounceCandidates } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await findAnnounceCandidates({ requireProfilePublished: false });
    const sql = mockQuery.mock.calls[0][0] as string;
    // The outer NOT EXISTS (for already-drafted/skipped) mentions the
    // activity_type IN (...) predicate — but no standalone profile_published
    // EXISTS should appear.
    expect(sql).not.toMatch(/\bEXISTS\s*\(\s*SELECT 1 FROM org_activities[\s\S]*activity_type = 'profile_published'/);
    // Still has the NOT EXISTS guarding against duplicate drafts.
    expect(sql).toMatch(/NOT EXISTS[\s\S]+activity_type IN \('announcement_draft_posted', 'announcement_skipped'\)/);
  });

  it('sort order: last_published_at DESC NULLS LAST, then created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { findAnnounceCandidates } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await findAnnounceCandidates({ requireProfilePublished: false });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/ORDER BY last_published_at DESC NULLS LAST,\s*o\.created_at DESC/);
  });
});

describe('buildReviewBlocks — backfill flag', () => {
  it('tags header with [BACKFILL] when backfill:true', async () => {
    const { buildReviewBlocks } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const { text, blocks } = buildReviewBlocks({
      orgName: 'Alpha Co',
      workosOrganizationId: 'org_AAA',
      slackText: 'hi',
      linkedinText: 'hi',
      visual: { url: 'https://example/a.png', altText: 'a', source: 'aao_fallback' },
      profileSlug: 'alpha',
      backfill: true,
    });
    expect(text).toContain('[BACKFILL]');
    const header = blocks.find((b) => b.type === 'header');
    expect(header?.text?.text).toMatch(/^\[BACKFILL\]/);
  });

  it('no tag when backfill:false (default)', async () => {
    const { buildReviewBlocks } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const { blocks } = buildReviewBlocks({
      orgName: 'Alpha Co',
      workosOrganizationId: 'org_AAA',
      slackText: 'hi',
      linkedinText: 'hi',
      visual: { url: 'https://example/a.png', altText: 'a', source: 'aao_fallback' },
      profileSlug: 'alpha',
    });
    const header = blocks.find((b) => b.type === 'header');
    expect(header?.text?.text).not.toMatch(/BACKFILL/);
  });
});

describe('runBackfillAnnouncements', () => {
  test('dry-run: no Slack calls, no activity writes; reports candidates', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A, ORG_B] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(2);
    expect(result.wouldDraft?.map((r) => r.workos_organization_id)).toEqual([
      'org_AAA',
      'org_BBB',
    ]);
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
    expect(mockDraftAnnouncement).not.toHaveBeenCalled();
    // Strict: dry-run issues exactly one SQL through the pool-less
    // `query` mock (the SELECT). No INSERT, no secondary reads.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('respects limit: picks first N by sort order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A, ORG_B] });
    // Draft + resolve mocks already set; INSERT activity write:
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      limit: 1,
    });

    expect(result.candidates).toBe(2);
    expect(result.drafted).toBe(1);
    // N draft posts + 1 summary message = N+1 total.
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(2);
    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.backfill).toBe(true);
    expect(metadata.org_name).toBe('Alpha Co');
  });

  test('default limit is 15', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      ...ORG_A,
      workos_organization_id: `org_${String(i).padStart(3, '0')}`,
      org_name: `Org ${i}`,
      slug: `org-${i}`,
    }));
    mockQuery.mockResolvedValueOnce({ rows: twenty });
    // 15 successful INSERTs:
    for (let i = 0; i < 15; i++) mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
    });

    expect(result.candidates).toBe(20);
    expect(result.drafted).toBe(15);
    // 15 drafts + 1 summary
    expect(mockSendChannelMessage).toHaveBeenCalledTimes(16);
  });

  test('backfill rows include `backfill: true` in recorded metadata', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: any) => typeof sql === 'string' && sql.startsWith('INSERT INTO org_activities'),
    );
    const metadata = JSON.parse(insertCall![1][2]);
    expect(metadata.backfill).toBe(true);
  });

  test('handles candidate-load failure without throwing', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(result.candidates).toBe(0);
    expect(result.drafted).toBe(0);
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('unwinds Slack post when activity write fails (shared with live flow)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A] });
    // INSERT fails:
    mockQuery.mockRejectedValueOnce(new Error('db write failed'));

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(mockSendChannelMessage).toHaveBeenCalledTimes(1);
    // Slack post succeeded then activity write threw — chat.delete unwinds.
    expect(mockDeleteChannelMessage).toHaveBeenCalledWith('C0REVIEW01', '1700000000.001');
    expect(result.drafted).toBe(0);
    expect(result.failed).toBe(1);
  });

  test('dry-run preview rows include tier, domain, last_published_at', async () => {
    const published = new Date('2026-03-15T12:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ORG_A, membership_tier: 'builder', last_published_at: published }],
    });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      dryRun: true,
    });

    expect(result.wouldDraft).toEqual([
      {
        workos_organization_id: 'org_AAA',
        org_name: 'Alpha Co',
        membership_tier: 'builder',
        primary_brand_domain: 'alpha.example',
        last_published_at: published,
      },
    ]);
  });

  test('--force off: --limit above soft cap gets clamped to BACKFILL_SOFT_CAP', async () => {
    const { runBackfillAnnouncements, BACKFILL_SOFT_CAP } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      limit: 9999,
      dryRun: true,
    });

    expect(result.effectiveLimit).toBe(BACKFILL_SOFT_CAP);
  });

  test('--force on: --limit above soft cap passes through but still capped at absolute max', async () => {
    const { runBackfillAnnouncements, BACKFILL_ABSOLUTE_MAX } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      limit: 9999,
      force: true,
      dryRun: true,
    });

    expect(result.effectiveLimit).toBe(BACKFILL_ABSOLUTE_MAX);
  });

  test('advisory lock held by another run → refuses with lockedOut:true', async () => {
    lockAcquireReturnsFalse = true;
    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({
      reviewChannel: 'C0REVIEW01',
      dryRun: true,
    });

    expect(result.lockedOut).toBe(true);
    expect(result.candidates).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled(); // no SELECT on orgs
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  test('summary message: posted when drafted > 0, skipped when drafted == 0', async () => {
    // Run 1: 1 draft succeeds → summary should be posted.
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    const summaryCall = mockSendChannelMessage.mock.calls.find(
      ([, msg]: any) => typeof msg?.text === 'string' && msg.text.includes('Backfill wave posted'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toBe('C0REVIEW01');
  });

  test('summary message: skipped when no drafts succeeded', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // zero candidates

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    const summaryCall = mockSendChannelMessage.mock.calls.find(
      ([, msg]: any) => typeof msg?.text === 'string' && msg.text.includes('Backfill wave posted'),
    );
    expect(summaryCall).toBeUndefined();
  });

  test('drafted_orgs is populated on the live run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(result.drafted_orgs).toEqual([
      {
        workos_organization_id: 'org_AAA',
        org_name: 'Alpha Co',
        membership_tier: 'company_standard',
        primary_brand_domain: 'alpha.example',
        last_published_at: null,
      },
    ]);
  });

  test('rich fixture: drafter receives parsed agents from brand_manifest', async () => {
    const rich = {
      ...ORG_A,
      tagline: 'We build buyer agents for small DSPs.',
      brand_manifest: {
        brands: [
          {
            agents: [
              { type: 'buyer_agent', description: 'small DSP' },
              { type: 'signals_agent' },
            ],
          },
        ],
      },
    };
    mockQuery.mockResolvedValueOnce({ rows: [rich] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    const draftCall = mockDraftAnnouncement.mock.calls[0][0];
    expect(draftCall.tagline).toBe('We build buyer agents for small DSPs.');
    expect(draftCall.agents).toEqual([
      { type: 'buyer_agent', description: 'small DSP' },
      { type: 'signals_agent', description: null },
    ]);
  });

  test('delete unwind that returns {ok:false} is logged but does not throw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A] });
    // INSERT fails:
    mockQuery.mockRejectedValueOnce(new Error('db write failed'));
    // Unwind reports failure:
    mockDeleteChannelMessage.mockResolvedValueOnce({ ok: false, error: 'message_not_found' });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(result.failed).toBe(1);
    expect(result.drafted).toBe(0);
  });

  test('delete unwind that throws is caught and does not stop the run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A, ORG_B] });
    mockQuery.mockRejectedValueOnce(new Error('db write failed')); // ORG_A insert
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ORG_B insert succeeds
    mockDeleteChannelMessage.mockRejectedValueOnce(new Error('slack 5xx')); // unwind throws

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(result.failed).toBe(1);
    expect(result.drafted).toBe(1); // ORG_B still drafted despite ORG_A's unwind throw
  });

  test('post failure for one candidate does not stop the rest', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ORG_A, ORG_B] });
    // First send fails, second succeeds:
    mockSendChannelMessage
      .mockResolvedValueOnce({ ok: false, error: 'channel_not_found' })
      .mockResolvedValueOnce({ ok: true, ts: '1700000000.002' });
    // Only one activity write (for the successful post):
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { runBackfillAnnouncements } = await import('../../server/src/addie/jobs/announcement-trigger.js');
    const result = await runBackfillAnnouncements({ reviewChannel: 'C0REVIEW01' });

    expect(result.drafted).toBe(1);
    expect(result.failed).toBe(1);
  });
});

describe('parseArgs (backfill script CLI)', () => {
  test('defaults: limit=15 dry-run=false force=false', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs([])).toEqual({ limit: 15, dryRun: false, force: false });
  });

  test('--limit N', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs(['--limit', '5'])).toEqual({ limit: 5, dryRun: false, force: false });
  });

  test('--limit=N', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs(['--limit=7'])).toEqual({ limit: 7, dryRun: false, force: false });
  });

  test('--dry-run', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs(['--dry-run'])).toEqual({ limit: 15, dryRun: true, force: false });
  });

  test('--force', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs(['--force'])).toEqual({ limit: 15, dryRun: false, force: true });
  });

  test('combined', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(parseArgs(['--dry-run', '--limit', '3'])).toEqual({
      limit: 3,
      dryRun: true,
      force: false,
    });
  });

  test('--limit with non-integer throws', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(() => parseArgs(['--limit', 'foo'])).toThrow(/positive integer/);
  });

  test('--limit with zero throws', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
  });

  test('unknown flag throws', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });

  test('--help throws a marker', async () => {
    const { parseArgs } = await import('../../server/src/scripts/backfill-member-announcements.js');
    expect(() => parseArgs(['--help'])).toThrow(/--help/);
  });
});
