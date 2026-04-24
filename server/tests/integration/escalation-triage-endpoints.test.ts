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

  async function seedSuggestion(escalationId: number, status: 'resolved' | 'keep_open') {
    const res = await query<{ id: number }>(
      `INSERT INTO escalation_triage_suggestions
         (escalation_id, suggested_status, confidence, bucket, reasoning, evidence)
       VALUES ($1, $2, 'medium', 'bug', 'test reasoning', '[]'::jsonb)
       RETURNING id`,
      [escalationId, status],
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
