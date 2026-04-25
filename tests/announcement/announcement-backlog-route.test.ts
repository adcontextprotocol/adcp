/**
 * HTTP route tests for `GET /api/admin/announcements`.
 *
 * Shape + count tests; the underlying `loadAnnouncementBacklog` is
 * mocked out (its query shape is covered in `announcement-backlog.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import request from 'supertest';

process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const { mockLoadAnnouncementBacklog } = vi.hoisted(() => ({
  mockLoadAnnouncementBacklog: vi.fn<any>(),
}));

vi.mock('../../server/src/addie/jobs/announcement-handlers.js', () => ({
  loadAnnouncementBacklog: (...args: unknown[]) => mockLoadAnnouncementBacklog(...args),
}));

vi.mock('../../server/src/middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user_admin_01', email: 'admin@test', is_admin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../server/src/db/client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ query: vi.fn() }),
}));

async function buildApp() {
  const { setupAnnouncementsRoutes } = await import('../../server/src/routes/admin/announcements.js');
  const app = express();
  app.use(express.json());
  const pageRouter = Router();
  const apiRouter = Router();
  setupAnnouncementsRoutes(pageRouter, apiRouter);
  app.use('/api/admin', apiRouter);
  return app;
}

beforeEach(() => {
  // Clears the module cache so each test's await import() inside buildApp()
  // gets a fresh module instance. vi.clearAllMocks() resets call history but
  // not the module registry — without this the cached instance from a prior
  // test carries stale mock implementations into the next test.
  vi.resetModules();
  vi.clearAllMocks();
  // mockReset drains the mockResolvedValueOnce queue; clearAllMocks alone
  // does not, so an unconsumed Once value from a failed test would bleed.
  mockLoadAnnouncementBacklog.mockReset();
});

describe('GET /api/admin/announcements', () => {
  const base = {
    membership_tier: 'builder',
    profile_slug: 'org',
    review_channel_id: 'C0',
    review_message_ts: '1.1',
    visual_source: 'brand_logo',
    is_backfill: false,
  };

  it('returns rows with state buckets + counts', async () => {
    mockLoadAnnouncementBacklog.mockResolvedValueOnce([
      { ...base, organization_id: 'org_1', org_name: 'O1',
        draft_posted_at: new Date('2026-04-01T12:00:00Z'),
        slack_posted_at: null, linkedin_marked_at: null, skipped_at: null,
        slack_posted: false, linkedin_posted: false, skipped: false },
      { ...base, organization_id: 'org_2', org_name: 'O2',
        draft_posted_at: new Date(),
        slack_posted_at: new Date(), linkedin_marked_at: null, skipped_at: null,
        slack_posted: true, linkedin_posted: false, skipped: false },
      { ...base, organization_id: 'org_3', org_name: 'O3',
        draft_posted_at: new Date(),
        slack_posted_at: new Date(), linkedin_marked_at: new Date(), skipped_at: null,
        slack_posted: true, linkedin_posted: true, skipped: false },
      { ...base, organization_id: 'org_4', org_name: 'O4',
        draft_posted_at: new Date(),
        slack_posted_at: null, linkedin_marked_at: null, skipped_at: new Date(),
        slack_posted: false, linkedin_posted: false, skipped: true },
    ]);

    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.status).toBe(200);

    expect(res.body.counts).toEqual({
      all: 4,
      pending_review: 1,
      li_pending: 1,
      done: 1,
      skipped: 1,
    });

    const byOrg = Object.fromEntries(res.body.rows.map((r: any) => [r.organization_id, r]));
    expect(byOrg.org_1.state).toBe('pending_review');
    expect(byOrg.org_2.state).toBe('li_pending');
    expect(byOrg.org_3.state).toBe('done');
    expect(byOrg.org_4.state).toBe('skipped');
  });

  it('skipped takes precedence over partial channel posts (defensive)', async () => {
    mockLoadAnnouncementBacklog.mockResolvedValueOnce([
      {
        ...base,
        organization_id: 'org_X',
        org_name: 'X',
        draft_posted_at: new Date(),
        slack_posted_at: new Date(),
        linkedin_marked_at: null,
        skipped_at: new Date(),
        slack_posted: true,
        linkedin_posted: false,
        skipped: true,
      },
    ]);

    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.body.rows[0].state).toBe('skipped');
  });

  it('returns ISO-format date strings, not Date objects', async () => {
    const when = new Date('2026-04-01T12:00:00Z');
    const orgCreated = new Date('2024-06-15T10:00:00Z');
    mockLoadAnnouncementBacklog.mockResolvedValueOnce([
      {
        ...base,
        organization_id: 'org_A',
        org_name: 'A',
        org_created_at: orgCreated,
        draft_posted_at: when,
        slack_posted_at: when,
        linkedin_marked_at: null,
        skipped_at: null,
        slack_posted: true,
        linkedin_posted: false,
        skipped: false,
      },
    ]);

    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.body.rows[0].draft_posted_at).toBe('2026-04-01T12:00:00.000Z');
    expect(res.body.rows[0].slack_posted_at).toBe('2026-04-01T12:00:00.000Z');
    expect(res.body.rows[0].linkedin_marked_at).toBeNull();
    // Signup-age column reads org_created_at. Null safe when the org
    // row was deleted (orphan draft).
    expect(res.body.rows[0].org_created_at).toBe('2024-06-15T10:00:00.000Z');
  });

  it('org_created_at is null when backlog row lacks it', async () => {
    mockLoadAnnouncementBacklog.mockResolvedValueOnce([
      {
        ...base,
        organization_id: 'org_ORPHAN',
        org_name: 'org_ORPHAN',
        org_created_at: null,
        draft_posted_at: new Date(),
        slack_posted_at: null,
        linkedin_marked_at: null,
        skipped_at: null,
        slack_posted: false,
        linkedin_posted: false,
        skipped: false,
      },
    ]);
    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.body.rows[0].org_created_at).toBeNull();
  });

  it('500 on backend failure', async () => {
    mockLoadAnnouncementBacklog.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.status).toBe(500);
  });

  it('empty result returns zero counts + empty rows', async () => {
    mockLoadAnnouncementBacklog.mockResolvedValueOnce([]);
    const app = await buildApp();
    const res = await request(app).get('/api/admin/announcements');
    expect(res.body).toEqual({
      counts: { all: 0, pending_review: 0, li_pending: 0, done: 0, skipped: 0 },
      rows: [],
    });
  });
});
