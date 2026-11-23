import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { NotificationSubscriptionValidationError } from '@adcp/sdk/server';

const mocks = vi.hoisted(() => ({
  createValidation: vi.fn(),
  loadSealedSession: vi.fn(),
  checkPlatformBanForApiKey: vi.fn(),
  checkPlatformBan: vi.fn(),
  invalidateMembershipCache: vi.fn(),
  resolveEffectiveMembership: vi.fn(),
  getAdminWorkingGroupIdBySlug: vi.fn(),
  isAdminGroupMember: vi.fn(),
  poolQuery: vi.fn(),
  snapshotQuery: vi.fn(),
  runtime: undefined as undefined | {
    listNotificationSubscribers: ReturnType<typeof vi.fn>;
    setNotificationSubscriberActive: ReturnType<typeof vi.fn>;
  },
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_training_reporting';
  process.env.WORKOS_CLIENT_ID = 'client_test_training_reporting';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  process.env.ADMIN_API_KEY = 'static-training-reporting-admin-key';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  WorkOS: class WorkOS {
    apiKeys = { createValidation: mocks.createValidation };
    userManagement = { loadSealedSession: mocks.loadSealedSession };
  },
}));
vi.mock('../../src/db/bans-db.js', () => ({
  bansDb: { checkPlatformBanForApiKey: mocks.checkPlatformBanForApiKey, checkPlatformBan: mocks.checkPlatformBan },
}));
vi.mock('../../src/db/org-filters.js', () => ({
  invalidateMembershipCache: mocks.invalidateMembershipCache,
  resolveEffectiveMembership: mocks.resolveEffectiveMembership,
}));
vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: () => ({ query: mocks.poolQuery }),
  queryWithTimeout: mocks.snapshotQuery,
}));
vi.mock('../../src/db/working-group-db.js', () => ({
  WorkingGroupDatabase: class WorkingGroupDatabase {
    getWorkingGroupIdBySlug = mocks.getAdminWorkingGroupIdBySlug;
    isMember = mocks.isAdminGroupMember;
  },
}));
vi.mock('../../src/addie/mcp/admin-tools.js', async () => {
  const { isWebUserAAOAdmin } = await import('../../src/addie/admin-status-lookup.js');
  return { isWebUserAAOAdmin };
});
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: () => mocks.runtime }));

const { setupTrainingReportingRoutes } = await import('../../src/routes/admin/training-reporting.js');
const { stopAuthTimers } = await import('../../src/middleware/auth.js');

const ADMIN = 'Bearer static-training-reporting-admin-key';
const BASE = '/api/admin/training-agent/reporting/subscribers';
const SUSPEND = `${BASE}/acc-1/sub-1/suspend`;
const RESUME = `${BASE}/acc-1/sub-1/resume`;
const REASON = 'Subscriber returns 500s';

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const router = express.Router();
  setupTrainingReportingRoutes(router);
  app.use('/api/admin', router);
  return app;
}

function auditInserts() {
  return mocks.poolQuery.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO registry_audit_log'));
}

