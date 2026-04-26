import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import request from 'supertest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Integration coverage for the accept / reject flow.
 *
 * The pure classifier is unit-tested. These cases exist because the
 * accept handler is the only place where a suggestion actually mutates
 * the underlying escalation — two DB writes that must stay in sync,
 * plus the 409 double-apply guard that unit tests can't exercise
 * without a real table.
 */
// Mock the GitHub filer so we don't actually hit api.github.com in tests.
// A single hoisted spy lets each test drive the success / failure path.
const mocks = vi.hoisted(() => ({
  fileGitHubIssue: vi.fn(),
}));
vi.mock('../../src/addie/jobs/github-filer.js', () => ({
  fileGitHubIssue: mocks.fileGitHubIssue,
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = {
      id: 'user_test_admin',
      email: 'triage-tester@test.com',
      is_admin: true,
    };
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Stripe is mocked in other integration tests to avoid the billing init path.
vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

describe('Escalation triage endpoints', () => {
  let server: HTTPServer;
  let app: unknown;

  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();

    server = new HTTPServer();
    await server.start(0);
    app = server.app;
  });

  afterAll(async () => {
    await query('DELETE FROM escalation_triage_suggestions WHERE TRUE');
    await query("DELETE FROM addie_escalations WHERE user_email = 'triage-test@example.com'");
    await server?.stop();
    await closeDatabase();
  });

  beforeEach(async () => {
    await query('DELETE FROM escalation_triage_suggestions WHERE TRUE');
    await query("DELETE FROM addie_escalations WHERE user_email = 'triage-test@example.com'");
    mocks.fileGitHubIssue.mockReset();
  });

  async function seedOpenEscalation(summary: string): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO addie_escalations (category, summary, user_email, status)
       VALUES ('needs_human_action', $1, 'triage-test@example.com', 'open')
       RETURNING id`,
      [summary],
    );
    return res.rows[0].id;
  }

  async function seedSuggestion(escalationId: number, status: 'resolved' | 'keep_open' | 'file_as_issue') {
    const draft = status === 'file_as_issue'
      ? { title: 'Bug: /page is broken', body: 'draft body', repo: 'adcontextprotocol/adcp', labels: ['from-escalation'] }
      : null;
    const res = await query<{ id: number }>(
      `INSERT INTO escalation_triage_suggestions
         (escalation_id, suggested_status, confidence, bucket, reasoning, evidence, proposed_github_issue)
       VALUES ($1, $2, 'medium', 'bug', 'test reasoning', '[]'::jsonb, $3::jsonb)
       RETURNING id`,
      [escalationId, status, draft ? JSON.stringify(draft) : null],
    );
    return res.rows[0].id;
  }

  it('accept applies the suggested status to the escalation and marks the suggestion accepted', async () => {
    const eid = await seedOpenEscalation('Bug: /some-page returns 404');
    const sid = await seedSuggestion(eid, 'resolved');

    const res = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.suggestion.decision).toBe('accepted');
    expect(res.body.suggestion.reviewed_by).toBe('triage-tester@test.com');
    expect(res.body.escalation.status).toBe('resolved');
    expect(res.body.escalation.resolution_notes).toMatch(/Triage suggestion #/);
  });

  it('409s on double-accept', async () => {
    const eid = await seedOpenEscalation('Bug: /page-two 500s');
    const sid = await seedSuggestion(eid, 'resolved');

    const first = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.decision).toBe('accepted');
  });

  it('keep_open suggestion marks decision without mutating the escalation', async () => {
    const eid = await seedOpenEscalation('Something still-active');
    const sid = await seedSuggestion(eid, 'keep_open');

    const res = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.suggestion.decision).toBe('accepted');
    expect(res.body.escalation).toBeUndefined();

    const esc = await query<{ status: string }>(
      `SELECT status FROM addie_escalations WHERE id = $1`,
      [eid],
    );
    expect(esc.rows[0].status).toBe('open');
  });

  it('reject marks rejected without touching the escalation', async () => {
    const eid = await seedOpenEscalation('Ops task noise');
    const sid = await seedSuggestion(eid, 'resolved');

    const res = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/reject`)
      .send({ notes: 'false positive' });

    expect(res.status).toBe(200);
    expect(res.body.suggestion.decision).toBe('rejected');
    expect(res.body.suggestion.decision_notes).toBe('false positive');

    const esc = await query<{ status: string }>(
      `SELECT status FROM addie_escalations WHERE id = $1`,
      [eid],
    );
    expect(esc.rows[0].status).toBe('open');
  });

  it('accept on file_as_issue files the issue, records it on the escalation, and resolves', async () => {
    mocks.fileGitHubIssue.mockResolvedValue({
      url: 'https://github.com/adcontextprotocol/adcp/issues/4242',
      number: 4242,
      repo: 'adcontextprotocol/adcp',
    });
    const eid = await seedOpenEscalation('Bug: /some-page 404s');
    const sid = await seedSuggestion(eid, 'file_as_issue');

    const res = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.issue?.url).toBe('https://github.com/adcontextprotocol/adcp/issues/4242');
    expect(res.body.escalation.status).toBe('resolved');
    expect(res.body.escalation.github_issue_url).toBe('https://github.com/adcontextprotocol/adcp/issues/4242');
    expect(res.body.escalation.github_issue_number).toBe(4242);
    expect(res.body.escalation.resolution_notes).toMatch(/Filed as https:\/\/github.com\/adcontextprotocol\/adcp\/issues\/4242/);
    expect(mocks.fileGitHubIssue).toHaveBeenCalledTimes(1);
  });

  it('502s on GitHub API failure and leaves the escalation + suggestion open for retry', async () => {
    mocks.fileGitHubIssue.mockResolvedValue(null);
    const eid = await seedOpenEscalation('Bug: /some-page 404s');
    const sid = await seedSuggestion(eid, 'file_as_issue');

    const res = await request(app as never)
      .post(`/api/admin/addie/escalations/suggestions/${sid}/accept`)
      .send({});

    expect(res.status).toBe(502);
    const esc = await query<{ status: string; github_issue_url: string | null }>(
      `SELECT status, github_issue_url FROM addie_escalations WHERE id = $1`,
      [eid],
    );
    expect(esc.rows[0].status).toBe('open');
    expect(esc.rows[0].github_issue_url).toBeNull();

    // Reservation is released so a retry can claim it.
    const sug = await query<{ decision: string | null }>(
      `SELECT decision FROM escalation_triage_suggestions WHERE id = $1`,
      [sid],
    );
    expect(sug.rows[0].decision).toBeNull();
  });

  it('concurrent accepts on a file_as_issue suggestion file exactly one GitHub issue', async () => {
    // Simulate two admins hitting accept at nearly the same moment.
    // The atomic reservation on recordDecision should serialise them
    // so only one call reaches fileGitHubIssue.
    mocks.fileGitHubIssue.mockResolvedValue({
      url: 'https://github.com/adcontextprotocol/adcp/issues/9001',
      number: 9001,
      repo: 'adcontextprotocol/adcp',
    });
    const eid = await seedOpenEscalation('Bug: /race 404s');
    const sid = await seedSuggestion(eid, 'file_as_issue');

    const [a, b] = await Promise.all([
      request(app as never).post(`/api/admin/addie/escalations/suggestions/${sid}/accept`).send({}),
      request(app as never).post(`/api/admin/addie/escalations/suggestions/${sid}/accept`).send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(mocks.fileGitHubIssue).toHaveBeenCalledTimes(1);
  });

  it('GET /escalations/suggestions matches the literal path and does not shadow into the :id handler', async () => {
    const eid = await seedOpenEscalation('For listing');
    await seedSuggestion(eid, 'resolved');

    const res = await request(app as never)
      .get('/api/admin/addie/escalations/suggestions?pending_only=true');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.pending).toBeGreaterThanOrEqual(1);
  });
});
