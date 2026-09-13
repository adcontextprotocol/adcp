import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const binding = vi.hoisted(() => ({ createAndBindAdminCredential: vi.fn() }));
const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getWorkos: vi.fn(),
  query: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  getUser: vi.fn(),
  sendEmailLinkVerification: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_identity_containment';
  process.env.WORKOS_CLIENT_ID ??= 'client_test_identity_containment';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

// Exercise the registered routers after the authentication boundary, without a
// database. Any handler that reaches a provider or local data seam fails here.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-test-unauthenticated']) return res.sendStatus(401);
    req.user = {
      id: String(req.headers['x-test-user'] || 'user_member'),
      authWorkosUserId: 'user_signed_in_credential',
      identityId: '00000000-0000-4000-8000-000000000682',
      email: 'member@example.test',
      emailVerified: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    req.adminAccessMechanism = req.headers['x-test-admin-access-mechanism'] as typeof req.adminAccessMechanism;
    next();
  };
  return { ...original, requireAuth: authenticate, requireGlobalAdmin: [authenticate] };
});

vi.mock('../../src/services/admin-credential-bind.js', () => binding);

vi.mock('../../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/client.js')>()),
  getPool: mocks.getPool,
  query: mocks.query,
}));
vi.mock('../../src/auth/workos-client.js', () => {
  const workos = { userManagement: {
    createUser: mocks.createUser,
    updateUser: mocks.updateUser,
    deleteUser: mocks.deleteUser,
    getUser: mocks.getUser,
  } };
  return { workos, getWorkos: () => { mocks.getWorkos(); return workos; } };
});
vi.mock('../../src/routes/workos-webhooks.js', () => ({
  backfillOrganizationMemberships: vi.fn(),
  backfillUsers: vi.fn(),
  backfillOrganizationDomains: vi.fn(),
}));
vi.mock('../../src/notifications/email.js', () => ({
  sendEmailLinkVerification: mocks.sendEmailLinkVerification,
  sendSlackInviteEmail: vi.fn(),
  hasSlackInviteBeenSent: vi.fn(),
}));

import { createAdminUsersRouter } from '../../src/routes/admin/users.js';
import { createAccountLinkingRouter } from '../../src/routes/account-linking.js';
import { stopAuthTimers } from '../../src/middleware/auth.js';

const app = express();
app.use(express.json());
app.use('/api/admin/users', createAdminUsersRouter());
app.use('/api/me/linked-emails', createAccountLinkingRouter());

const refusal = {
  error: 'identity_mutation_disabled',
  message: 'Identity consolidation is disabled until authority and provenance can be preserved.',
};
const operations = [
  { method: 'post', path: '/api/admin/users/user_member/credentials', body: { workos_user_id: 'user_admin' } },
  { method: 'post', path: '/api/admin/users/user_admin/credentials', body: { workos_user_id: 'user_member' } },
  { method: 'post', path: '/api/admin/users/user_member/credentials/user_admin/promote', body: {} },
  { method: 'post', path: '/api/admin/users/user_admin/credentials/user_member/promote', body: {} },
  { method: 'post', path: '/api/admin/users/user_missing/credentials/user_missing/promote', body: {} },
  { method: 'put', path: '/api/me/linked-emails/primary', body: { email: 'admin@example.test' } },
] as const;

function expectNoDataAccess() {
  for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
}

describe('identity mutation route containment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getPool.mockImplementation(() => { throw new Error('Unexpected database pool access'); });
    mocks.query.mockImplementation(() => { throw new Error('Unexpected database query'); });
  });

  it.each(operations)('refuses $method $path before provider or local access', async ({ method, path, body }) => {
    for (const consolidate of [false, true]) {
      for (const mechanism of ['sso', 'static_admin_api_key']) {
        const response = await request(app)[method](path)
          .set('X-Test-Admin-Access-Mechanism', mechanism)
          .send({ ...body, consolidate })
          .expect(409);
        expect(response.body).toEqual(refusal);
        expectNoDataAccess();
      }
    }
  });

  it.each(operations)('still authenticates $method $path', async ({ method, path, body }) => {
    await request(app)[method](path)
      .set('X-Test-Unauthenticated', 'true')
      .send(body)
      .expect(401);
    expectNoDataAccess();
  });

  it('refuses concurrent and replayed calls in both identity directions', async () => {
    const invoke = ({ method, path, body }: typeof operations[number]) => request(app)[method](path)
      .send({ ...body, consolidate: true })
      .expect(409)
      .expect(({ body }) => expect(body).toEqual(refusal));
    await Promise.all([...operations, ...operations].map(invoke));
    for (const operation of operations) await invoke(operation);
    expectNoDataAccess();
  });

  it.each([{}, { email: null }, { email: 'member@example.test' }, { workos_user_id: 'invalid' }])(
    'cannot bypass refusal through missing, same-identity, or invalid input: %j', async (body) => {
      for (const { method, path } of operations) {
        await request(app)[method](path).send(body).expect(409)
          .expect(({ body }) => expect(body).toEqual(refusal));
      }
      expectNoDataAccess();
    },
  );

  it('routes fresh admin creation to the compensating binding service with the exact actor', async () => {
    binding.createAndBindAdminCredential.mockResolvedValue({ status: 201, body: { bound: true } });
    await request(app).post('/api/admin/users/user_member/linked-emails')
      .send({ email: 'NEW@example.test' }).expect(201);
    expect(binding.createAndBindAdminCredential).toHaveBeenCalledExactlyOnceWith({
      hostUserId: 'user_member', email: 'new@example.test',
      actorUserId: 'user_signed_in_credential',
      actorIdentityId: '00000000-0000-4000-8000-000000000682',
    });
    expectNoDataAccess();
  });

  it.each([{ consolidate: true }, { promote: true }])('contains destructive create-and-bind options: %j', async (body) => {
    await request(app).post('/api/admin/users/user_member/linked-emails')
      .send({ email: 'new@example.test', ...body }).expect(409);
    expect(binding.createAndBindAdminCredential).not.toHaveBeenCalled();
    expectNoDataAccess();
  });

  it('keeps fresh admin creation behind authentication and an identity-bearing actor', async () => {
    await request(app).post('/api/admin/users/user_member/linked-emails')
      .set('X-Test-Unauthenticated', 'true').send({ email: 'new@example.test' }).expect(401);
    await request(app).post('/api/admin/users/user_member/linked-emails')
      .set('X-Test-Admin-Access-Mechanism', 'static_admin_api_key')
      .send({ email: 'new@example.test' }).expect(403);
    expect(binding.createAndBindAdminCredential).not.toHaveBeenCalled();
    expectNoDataAccess();
  });

  it('refuses a member attempt to combine existing accounts without issuing a token or email', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      if (sql.includes('FROM users')) return { rows: [{ workos_user_id: 'user_existing', email: 'existing@example.test' }] };
      if (sql.trimStart().startsWith('SELECT')) return { rows: [] };
      throw new Error(`Unexpected mutation: ${sql}`);
    });
    const response = await request(app).post('/api/me/linked-emails')
      .send({ email: 'existing@example.test', consolidate: true }).expect(409);
    expect(response.body.error).toBe('This email already has an AAO account');
    expect(mocks.query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(mocks.sendEmailLinkVerification).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
    for (const method of [mocks.createUser, mocks.updateUser, mocks.deleteUser]) expect(method).not.toHaveBeenCalled();
  });
});

afterAll(() => stopAuthTimers());