describe('admin training reporting subscriber routes', () => {
  const app = createApp();
  afterAll(() => stopAuthTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime = {
      listNotificationSubscribers: vi.fn().mockResolvedValue([]),
      setNotificationSubscriberActive: vi.fn().mockResolvedValue('applied'),
    };
    mocks.snapshotQuery.mockReset().mockImplementation((...args) => mocks.poolQuery(...args));
    mocks.createValidation.mockResolvedValue({
      apiKey: { id: 'key_1', owner: { type: 'organization', id: 'org_tenant' }, name: 'k', permissions: ['admin:*'] },
    });
    mocks.resolveEffectiveMembership.mockResolvedValue({ is_member: true });
    mocks.checkPlatformBanForApiKey.mockResolvedValue({ banned: false });
    mocks.checkPlatformBan.mockResolvedValue({ banned: false });
    mocks.getAdminWorkingGroupIdBySlug.mockResolvedValue('wg_aao_admin');
    mocks.isAdminGroupMember.mockResolvedValue(false);
    mocks.poolQuery.mockImplementation((sql: string) => {
      if (sql.includes('pg_catalog.pg_is_in_recovery()')) {
        return Promise.resolve({
          rows: [{
            in_recovery: false, terminal_marker: false, primary_count: '1',
            authenticated_user_id: 'user_plain', canonical_user_id: 'user_plain',
            identity_id: 'identity_plain', binding_version: 'binding_plain', authorization_epoch: '0',
            email: 'plain@example.test', email_verified: true, first_name: 'P', last_name: 'U', grant_id: null,
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    mocks.loadSealedSession.mockReturnValue({
      authenticate: vi.fn().mockResolvedValue({
        authenticated: true,
        accessToken: 'plain-access-token',
        user: {
          id: 'user_plain', email: 'plain@example.test', firstName: 'P', lastName: 'U',
          emailVerified: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        },
      }),
    });
  });

  describe('auth', () => {
    const cases: Array<[string, 'get' | 'post', string]> = [
      ['list', 'get', BASE], ['suspend', 'post', SUSPEND], ['resume', 'post', RESUME],
    ];
    it.each(cases)('%s: no credentials gives 401', async (_n, method, url) => {
      const res = await request(app)[method](url).send({ reason: REASON });
      expect(res.status).toBe(401);
      expect(mocks.runtime!.listNotificationSubscribers).not.toHaveBeenCalled();
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
    });
    it.each(cases)('%s: an authenticated non-admin gives 403', async (_n, method, url) => {
      const res = await request(app)[method](url).set('Cookie', 'wos-session=plain-user').send({ reason: REASON });
      expect(res.status).toBe(403);
      expect(mocks.runtime!.listNotificationSubscribers).not.toHaveBeenCalled();
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
    });
    it.each(cases)('%s: a WorkOS API key is refused by requireAdmin', async (_n, method, url) => {
      const res = await request(app)[method](url).set('Authorization', 'Bearer sk_tenant_full').send({ reason: REASON });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('global_admin_required');
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
    });
    it.each(cases)('%s: the static admin key passes', async (_n, method, url) => {
      const res = await request(app)[method](url).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
    });
  });

  describe('request validation', () => {
    it.each([
      ['missing', undefined], ['empty', ''], ['under 5 chars after trim', '  abc  '], ['not a string', 12345],
    ])('rejects a %s reason with 400 reason_required', async (_n, reason) => {
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send(reason === undefined ? {} : { reason });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('reason_required');
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
    });
    it('rejects a reason over 500 chars with 400 reason_too_long', async () => {
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: 'x'.repeat(501) });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('reason_too_long');
    });
    it('accepts a reason of exactly 500 chars', async () => {
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: 'x'.repeat(500) });
      expect(res.status).toBe(200);
    });
    it.each([
      ['space in account', `${BASE}/bad%20id/sub-1/suspend`],
      ['space in subscriber', `${BASE}/acc-1/bad%20id/suspend`],
      ['too long', `${BASE}/${'a'.repeat(201)}/sub-1/suspend`],
      ['illegal char', `${BASE}/acc-1/sub$1/suspend`],
    ])('rejects invalid ids (%s) with 400 invalid_id', async (_n, url) => {
      const res = await request(app).post(url).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_id');
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
    });
  });

  describe('suspend and resume', () => {
    it('suspends, calls the runtime, and writes an attributed audit row', async () => {
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN)
        .set('X-Admin-Operator', 'alice').send({ reason: `  ${REASON}  ` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ account_id: 'acc-1', subscriber_id: 'sub-1', active: false, changed: true });
      expect(mocks.runtime!.setNotificationSubscriberActive).toHaveBeenCalledWith('acc-1', 'sub-1', false);

      const inserts = auditInserts();
      expect(inserts).toHaveLength(1);
      const [sql, params] = inserts[0] as [string, string[]];
      expect(sql).toContain('registry_audit_log');
      expect(params[0]).toBe('system_training_agent');
      expect(params[1]).toBe('admin_api_key');
      expect(params[2]).toBe('training_reporting_subscriber_suspended');
      expect(params[3]).toBe('acc-1/sub-1');
      const details = JSON.parse(params[4]);
      expect(details).toMatchObject({
        account_id: 'acc-1', subscriber_id: 'sub-1', active: false, changed: true,
        reason: REASON, operator: 'alice',
      });
      expect(typeof details.at).toBe('string');
      expect(new Date(details.at).toISOString()).toBe(details.at);
      expect(details.admin_key_fingerprint).toEqual(expect.any(String));
      expect(details.ip_address).toEqual(expect.any(String));
    });

    it('resumes with the resumed action', async () => {
      const res = await request(app).post(RESUME).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ account_id: 'acc-1', subscriber_id: 'sub-1', active: true, changed: true });
      expect(mocks.runtime!.setNotificationSubscriberActive).toHaveBeenCalledWith('acc-1', 'sub-1', true);
      expect(auditInserts()[0][1][2]).toBe('training_reporting_subscriber_resumed');
    });

    it('is idempotent: unchanged gives 200 changed:false and still audits', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockResolvedValue('unchanged');
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      expect(auditInserts()).toHaveLength(1);
      expect(JSON.parse(auditInserts()[0][1][4]).changed).toBe(false);
    });

    it('returns 404 subscriber_not_found with no audit row', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockResolvedValue('not_found');
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('subscriber_not_found');
      expect(auditInserts()).toHaveLength(0);
    });

    it('returns 422 subscription_set_invalid on a validation error', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(
        new NotificationSubscriptionValidationError('bad destination', 0, 'url'));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('subscription_set_invalid');
      expect(auditInserts()).toHaveLength(0);
    });

    it('returns 503 reporting_unavailable on any other error, without leaking it', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(new Error('pg: password=hunter2'));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'reporting_unavailable' });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(auditInserts()).toHaveLength(0);
    });

    it('returns 503 reporting_disabled with no runtime', async () => {
      mocks.runtime = undefined;
      for (const url of [SUSPEND, RESUME]) {
        const res = await request(app).post(url).set('Authorization', ADMIN).send({ reason: REASON });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('reporting_disabled');
      }
      expect((await request(app).get(BASE).set('Authorization', ADMIN)).body.error).toBe('reporting_disabled');
      expect(auditInserts()).toHaveLength(0);
    });

    it('returns 500 audit_write_failed and says the change was applied', async () => {
      mocks.poolQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT INTO registry_audit_log') ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [], rowCount: 1 }));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('audit_write_failed');
      expect(res.body.message).toMatch(/applied/);
      expect(res.body).toMatchObject({ account_id: 'acc-1', subscriber_id: 'sub-1', active: false });
      expect(mocks.runtime!.setNotificationSubscriberActive).toHaveBeenCalledTimes(1);
    });
  });

  describe('list', () => {
    it('returns the runtime subscribers and no URL path, query or credential', async () => {
      mocks.runtime!.listNotificationSubscribers.mockResolvedValue([{
        account_id: 'acc-1', subscriber_id: 'sub-1', active: true, url_host: 'hooks.example.com',
        event_types: ['reporting.status_changed'],
        recent_attempts: { success: 3, failed: 1, timeout: 0, connection_error: 0, pending: 0, last_status: 'failed', last_http_status_code: 500 },
      }]);
      const res = await request(app).get(BASE).set('Authorization', ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.subscribers).toHaveLength(1);
      expect(res.body.subscribers[0].url_host).toBe('hooks.example.com');
      expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\//);
    });
    it('returns 503 reporting_unavailable when listing fails', async () => {
      mocks.runtime!.listNotificationSubscribers.mockRejectedValue(new Error('boom'));
      const res = await request(app).get(BASE).set('Authorization', ADMIN);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('reporting_unavailable');
    });
  });
});
