/** Private containment regression: mounted production routes, real auth id-swap and PostgreSQL. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => {
  process.env.WORKOS_WEBHOOK_SECRET = 'private-containment-test-secret';
  return {
    sessions: new Map<string, any>(),
    providerMemberships: new Map<string, any>(),
    sendInvitation: vi.fn(), getInvitation: vi.fn(), revokeInvitation: vi.fn(),
    listUsers: vi.fn(), list: vi.fn(), getUser: vi.fn(), create: vi.fn(), update: vi.fn(),
    createOrg: vi.fn(), invoice: vi.fn(), products: vi.fn(), coupon: vi.fn(),
    slackSync: vi.fn(), slackConfigured: false,
    jwtOutage: false,
  };
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  userManagement = {
    loadSealedSession: ({ sessionData }: any) => ({ authenticate: async () => {
      const user = mocks.sessions.get(sessionData);
      return { authenticated: true, user, accessToken: `test-access:${user.id}` };
    } }),
    listOrganizationMemberships: mocks.list,
    sendInvitation: mocks.sendInvitation, getInvitation: mocks.getInvitation, revokeInvitation: mocks.revokeInvitation,
    listUsers: mocks.listUsers,
    getUser: mocks.getUser,
    createOrganizationMembership: mocks.create,
    updateOrganizationMembership: mocks.update,
  };
  organizations = {
    createOrganization: mocks.createOrg,
    getOrganization: vi.fn(async (id: string) => ({ id, name: 'Acme Containment' })),
  };
  webhooks = { constructEvent: vi.fn().mockResolvedValue({}) };
} }));
vi.mock('../../src/auth/workos-client.js', async (original) => {
  const actual = await original<typeof import('../../src/auth/workos-client.js')>();
  const { WorkOS } = await import('@workos-inc/node');
  const instance = new WorkOS();
  return { ...actual, getWorkos: () => instance, getAuthorizationEnforcementWorkos: () => instance };
});
vi.mock('../../src/auth/workos-jwt.js', async (original) => ({
  ...await original<typeof import('../../src/auth/workos-jwt.js')>(),
  verifyWorkOSJWT: async (value: string) => {
    if (mocks.jwtOutage) throw Object.assign(new Error('JWKS unavailable'), { code: 'ECONNRESET' });
    return { sub: value.replace(/^test-access:/, ''), isM2M: false };
  },
}));
vi.mock('../../src/middleware/csrf.js', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../../src/middleware/rate-limit.js', async (original) => {
  const actual = await original<typeof import('../../src/middleware/rate-limit.js')>();
  const pass = (_req: any, _res: any, next: any) => next();
  return { ...actual, orgCreationRateLimiter: pass, brandCreationRateLimiter: pass,
    memberProfileBootstrapRateLimiter: pass };
});
vi.mock('../../src/billing/stripe-client.js', async (original) => ({
  ...await original<typeof import('../../src/billing/stripe-client.js')>(),
  createAndSendInvoice: mocks.invoice, getProductsForCustomer: mocks.products,
  createCoupon: mocks.coupon,
}));
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));
vi.mock('../../src/slack/client.js', async (original) => ({
  ...await original<typeof import('../../src/slack/client.js')>(),
  isSlackConfigured: () => mocks.slackConfigured, getSlackUsers: mocks.slackSync, getUserChannels: vi.fn().mockResolvedValue([]),
}));

import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { invalidateSessionsForUsers } from '../../src/middleware/auth.js';
import { autoLinkByVerifiedDomain, upsertOrganizationMembership } from '../../src/db/membership-db.js';
import { checkAndAssignOrganizationByDomain, autoAddVerifiedDomainUsersAsMembers,
  autoLinkUnmappedSlackUsers } from '../../src/slack/sync.js';
import { handleUserChange } from '../../src/slack/events.js';
import type { Pool } from 'pg';

const A = 'user_containment_a';
const B = 'user_containment_b';
const ORG = 'org_containment';
const TOKEN = 'private-containment-token';
const routes: Array<[string, Record<string, unknown>]> = [
  ['/api/organizations', { organization_name: 'Acme Containment', is_personal: false }],
  [`/api/organizations/${ORG}/claim`, {}],
  ['/api/join-requests', { organization_id: ORG }],
  ['/api/me/agents', { url: 'https://agent.containment.test/mcp', type: 'sales' }],
  [`/api/invite/${TOKEN}/accept`, { agreement_version: '999.0', billingAddress: {
    line1: '1 Example St', city: 'Example', state: 'EX', postal_code: '10000', country: 'US',
  } }],
];
let pool: Pool;
let app: HTTPServer['app'];
let sessionNumber = 0;
function cookie(id = B, emailVerified: boolean | 'missing' = true, email = 'b@containment.test') {
  const key = `containment-${++sessionNumber}`;
  mocks.sessions.set(key, { id, email, ...(emailVerified === 'missing' ? {} : { emailVerified }), firstName: 'Test', lastName: 'Subject',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return `wos-session=${key}`;
}
async function snapshot() {
  const results = await Promise.all([
    pool.query('SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id, workos_organization_id', [[A, B]]),
    pool.query('SELECT * FROM registry_audit_log WHERE workos_user_id = ANY($1) ORDER BY id', [[A, B]]),
    pool.query('SELECT * FROM authorization_epochs WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [[A, B]]),
    pool.query('SELECT * FROM membership_invites WHERE token = $1', [TOKEN]),
    pool.query('SELECT * FROM organizations WHERE workos_organization_id LIKE $1 ORDER BY workos_organization_id', [ORG + '%']),
    pool.query('SELECT * FROM organization_domains WHERE workos_organization_id LIKE $1 ORDER BY id', [ORG + '%']),
    pool.query('SELECT * FROM member_profiles WHERE workos_organization_id LIKE $1 ORDER BY id', [ORG + '%']),
    pool.query('SELECT * FROM invitation_seat_types WHERE workos_organization_id = $1 ORDER BY workos_invitation_id', [ORG]),
    pool.query('SELECT * FROM user_agreement_acceptances WHERE workos_user_id = ANY($1) ORDER BY id', [[A, B]]),
    pool.query('SELECT * FROM organization_join_requests WHERE workos_user_id = ANY($1) ORDER BY id', [[A, B]]),
  ]);
  return results.map(r => r.rows);
}
async function link(primary: string, sibling: string) {
  await pool.query('UPDATE identity_workos_users SET is_primary = false WHERE workos_user_id = $1', [sibling]);
  await pool.query(`UPDATE identity_workos_users SET identity_id =
    (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1)
    WHERE workos_user_id = $2`, [primary, sibling]);
  await pool.query('UPDATE identity_workos_users SET is_primary = true WHERE workos_user_id = $1', [primary]);
  invalidateSessionsForUsers([A, B]);
}
function expectNoProviders() {
  for (const spy of [mocks.create, mocks.update, mocks.createOrg, mocks.sendInvitation, mocks.invoice, mocks.coupon, mocks.products]) {
    expect(spy).not.toHaveBeenCalled();
  }
}
function providerMembership(userId: string, role = 'member', id = `om_${userId}`, organizationId = ORG) {
  const value = { id, userId, organizationId, status: 'active', role: { slug: role } };
  mocks.providerMemberships.set(id, value);
  return value;
}
async function waitForDatabaseLock(queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query ILIKE '%' || $1 || '%'`,
      [queryFragment],
    );
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked database query containing ${queryFragment}`);
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\/[^/]+@(127\.0\.0\.1|localhost):\d+\/adcp_test$/.test(connectionString)) {
    throw new Error('This suite requires an explicit loopback adcp_test database');
  }
  pool = initializeDatabase({ connectionString });
  await runMigrations();
  app = new HTTPServer({ backgroundServices: 'refresh-only' }).app;
  await pool.query(`INSERT INTO agreements (version, text, effective_date, agreement_type)
    VALUES ('999.0', 'Containment test agreement', '2099-01-01', 'membership') ON CONFLICT DO NOTHING`);
}, 60000);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.slackConfigured = false;
  mocks.jwtOutage = false;
  mocks.providerMemberships.clear();
  delete process.env.ADMIN_EMAILS;
  invalidateSessionsForUsers([A, B]);
  await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM organization_join_requests WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query('DELETE FROM membership_invites WHERE token = $1', [TOKEN]);
  await pool.query('DELETE FROM certification_expectations WHERE workos_organization_id = $1', [ORG]);
  await pool.query('DELETE FROM invitation_seat_types WHERE workos_organization_id = $1', [ORG]);
  await pool.query("DELETE FROM slack_user_mappings WHERE slack_user_id = 'U_CONTAINMENT'");
  await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A, B]]);
  await pool.query(`INSERT INTO users (workos_user_id, email, email_verified) VALUES ($1, 'a@unrelated.test', true), ($2, 'b@containment.test', true)`, [A, B]);
  await pool.query(`INSERT INTO organizations (workos_organization_id, name, is_personal, email_domain, subscription_status)
    VALUES ($1, 'Acme Containment', false, 'containment.test', NULL)
    ON CONFLICT (workos_organization_id) DO UPDATE SET subscription_status = NULL, prospect_status = NULL`, [ORG]);
  await pool.query(`INSERT INTO organization_domains (workos_organization_id, domain, verified, is_primary, source)
    VALUES ($1, 'containment.test', true, true, 'workos') ON CONFLICT (domain) DO UPDATE SET verified = true`, [ORG]);
  await pool.query(`INSERT INTO membership_invites (token, workos_organization_id, lookup_key, contact_email, invited_by_user_id, expires_at)
    VALUES ($1, $2, 'test-tier', 'b@containment.test', $3, NOW() + interval '1 day')`, [TOKEN, ORG, A]);
  mocks.sendInvitation.mockResolvedValue({ id: 'inv_containment', email: 'b@containment.test', organizationId: ORG, state: 'pending',
    expiresAt: new Date(Date.now() + 86400000).toISOString(), acceptInvitationUrl: 'https://example.test/accept' });
  mocks.getInvitation.mockImplementation(async () => mocks.sendInvitation.mock.results.at(-1)?.value);
  mocks.listUsers.mockResolvedValue({ data: [] });
  mocks.list.mockImplementation(async ({ userId, organizationId, statuses }: any) => ({
    data: [...mocks.providerMemberships.values()].filter(row => (!userId || row.userId === userId)
      && (!organizationId || row.organizationId === organizationId) && (!statuses || statuses.includes(row.status))),
  }));
  mocks.getUser.mockImplementation(async (id: string) => ({ id, email: id === B ? 'b@containment.test' : 'a@unrelated.test', emailVerified: true }));
  mocks.create.mockResolvedValue({ id: 'om_containment', role: { slug: 'member' }, status: 'active' });
  mocks.update.mockResolvedValue({});
  mocks.createOrg.mockResolvedValue({ id: `${ORG}_new`, name: 'Acme New' });
  mocks.products.mockResolvedValue([{ lookup_key: 'test-tier', amount_cents: 100 }]);
  mocks.invoice.mockResolvedValue({ invoiceId: 'in_test', invoiceUrl: 'https://example.test/invoice' });
});
afterAll(async () => {
  await pool.query("DELETE FROM agreements WHERE version = '999.0' AND text = 'Containment test agreement'");
  await closeDatabase();
});

describe('mounted implicit onboarding containment', () => {
  it('linked sibling cannot cancel the canonical credential request; exact cancellation is single-use', async () => {
    const requestId = (await pool.query(`INSERT INTO organization_join_requests
      (workos_user_id, user_email, workos_organization_id) VALUES ($1, 'a@unrelated.test', $2) RETURNING id`, [A, ORG])).rows[0].id;
    await link(A, B);

    const sibling = await request(app).delete(`/api/join-requests/${requestId}`).set('Cookie', cookie(B));
    expect(sibling.status).toBe(404);
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id = $1', [requestId])).rows[0].status).toBe('pending');

    const exact = await request(app).delete(`/api/join-requests/${requestId}`).set('Cookie', cookie(A, true, 'a@unrelated.test'));
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    const replay = await request(app).delete(`/api/join-requests/${requestId}`).set('Cookie', cookie(A, true, 'a@unrelated.test'));
    expect(replay.status).toBe(404);
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id = $1', [requestId])).rows[0].status).toBe('cancelled');
    expectNoProviders();
  });

  it('cancellation rejects a conflicting query org before changing the request or calling a provider', async () => {
    const requestId = (await pool.query(`INSERT INTO organization_join_requests
      (workos_user_id, user_email, workos_organization_id) VALUES ($1, 'b@containment.test', $2) RETURNING id`, [B, ORG])).rows[0].id;
    const response = await request(app).delete(`/api/join-requests/${requestId}`).query({ org: `${ORG}_other` }).set('Cookie', cookie(B));
    expect(response.status).toBe(403);
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id = $1', [requestId])).rows[0].status).toBe('pending');
    expectNoProviders();
  });

  it('cancellation rejects a same-identity binding delete-and-reinsert before the local write', async () => {
    const requestId = (await pool.query(`INSERT INTO organization_join_requests
      (workos_user_id, user_email, workos_organization_id) VALUES ($1, 'b@containment.test', $2) RETURNING id`, [B, ORG])).rows[0].id;
    const binding = (await pool.query<{ identity_id: string; is_primary: boolean }>(
      'SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1', [B],
    )).rows[0];
    const originalConnect = pool.connect.bind(pool);
    let checkouts = 0;
    let mutated = false;
    const spy = vi.spyOn(pool, 'connect').mockImplementation((async (...args: any[]) => {
      if (typeof args[0] === 'function') return (originalConnect as any)(...args);
      const client = await originalConnect();
      if (++checkouts === 2) {
        mutated = true;
        await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [B]);
        await pool.query(
          `INSERT INTO identity_workos_users (workos_user_id, identity_id, is_primary)
           VALUES ($1, $2, $3)`,
          [B, binding.identity_id, binding.is_primary],
        );
      }
      return client;
    }) as any);
    try {
      const response = await request(app).delete(`/api/join-requests/${requestId}`).set('Cookie', cookie(B));
      expect(response.status).toBe(403);
      expect(mutated).toBe(true);
      expect((await pool.query(
        'SELECT status FROM organization_join_requests WHERE id = $1', [requestId],
      )).rows[0].status).toBe('pending');
      expect((await pool.query(
        'SELECT 1 FROM registry_audit_log WHERE resource_id = $1', [requestId],
      )).rowCount).toBe(0);
      expectNoProviders();
    } finally {
      spy.mockRestore();
    }
  });

  it('warm-cookie cancellation reports authorization_unavailable before changing the request', async () => {
    const requestId = (await pool.query(`INSERT INTO organization_join_requests
      (workos_user_id, user_email, workos_organization_id) VALUES ($1, 'b@containment.test', $2) RETURNING id`, [B, ORG])).rows[0].id;
    const auth = cookie(B);
    mocks.jwtOutage = true;
    const response = await request(app).delete(`/api/join-requests/${requestId}`).set('Cookie', auth);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('authorization_unavailable');
    expect((await pool.query('SELECT status FROM organization_join_requests WHERE id = $1', [requestId])).rows[0].status).toBe('pending');
    expectNoProviders();
  });

  it('exact cancellation holds the request row, wins deterministically, and blocks approval provider calls', async () => {
    const advisoryKey = 6827002;
    const blocker = await pool.connect();
    const requestId = (await pool.query(`INSERT INTO organization_join_requests
      (workos_user_id, user_email, workos_organization_id) VALUES ($1, 'b@containment.test', $2) RETURNING id`, [B, ORG])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, 'om_cancel_admin', 'a@unrelated.test', 'admin', 'contributor')`, [A, ORG]);
    mocks.list.mockImplementation(async ({ userId }: any) => ({ data: userId === A ? [{
      id: 'om_cancel_admin', userId: A, organizationId: ORG, status: 'active', role: { slug: 'admin' },
    }] : [] }));
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey]);
      await pool.query(`CREATE FUNCTION containment_cancel_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'cancelled' THEN PERFORM pg_advisory_xact_lock(${advisoryKey}); END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER containment_cancel_barrier BEFORE UPDATE ON organization_join_requests
        FOR EACH ROW WHEN (OLD.id = '${requestId}' AND OLD.workos_organization_id = '${ORG}' AND NEW.status = 'cancelled')
        EXECUTE FUNCTION containment_cancel_barrier()`);

      const cancellation = request(app).delete(`/api/join-requests/${requestId}`)
        .set('Cookie', cookie(B)).then(response => response);
      await waitForDatabaseLock('UPDATE organization_join_requests');
      const approval = request(app).post(`/api/organizations/${ORG}/join-requests/${requestId}/approve`)
        .set('Cookie', cookie(A, true, 'a@unrelated.test')).send({ role: 'member' }).then(response => response);
      await waitForDatabaseLock('SELECT * FROM organization_join_requests');
      expect(mocks.create).not.toHaveBeenCalled();

      await blocker.query('COMMIT');
      expect((await cancellation).status).toBe(200);
      expect((await approval).status).toBe(409);
      expect((await pool.query('SELECT status FROM organization_join_requests WHERE id = $1', [requestId])).rows[0].status).toBe('cancelled');
      expect(mocks.create).not.toHaveBeenCalled();
      expect((await pool.query('SELECT 1 FROM registry_audit_log WHERE resource_id = $1', [requestId])).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      try {
        await pool.query('DROP TRIGGER IF EXISTS containment_cancel_barrier ON organization_join_requests');
      } finally {
        await pool.query('DROP FUNCTION IF EXISTS containment_cancel_barrier()');
      }
    }
  });
  it.each(routes)('invalid auth remains 401 on %s', async (path, body) => {
    expect((await request(app).post(path).send(body)).status).toBe(401);
    expectNoProviders();
  });
  it.each(routes)('linked B proof never grants canonical A via %s', async (path, body) => {
    await link(A, B);
    const before = await snapshot();
    const res = await request(app).post(path).set('Cookie', cookie()).send(body);
    expectNoProviders();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('organization_onboarding_disabled');
    expect(await snapshot()).toEqual(before);
  });
  it.each([true, false, 'missing'] as const)('verification %s cannot enable suspended grants', async (verified) => {
    for (const [path, body] of routes) {
      const res = await request(app).post(path).set('Cookie', cookie(B, verified)).send(body);
      expect(res.status).toBe(403);
    }
    expectNoProviders();
  });
  it.each([' B@CONTAINMENT.TEST ', 'b@子.test', 'alias@containment.test', 'a@unrelated.test'])('token email %s does not bypass denial', async (email) => {
    const before = await snapshot();
    const [path, body] = routes[4];
    expect((await request(app).post(path).set('Cookie', cookie(B, true, email)).send(body)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it.each(['revoked', 'expired', 'accepted', 'pending'])('token status %s remains side-effect free', async (status) => {
    if (status === 'revoked') await pool.query('UPDATE membership_invites SET revoked_at = NOW() WHERE token = $1', [TOKEN]);
    if (status === 'accepted') await pool.query('UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $2 WHERE token = $1', [TOKEN, B]);
    if (status === 'expired') await pool.query("UPDATE membership_invites SET expires_at = NOW() - interval '1 day' WHERE token = $1", [TOKEN]);
    const before = await snapshot();
    const [path, body] = routes[4];
    const results = await Promise.all([A, B].map(id => request(app).post(path).set('Cookie', cookie(id)).send(body)));
    expect(results.map(r => r.status)).toEqual([403, 403]);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('opposite linked direction, concurrent independent sessions and unlink preserve zero transferred authority', async () => {
    await link(B, A);
    const before = await snapshot();
    const requests = routes.flatMap(([path, body]) => [A, B].map(id =>
      request(app).post(path).set('Cookie', cookie(id)).send(body)));
    expect((await Promise.all(requests)).every(r => r.status === 403)).toBe(true);
    await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [A]);
    invalidateSessionsForUsers([A, B]);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('source outages do not enable disabled onboarding or trigger downstream calls', async () => {
    mocks.list.mockRejectedValue(new Error('required source unavailable'));
    mocks.getUser.mockRejectedValue(new Error('required source unavailable'));
    const before = await snapshot();
    for (const [path, body] of routes) expect((await request(app).post(path).set('Cookie', cookie()).send(body)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it.each([0, 1, 2])('does not infer a primary/sole org from %s historical memberships', async (count) => {
    for (let i = 0; i < count; i++) await pool.query(`INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
      VALUES ($1, $2, 'b@containment.test', 'owner')`, [B, `${ORG}_${i}`]);
    const before = await snapshot();
    const res = await request(app).post('/api/me/agents').set('Cookie', cookie()).send(routes[3][1]);
    expect(res.status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('explicit agent organization denies canonical sibling membership and reports provider outage as 503', async () => {
    await link(A, B);
    mocks.list.mockResolvedValue({ data: [{ userId: A, organizationId: ORG, status: 'active', role: { slug: 'owner' } }] });
    expect((await request(app).post('/api/me/agents').query({ org: ORG }).set('Cookie', cookie()).send(routes[3][1])).status).toBe(403);
    expect(mocks.list).toHaveBeenCalledWith({ userId: B, organizationId: ORG, statuses: ['active'] });
    mocks.list.mockRejectedValue(new Error('outage'));
    expect((await request(app).post('/api/me/agents').query({ org: ORG }).set('Cookie', cookie()).send(routes[3][1])).status).toBe(503);
    expectNoProviders();
  });
  it.each([
    ['get', '/api/me', {}], ['get', '/api/me/member-profile', {}],
    ['post', '/api/me/member-profile', { display_name: 'Acme', slug: 'acme-containment' }],
    ['post', '/api/me/member-profile', { organization_name: 'Acme', company_type: 'adtech', corporate_domain: 'containment.test' }],
    ['put', '/api/me/member-profile', { display_name: 'Acme' }],
  ] as const)('%s %s does not auto-link a verified domain', async (method, path, body) => {
    await pool.query("UPDATE organizations SET subscription_status = 'active' WHERE workos_organization_id = $1", [ORG]);
    const before = await snapshot();
    const res = await request(app)[method](path).set('Cookie', cookie()).send(body);
    expect(res.status).toBeLessThan(500);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('linked unverified B cannot stamp a verified domain on canonical A existing organization', async () => {
    await link(A, B);
    await pool.query('UPDATE organization_domains SET verified = false WHERE workos_organization_id = $1', [ORG]);
    mocks.list.mockResolvedValue({ data: [{ userId: A, organizationId: ORG, status: 'active', role: { slug: 'owner' } }] });
    const before = await snapshot();
    const res = await request(app).post('/api/me/member-profile').set('Cookie', cookie(B, false)).send({
      organization_name: 'Acme', company_type: 'adtech', corporate_domain: 'containment.test',
    });
    expect(res.status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('Slack scheduled/admin/event profile synchronization creates no organization authority', async () => {
    mocks.slackConfigured = true;
    const slackUser = { id: 'U_CONTAINMENT', is_bot: false, deleted: false,
      profile: { email: 'b@containment.test', real_name: 'Profile Only' } };
    mocks.slackSync.mockResolvedValue([slackUser]);
    process.env.ADMIN_EMAILS = 'b@containment.test';
    const before = await snapshot();
    const sync = await request(app).post('/api/admin/slack/sync').set('Cookie', cookie()).send({});
    expect(sync.status).toBe(200);
    expect(sync.body.total_synced).toBe(1);
    const mapped = await request(app).post('/api/admin/slack/users/U_CONTAINMENT/link')
      .set('Cookie', cookie()).send({ workos_user_id: B });
    expect(mapped.status).toBe(200);
    expect(mapped.body.organization_assignment).toEqual({ assigned: false });
    expect((await autoAddVerifiedDomainUsersAsMembers()).added).toBe(0);
    await handleUserChange({ type: 'user_change', user: { ...slackUser,
      profile: { ...slackUser.profile, real_name: 'Updated Profile Only' } } });
    expect((await pool.query("SELECT slack_real_name FROM slack_user_mappings WHERE slack_user_id = 'U_CONTAINMENT'")).rows[0].slack_real_name).toBe('Updated Profile Only');
    const after = await snapshot();
    // Current-main's manual Slack mapping fence bumps the exact credential's
    // revocation epoch. That lifecycle invalidation is not organization
    // authority; every authority-bearing and onboarding surface stays fixed.
    expect(after[2]).toEqual([expect.objectContaining({ workos_user_id: B, epoch: '1' })]);
    expect([...after.slice(0, 2), before[2], ...after.slice(3)]).toEqual(before);
    expectNoProviders();
  });
  it.each([true, false])('Slack/domain bulk writers never grant, even verified=%s', async (verified) => {
    await pool.query('UPDATE organization_domains SET verified = $2 WHERE workos_organization_id = $1', [ORG, verified]);
    const before = await snapshot();
    expect(await checkAndAssignOrganizationByDomain(B)).toEqual({ assigned: false });
    expect(await autoAddVerifiedDomainUsersAsMembers()).toEqual({ added: 0, skipped: 0, errors: 0 });
    expect((await autoLinkUnmappedSlackUsers()).organizations_assigned).toBe(0);
    expect(await autoLinkByVerifiedDomain({ userManagement: { createOrganizationMembership: mocks.create } } as any, B, 'b@containment.test')).toBeNull();
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it.each(['invited', 'admin_added', 'webhook'])('common membership consumer preserves member for staged source %s', async (source) => {
    providerMembership(B, 'member', 'om_containment');
    await pool.query(`INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type, source)
      VALUES ($1, $2, 'b@containment.test', 'community_only', $3)`, [source, ORG, source]);
    const res = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test-verified-at-provider-boundary').send({
      id: `evt_${source}`, event: 'organization_membership.created', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
    });
    expect(res.status).toBe(200);
    const rows = await pool.query('SELECT workos_user_id, role FROM organization_memberships WHERE workos_organization_id = $1', [ORG]);
    expect(rows.rows).toEqual([{ workos_user_id: B, role: 'member' }]);
    expectNoProviders();
  });
  it('active membership replay at capacity preserves its seat and mirrors the provider role', async () => {
    providerMembership(B, 'admin', 'om_containment');
    await pool.query('UPDATE organizations SET membership_tier = NULL, subscription_status = NULL WHERE workos_organization_id = $1', [ORG]);
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type, provisioning_source)
      VALUES ($1, $2, 'om_containment', 'b@containment.test', 'member', 'community_only', 'invited')`, [B, ORG]);
    const response = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_replay_at_capacity', event: 'organization_membership.updated', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'admin' } },
    });
    expect(response.status).toBe(200);
    expect((await pool.query(`SELECT role, seat_type, provisioning_source FROM organization_memberships
      WHERE workos_user_id = $1 AND workos_organization_id = $2`, [B, ORG])).rows)
      .toEqual([{ role: 'admin', seat_type: 'community_only', provisioning_source: 'invited' }]);
    expectNoProviders();
  });
  it('stale role replay mirrors the current provider role rather than the event role', async () => {
    providerMembership(B, 'owner', 'om_containment');
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, 'om_containment', 'b@containment.test', 'member', 'community_only')`, [B, ORG]);
    const response = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_stale_role', event: 'organization_membership.updated', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
    });
    expect(response.status).toBe(200);
    expect((await pool.query('SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2', [B, ORG])).rows)
      .toEqual([{ role: 'owner' }]);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('provider role change during synchronization rolls back the stale local mirror', async () => {
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, 'om_containment', 'b@containment.test', 'member', 'community_only')`, [B, ORG]);
    let reads = 0;
    mocks.list.mockImplementation(async () => ({
      data: [{
        id: 'om_containment', userId: B, organizationId: ORG, status: 'active',
        role: { slug: ++reads === 1 ? 'owner' : 'admin' },
      }],
    }));
    const response = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_changed_role', event: 'organization_membership.updated', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
    });
    expect(response.status).toBe(503);
    expect(reads).toBe(2);
    expect((await pool.query('SELECT role FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2', [B, ORG])).rows)
      .toEqual([{ role: 'member' }]);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('out-of-order stale delete mirrors an active replacement and preserves its primary pointer', async () => {
    providerMembership(A, 'owner', 'om_owner_replacement');
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, 'om_owner_old', 'a@unrelated.test', 'owner', 'contributor')`, [A, ORG]);
    await pool.query('UPDATE users SET primary_organization_id = $2 WHERE workos_user_id = $1', [A, ORG]);
    const response = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_stale_owner_delete', event: 'organization_membership.deleted', created_at: new Date().toISOString(),
      data: { id: 'om_owner_old', user_id: A, organization_id: ORG, status: 'inactive', role: { slug: 'owner' } },
    });
    expect(response.status).toBe(200);
    expect((await pool.query(`SELECT workos_membership_id, role FROM organization_memberships
      WHERE workos_user_id = $1 AND workos_organization_id = $2`, [A, ORG])).rows)
      .toEqual([{ workos_membership_id: 'om_owner_replacement', role: 'owner' }]);
    expect((await pool.query('SELECT primary_organization_id FROM users WHERE workos_user_id = $1', [A])).rows)
      .toEqual([{ primary_organization_id: ORG }]);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([
    ['legacy null provider id', null],
    ['mismatched provider id', 'om_replacement_local'],
  ] as const)('provider-confirmed absence removes %s authority and its primary pointer', async (_case, localMembershipId) => {
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, $3, 'b@containment.test', 'member', 'community_only')`, [B, ORG, localMembershipId]);
    await pool.query('UPDATE users SET primary_organization_id = $2 WHERE workos_user_id = $1', [B, ORG]);
    const response = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_old_delete', event: 'organization_membership.deleted', created_at: new Date().toISOString(),
      data: { id: 'om_old_deleted', user_id: B, organization_id: ORG, status: 'inactive', role: { slug: 'member' } },
    });
    expect(response.status).toBe(200);
    expect((await pool.query(`SELECT workos_membership_id, role FROM organization_memberships
      WHERE workos_user_id = $1 AND workos_organization_id = $2`, [B, ORG])).rows).toEqual([]);
    expect((await pool.query('SELECT primary_organization_id FROM users WHERE workos_user_id = $1', [B])).rows)
      .toEqual([{ primary_organization_id: null }]);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it.each(['members/by-email', 'invitations', 'certification-invites'])('%s producer followed by acceptance never synthesizes owner', async (producer) => {
    await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
      VALUES ($1, $2, 'om_admin', 'a@unrelated.test', 'admin', 'contributor')`, [A, ORG]);
    mocks.list.mockImplementation(async ({ userId }: any) => ({ data: userId === A ? [{
      id: 'om_admin', userId: A, organizationId: ORG, status: 'active', role: { slug: 'admin' },
    }] : [] }));
    const invitation = await request(app).post(`/api/organizations/${ORG}/${producer}`)
      .set('Cookie', cookie(A, true, 'a@unrelated.test'))
      .send(producer === 'certification-invites' ? { emails: ['b@containment.test'] } : { email: 'b@containment.test', role: 'member' });
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(producer === 'members/by-email' ? 201 : 200);
    expect(mocks.sendInvitation).toHaveBeenCalledTimes(1);
    expect(mocks.sendInvitation.mock.calls[0][0]).toMatchObject({ email: 'b@containment.test', organizationId: ORG });
    if (producer !== 'certification-invites') expect(mocks.sendInvitation.mock.calls[0][0].roleSlug).toBe('member');
    // The inviter leaves before the recipient accepts. The provider delivers
    // member, so an ownerless local roster must not turn that role into owner.
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [A]);
    const acceptedMembership = providerMembership(B, 'member', 'om_containment');
    mocks.list.mockImplementation(async ({ userId }: any) => ({ data: userId === B ? [acceptedMembership] : [] }));
    mocks.sendInvitation.mockClear();
    const accepted = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: `evt_producer_${producer}`, event: 'organization_membership.created', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
    });
    expect(accepted.status).toBe(200);
    expect((await pool.query('SELECT workos_user_id, role FROM organization_memberships WHERE workos_organization_id = $1', [ORG])).rows)
      .toEqual([{ workos_user_id: B, role: 'member' }]);
    expectNoProviders();
  });
  it('owner deletion does not promote an ordinary invite recipient', async () => {
    for (const [id, role] of [[A, 'owner'], [B, 'member']]) await pool.query(`INSERT INTO organization_memberships
      (workos_user_id, workos_organization_id, workos_membership_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, ORG, `om_${id}`, `${id}@containment.test`, role]);
    const res = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test-verified-at-provider-boundary').send({
      id: 'evt_delete', event: 'organization_membership.deleted', created_at: new Date().toISOString(),
      data: { id: `om_${A}`, user_id: A, organization_id: ORG, status: 'inactive', role: { slug: 'owner' } },
    });
    expect(res.status).toBe(200);
    expect((await pool.query('SELECT role FROM organization_memberships WHERE workos_user_id = $1', [B])).rows).toEqual([{ role: 'member' }]);
    expectNoProviders();
  });
  it.each(['outage', 'wrong subject'])('active membership %s fails with 503 before writes', async (condition) => {
    providerMembership(B, 'member', 'om_containment');
    if (condition === 'outage') mocks.getUser.mockRejectedValue(new Error('required source unavailable'));
    else mocks.getUser.mockResolvedValue({ id: A, email: 'a@unrelated.test' });
    const before = await snapshot();
    const res = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_source', event: 'organization_membership.updated', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
    });
    expect(res.status).toBe(503);
    expect(await snapshot()).toEqual(before);
    expectNoProviders();
  });
  it('inactive membership removes access during user-source outage without promoting', async () => {
    await pool.query(`INSERT INTO organization_memberships (workos_user_id, workos_organization_id, workos_membership_id, email, role)
      VALUES ($1, $2, 'om_containment', 'b@containment.test', 'owner')`, [B, ORG]);
    mocks.getUser.mockRejectedValue(new Error('unavailable'));
    const res = await request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
      id: 'evt_inactive', event: 'organization_membership.updated', created_at: new Date().toISOString(),
      data: { id: 'om_containment', user_id: B, organization_id: ORG, status: 'inactive', role: { slug: 'owner' } },
    });
    expect(res.status).toBe(200);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect((await pool.query('SELECT * FROM organization_memberships WHERE workos_user_id = $1', [B])).rows).toEqual([]);
    expectNoProviders();
  });
  it('invitation acceptance continuously transfers its seat reservation while a concurrent invite waits', async () => {
    const advisoryKey = 6827001;
    const blocker = await pool.connect();
    try {
      await pool.query('UPDATE organizations SET membership_tier = NULL, subscription_status = NULL WHERE workos_organization_id = $1', [ORG]);
      await pool.query(`INSERT INTO organization_memberships
        (workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type)
        VALUES ($1, $2, 'om_acceptance_admin', 'a@unrelated.test', 'admin', 'contributor')`, [A, ORG]);
      mocks.list.mockImplementation(async ({ userId }: any) => ({ data: userId === A ? [{
        id: 'om_acceptance_admin', userId: A, organizationId: ORG, status: 'active', role: { slug: 'admin' },
      }] : userId === B ? [{
        id: 'om_acceptance_member', userId: B, organizationId: ORG, status: 'active', role: { slug: 'member' },
      }] : [] }));
      await pool.query(`INSERT INTO invitation_seat_types
        (workos_invitation_id, workos_organization_id, email, seat_type, source)
        VALUES ('inv_acceptance_race', $1, 'b@containment.test', 'community_only', 'invited')`, [ORG]);

      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey]);
      await pool.query(`CREATE FUNCTION containment_acceptance_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(${advisoryKey}); RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER containment_acceptance_barrier BEFORE INSERT ON organization_memberships
        FOR EACH ROW WHEN (NEW.workos_organization_id = '${ORG}'
          AND NEW.workos_user_id = '${B}' AND NEW.workos_membership_id = 'om_acceptance_member')
        EXECUTE FUNCTION containment_acceptance_barrier()`);

      const acceptance = request(app).post('/api/webhooks/workos').set('WorkOS-Signature', 'test').send({
        id: 'evt_acceptance_reservation', event: 'organization_membership.created', created_at: new Date().toISOString(),
        data: { id: 'om_acceptance_member', user_id: B, organization_id: ORG, status: 'active', role: { slug: 'member' } },
      }).then(response => response);
      await waitForDatabaseLock('INSERT INTO organization_memberships');

      const concurrentInvite = request(app).post(`/api/organizations/${ORG}/invitations`)
        .set('Cookie', cookie(A, true, 'a@unrelated.test'))
        .send({ email: 'later@containment.test', role: 'member', seat_type: 'community_only' })
        .then(response => response);
      await waitForDatabaseLock('SELECT workos_organization_id FROM organizations');

      // The accepting transaction has consumed the row internally, but every
      // independent session still observes the reservation until the member
      // row is committed. Capacity is never externally released between them.
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM invitation_seat_types
        WHERE workos_organization_id = $1 AND seat_type = 'community_only'`, [ORG])).rows[0].count).toBe(1);
      expect((await pool.query('SELECT 1 FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2', [B, ORG])).rowCount).toBe(0);

      await blocker.query('COMMIT');
      expect((await acceptance).status).toBe(200);
      const denied = await concurrentInvite;
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body.error).toBe('access_denied');
      expect(mocks.sendInvitation).not.toHaveBeenCalled();
      expect((await pool.query('SELECT seat_type FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2', [B, ORG])).rows)
        .toEqual([{ seat_type: 'community_only' }]);
      expect((await pool.query('SELECT 1 FROM invitation_seat_types WHERE workos_organization_id = $1', [ORG])).rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      try {
        await pool.query('DROP TRIGGER IF EXISTS containment_acceptance_barrier ON organization_memberships');
      } finally {
        await pool.query('DROP FUNCTION IF EXISTS containment_acceptance_barrier()');
      }
    }
  });
  it('BEFORE RETURN NULL membership trigger aborts success', async () => {
    try {
      await pool.query(`CREATE FUNCTION containment_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
      await pool.query(`CREATE TRIGGER containment_suppress BEFORE INSERT ON organization_memberships
        FOR EACH ROW WHEN (NEW.workos_organization_id = '${ORG}'
          AND NEW.workos_user_id = '${B}' AND NEW.workos_membership_id = 'om_suppressed')
        EXECUTE FUNCTION containment_suppress()`);
      await expect(upsertOrganizationMembership({ user_id: B, organization_id: ORG, membership_id: 'om_suppressed', email: 'b@containment.test',
        first_name: null, last_name: null, role: 'member', seat_type: 'community_only', has_explicit_seat_type: false })).rejects.toThrow('exactly one row');
    } finally {
      try {
        await pool.query('DROP TRIGGER IF EXISTS containment_suppress ON organization_memberships');
      } finally {
        await pool.query('DROP FUNCTION IF EXISTS containment_suppress()');
      }
    }
  });
});
