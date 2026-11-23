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
  logs: [] as unknown[][],
  getReporting: vi.fn(),
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
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: () => mocks.getReporting() }));
vi.mock('../../src/logger.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/logger.js')>();
  const record = (...args: unknown[]) => { mocks.logs.push(args); };
  const sink: Record<string, unknown> = { debug: record, info: record, warn: record, error: record, trace: record, fatal: record };
  sink.child = () => sink;
  return { ...original, createLogger: () => sink };
});

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
/** Audit rows in write order. */
function auditRows() {
  return auditInserts().map(([, params]) => {
    const p = params as string[];
    return { org: p[0], user: p[1], action: p[2], resource: p[3], details: JSON.parse(p[4]) as Record<string, any> };
  });
}
const actions = () => auditRows().map(r => r.action);

describe('admin training reporting subscriber routes', () => {
  const app = createApp();
  afterAll(() => stopAuthTimers());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logs.length = 0;
    mocks.runtime = {
      listNotificationSubscribers: vi.fn().mockResolvedValue([]),
      setNotificationSubscriberActive: vi.fn().mockResolvedValue('applied'),
    };
    mocks.getReporting.mockImplementation(() => mocks.runtime);
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
    it('suspends: intent row, runtime call, then an outcome row, all attributed', async () => {
      const order: string[] = [];
      mocks.runtime!.setNotificationSubscriberActive.mockImplementation(async () => { order.push('runtime'); return 'applied'; });
      mocks.poolQuery.mockImplementation((sql: string, params: string[]) => {
        if (sql.includes('INSERT INTO registry_audit_log')) order.push(params[2]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      });
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN)
        .set('X-Admin-Operator', 'alice').send({ reason: `  ${REASON}  ` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ account_id: 'acc-1', subscriber_id: 'sub-1', active: false, changed: true });
      expect(mocks.runtime!.setNotificationSubscriberActive).toHaveBeenCalledWith('acc-1', 'sub-1', false);
      expect(order).toEqual([
        'training_reporting_subscriber_suspend_requested', 'runtime', 'training_reporting_subscriber_suspended',
      ]);

      const [intent, outcome] = auditRows();
      for (const row of [intent, outcome]) {
        expect(row).toMatchObject({ org: 'system_training_agent', user: 'admin_api_key', resource: 'acc-1/sub-1' });
        expect(row.details).toMatchObject({
          account_id: 'acc-1', subscriber_id: 'sub-1', active: false, reason: REASON,
          admin_user_id: 'admin_api_key', operator: 'alice',
        });
        expect(typeof row.details.requested_at).toBe('string');
        expect(row.details.admin_key_fingerprint).toEqual(expect.any(String));
        expect(row.details.ip_address).toEqual(expect.any(String));
      }
      expect(intent.details.outcome).toBeUndefined();
      expect(outcome.details).toMatchObject({ outcome: 'applied', changed: true });
      expect(new Date(outcome.details.completed_at).toISOString()).toBe(outcome.details.completed_at);
    });

    it('resumes with the requested and resumed actions', async () => {
      const res = await request(app).post(RESUME).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ account_id: 'acc-1', subscriber_id: 'sub-1', active: true, changed: true });
      expect(mocks.runtime!.setNotificationSubscriberActive).toHaveBeenCalledWith('acc-1', 'sub-1', true);
      expect(actions()).toEqual(['training_reporting_subscriber_resume_requested', 'training_reporting_subscriber_resumed']);
    });

    it('is idempotent: unchanged gives 200 changed:false with both rows', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockResolvedValue('unchanged');
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      expect(actions()).toEqual(['training_reporting_subscriber_suspend_requested', 'training_reporting_subscriber_suspended']);
      expect(auditRows()[1].details).toMatchObject({ outcome: 'unchanged', changed: false });
    });

    it('404 subscriber_not_found: intent row plus a not_found _failed row', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockResolvedValue('not_found');
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('subscriber_not_found');
      expect(actions()).toEqual(['training_reporting_subscriber_suspend_requested', 'training_reporting_subscriber_suspend_failed']);
      expect(auditRows()[1].details.outcome).toBe('not_found');
    });

    it('422 subscription_set_invalid: intent plus a _failed row', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(
        new NotificationSubscriptionValidationError('bad destination', 0, 'url'));
      const res = await request(app).post(RESUME).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('subscription_set_invalid');
      expect(actions()).toEqual(['training_reporting_subscriber_resume_requested', 'training_reporting_subscriber_resume_failed']);
      expect(auditRows()[1].details).toMatchObject({ outcome: 'subscription_set_invalid', error_name: 'NotificationSubscriptionValidationError' });
    });

    it('503 reporting_unavailable on any other error: intent plus a _failed row, nothing leaked', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(new Error('pg: password=hunter2'));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'reporting_unavailable' });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(actions()).toEqual(['training_reporting_subscriber_suspend_requested', 'training_reporting_subscriber_suspend_failed']);
      const failed = auditRows()[1].details;
      expect(failed).toMatchObject({ outcome: 'unavailable', error_name: 'Error' });
      expect(JSON.stringify(failed)).not.toContain('hunter2');
    });

    it('503 reporting_disabled with no runtime, before any audit row', async () => {
      mocks.runtime = undefined;
      for (const url of [SUSPEND, RESUME]) {
        const res = await request(app).post(url).set('Authorization', ADMIN).send({ reason: REASON });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('reporting_disabled');
      }
      expect((await request(app).get(BASE).set('Authorization', ADMIN)).body.error).toBe('reporting_disabled');
      expect(auditInserts()).toHaveLength(0);
    });

    it('503 reporting_unavailable when getTrainingGcsReporting throws, before any audit row', async () => {
      mocks.getReporting.mockImplementation(() => { throw new Error('stopping'); });
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('reporting_unavailable');
      expect(auditInserts()).toHaveLength(0);
    });

    it('intent insert failure gives 500 audit_write_failed and never calls the runtime', async () => {
      mocks.poolQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT INTO registry_audit_log') ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [], rowCount: 1 }));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('audit_write_failed');
      expect(res.body.message).toMatch(/Nothing was changed/);
      expect(mocks.runtime!.setNotificationSubscriberActive).not.toHaveBeenCalled();
      expect(auditInserts()).toHaveLength(1);
    });

    it('outcome row failure is logged and does not change the response', async () => {
      const failing = (outcomeAction: string) => mocks.poolQuery.mockImplementation((sql: string, params: string[]) =>
        sql.includes('INSERT INTO registry_audit_log') && params[2] === outcomeAction
          ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [], rowCount: 1 }));

      failing('training_reporting_subscriber_suspended');
      const ok = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(ok.status).toBe(200);
      expect(ok.body.changed).toBe(true);

      failing('training_reporting_subscriber_suspend_failed');
      mocks.runtime!.setNotificationSubscriberActive.mockResolvedValue('not_found');
      expect((await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON })).status).toBe(404);
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(
        new NotificationSubscriptionValidationError('bad', 0, 'url'));
      expect((await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON })).status).toBe(422);
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(new Error('x'));
      expect((await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON })).status).toBe(503);
      expect(mocks.logs.some(args => String(args[args.length - 1]).includes('outcome audit write failed'))).toBe(true);
    });
  });

  describe('logging never carries raw errors', () => {
    const SECRET_URL = 'https://hooks.example.com/path?token=abc123';
    function leaky() {
      const root = Object.assign(new Error(`deadlock password=hunter2 ${SECRET_URL}`), { code: '40P01' });
      const wrapped = new Error(`wrapped ${SECRET_URL} password=hunter2`, { cause: root });
      wrapped.name = 'StorageError';
      return wrapped;
    }
    const logged = () => JSON.stringify(mocks.logs, (_k, v) => (v instanceof Error ? { __error: v.name, stack: v.stack } : v));
    const expectClean = () => {
      const text = logged();
      for (const forbidden of ['hunter2', 'hooks.example.com', 'abc123', 'stack', 'at /', '"err"', '__error']) {
        expect(text).not.toContain(forbidden);
      }
      for (const args of mocks.logs) {
        for (const arg of args) {
          if (arg && typeof arg === 'object') expect(Object.keys(arg)).not.toContain('err');
        }
      }
    };

    it('a runtime failure logs only error_name and database_code', async () => {
      mocks.runtime!.setNotificationSubscriberActive.mockRejectedValue(leaky());
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(503);
      expectClean();
      expect(mocks.logs.some(([facts]) => (facts as any)?.database_code === '40P01' && (facts as any)?.error_name === 'StorageError')).toBe(true);
      expect(auditRows()[1].details).toMatchObject({ outcome: 'unavailable', error_name: 'StorageError', database_code: '40P01' });
      expect(JSON.stringify(auditRows())).not.toContain('hunter2');
    });

    it('an audit insert failure logs only error_name and database_code', async () => {
      mocks.poolQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT INTO registry_audit_log') ? Promise.reject(leaky()) : Promise.resolve({ rows: [], rowCount: 1 }));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|abc123/);
      expectClean();
      expect(mocks.logs.some(([facts]) => (facts as any)?.database_code === '40P01' && (facts as any)?.error_name === 'StorageError')).toBe(true);
    });

    it('an outcome-row insert failure logs only error_name and database_code', async () => {
      mocks.poolQuery.mockImplementation((sql: string, params: string[]) =>
        sql.includes('INSERT INTO registry_audit_log') && params[2] === 'training_reporting_subscriber_suspended'
          ? Promise.reject(leaky()) : Promise.resolve({ rows: [], rowCount: 1 }));
      const res = await request(app).post(SUSPEND).set('Authorization', ADMIN).send({ reason: REASON });
      expect(res.status).toBe(200);
      expectClean();
      expect(mocks.logs.some(([facts]) => (facts as any)?.database_code === '40P01')).toBe(true);
    });

    it('a list failure logs no raw error either', async () => {
      mocks.runtime!.listNotificationSubscribers.mockRejectedValue(leaky());
      expect((await request(app).get(BASE).set('Authorization', ADMIN)).status).toBe(503);
      expectClean();
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
