/**
 * Query-shape tests for `loadAnnouncementBacklog` — the function that
 * feeds the /admin/announcements page. No supertest here; the HTTP
 * route is covered in `announcement-backlog-route.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// announcement-handlers → mcp/admin-tools → workos-client (throws on module
// load without these). vi.hoisted runs before the static imports below so
// the env vars are set when the WorkOS client is instantiated. Dummy values
// satisfy the guard; nothing here actually calls WorkOS.
const { mockQuery } = vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  return { mockQuery: vi.fn<any>() };
});

vi.mock('../../server/src/db/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { loadAnnouncementBacklog } from '../../server/src/addie/jobs/announcement-handlers.js';

beforeEach(() => {
  mockQuery.mockReset();
  // Safety net — without this a `mockResolvedValueOnce` consumed
  // by a prior test's overlap would leave a subsequent call returning
  // `undefined` (→ TypeError or timeout). Tests that care always
  // stack their own mockResolvedValueOnce on top.
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('loadAnnouncementBacklog', () => {
  it('returns one row per org with flags derived from the subquery join', async () => {
    const draftedAt = new Date('2026-04-01T12:00:00Z');
    const slackAt = new Date('2026-04-01T13:00:00Z');
    const liAt = new Date('2026-04-02T09:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          organization_id: 'org_AAA',
          org_name: 'Alpha Co',
          membership_tier: 'builder',
          profile_slug: 'alpha',
          draft_posted_at: draftedAt,
          review_channel_id: 'C0REVIEW01',
          review_message_ts: '1700000000.001',
          visual_source: 'brand_logo',
          is_backfill: false,
          slack_posted_at: slackAt,
          linkedin_marked_at: liAt,
          skipped_at: null,
        },
        {
          organization_id: 'org_BBB',
          org_name: 'Beta Co',
          membership_tier: null,
          profile_slug: null,
          draft_posted_at: draftedAt,
          review_channel_id: 'C0REVIEW01',
          review_message_ts: '1700000000.002',
          visual_source: 'aao_fallback',
          is_backfill: true,
          slack_posted_at: null,
          linkedin_marked_at: null,
          skipped_at: new Date('2026-04-02T10:00:00Z'),
        },
      ],
    });

    const rows = await loadAnnouncementBacklog();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organization_id: 'org_AAA',
      slack_posted: true,
      linkedin_posted: true,
      skipped: false,
      is_backfill: false,
    });
    expect(rows[1]).toMatchObject({
      organization_id: 'org_BBB',
      slack_posted: false,
      linkedin_posted: false,
      skipped: true,
      is_backfill: true,
    });
  });

  it('coerces non-boolean is_backfill to false (legacy rows)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          organization_id: 'org_X',
          org_name: 'X',
          membership_tier: null,
          profile_slug: null,
          draft_posted_at: new Date(),
          review_channel_id: 'C0',
          review_message_ts: null,
          visual_source: null,
          is_backfill: null,
          slack_posted_at: null,
          linkedin_marked_at: null,
          skipped_at: null,
        },
      ],
    });
    const rows = await loadAnnouncementBacklog();
    expect(rows[0].is_backfill).toBe(false);
  });

  it('SQL uses DISTINCT ON per organization so one draft per org returned', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await loadAnnouncementBacklog();
    const sql = mockQuery.mock.calls[0][0] as string;
    // Four DISTINCT ON (organization_id) clauses: latest_draft, slack_pub,
    // li_pub, skipped — locks the per-org collapse into the snapshot shape.
    expect((sql.match(/DISTINCT ON \(organization_id\)/g) ?? []).length).toBe(4);
    expect(sql).toMatch(/ORDER BY ld\.draft_posted_at DESC/);
  });

  it('empty query returns empty array (happy zero-case)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const rows = await loadAnnouncementBacklog();
    expect(rows).toEqual([]);
  });

  it('SQL LEFT-JOINs organizations so orphan drafts still surface', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await loadAnnouncementBacklog();
    const sql = mockQuery.mock.calls[0][0] as string;
    // INNER JOIN on organizations would silently drop orphan drafts
    // (org deleted after draft was posted). LEFT JOIN + the ?? fallback
    // in the mapper keep them visible to editorial.
    expect(sql).toMatch(/LEFT JOIN organizations o/);
  });

  it('exposes org_created_at so the UI can render signup-age', async () => {
    const orgCreated = new Date('2024-06-15T10:00:00Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          organization_id: 'org_AAA',
          org_name: 'Alpha Co',
          membership_tier: 'builder',
          profile_slug: 'alpha',
          org_created_at: orgCreated,
          draft_posted_at: new Date(),
          visual_source: 'brand_logo',
          is_backfill: false,
          slack_posted_at: null,
          linkedin_marked_at: null,
          skipped_at: null,
        },
      ],
    });
    const rows = await loadAnnouncementBacklog();
    expect(rows[0].org_created_at).toEqual(orgCreated);
  });

  it('org_created_at is null when the org row was deleted (orphan draft)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          organization_id: 'org_GONE',
          org_name: null,
          membership_tier: null,
          profile_slug: null,
          org_created_at: null,
          draft_posted_at: new Date(),
          visual_source: null,
          is_backfill: false,
          slack_posted_at: null,
          linkedin_marked_at: null,
          skipped_at: null,
        },
      ],
    });
    const rows = await loadAnnouncementBacklog();
    expect(rows[0].org_created_at).toBeNull();
  });

  it('falls back to organization_id when the joined org row is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          organization_id: 'org_DELETED',
          org_name: null, // LEFT JOIN returned no org row
          membership_tier: null,
          profile_slug: null,
          org_created_at: null,
          draft_posted_at: new Date(),
          visual_source: null,
          is_backfill: false,
          slack_posted_at: null,
          linkedin_marked_at: null,
          skipped_at: null,
        },
      ],
    });
    const rows = await loadAnnouncementBacklog();
    expect(rows[0].org_name).toBe('org_DELETED');
  });
});
