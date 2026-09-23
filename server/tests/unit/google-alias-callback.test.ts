import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  authenticateWithCode: vi.fn(),
  listUsers: vi.fn(),
  listOrganizationMemberships: vi.fn(),
  createOrganizationMembership: vi.fn(),
  updateOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  warn: vi.fn(),
  resolvePersonId: vi.fn(),
  recordPersonMessage: vi.fn(),
  deriveSentiment: vi.fn(),
  evaluateStageTransitions: vi.fn(),
  recordEvent: vi.fn(),
  buildMessageReceivedData: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_google_alias_callback';
  process.env.WORKOS_CLIENT_ID = 'client_test_google_alias_callback';
  process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-at-least-32-characters';
  process.env.WORKOS_REDIRECT_URI = 'https://agenticadvertising.org/auth/callback';
  delete process.env.DEV_USER_EMAIL;
  delete process.env.DEV_USER_ID;
});

vi.mock('@workos-inc/node', () => ({
  DomainDataState: { Verified: 'verified' },
  WorkOS: class WorkOS {
    userManagement = {
      authenticateWithCode: mocks.authenticateWithCode,
      listUsers: mocks.listUsers,
      listOrganizationMemberships: mocks.listOrganizationMemberships,
      createOrganizationMembership: mocks.createOrganizationMembership,
      updateOrganizationMembership: mocks.updateOrganizationMembership,
      deleteOrganizationMembership: mocks.deleteOrganizationMembership,
      createUser: mocks.createUser,
      updateUser: mocks.updateUser,
      deleteUser: mocks.deleteUser,
    };
    organizations = {};
    apiKeys = {};
  },
}));

vi.mock('../../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/config.js')>(),
  getDatabaseConfig: vi.fn().mockReturnValue({ connectionString: 'postgresql://localhost/test' }),
}));

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  getPool: () => ({ query: mocks.query, connect: mocks.connect }),
  isDatabaseInitialized: () => false,
  closeDatabase: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(undefined),
  query: mocks.query,
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

// Keep the callback test focused on alias containment. Current main finalizes
// the login through the credential-event transaction, so provide that
// transaction boundary while retaining the production upsert implementation.
vi.mock('../../src/db/identity-db.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/db/identity-db.js')>(),
  withCredentialCreationEventMutation: async <T>(
    _workosUserId: string,
    mutation: (client: { query: typeof mocks.query }) => Promise<T>,
  ) => ({ applied: true, value: await mutation({ query: mocks.query }) }),
}));

vi.mock('../../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return {
    ...actual,
    createLogger: (context: string | Record<string, unknown>) => {
      const logger = actual.createLogger(context);
      if (context === 'http-server') logger.warn = mocks.warn;
      return logger;
    },
  };
});

// Keep unrelated login tracking local; alias detection itself runs unchanged.
vi.mock('../../src/db/relationship-db.js', () => ({
  resolvePersonId: mocks.resolvePersonId,
  recordPersonMessage: mocks.recordPersonMessage,
  deriveSentiment: mocks.deriveSentiment,
  evaluateStageTransitions: mocks.evaluateStageTransitions,
}));
vi.mock('../../src/db/person-events-db.js', () => ({
  recordEvent: mocks.recordEvent,
  buildMessageReceivedData: mocks.buildMessageReceivedData,
}));

const { HTTPServer } = await import('../../src/http.js');
const { OrganizationDatabase } = await import('../../src/db/organization-db.js');
const { SlackDatabase } = await import('../../src/db/slack-db.js');
const userMergeDb = await import('../../src/db/user-merge-db.js');

const accounts = [
  { id: 'user_gmail', email: 'alex@gmail.com', organizationId: 'org_pinnacle' },
  { id: 'user_googlemail', email: 'alex@googlemail.com', organizationId: 'org_nova' },
];
const SEALED_SESSION = 'SEALED_SESSION_SECRET';
const FAILURE_SECRET = 'PROVIDER_REQUEST_SECRET';

function appFor(server: HTTPServer) {
  return (server as unknown as { app: Parameters<typeof request>[0] }).app;
}

describe.each(accounts)('Google alias callback for $email', (account) => {
  let server: HTTPServer | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.resolvePersonId.mockResolvedValue(`person_${account.id}`);
    mocks.recordPersonMessage.mockResolvedValue(undefined);
    mocks.deriveSentiment.mockResolvedValue(undefined);
    mocks.evaluateStageTransitions.mockResolvedValue(undefined);
    mocks.recordEvent.mockResolvedValue(undefined);
    mocks.buildMessageReceivedData.mockReturnValue({});
    mocks.authenticateWithCode.mockResolvedValue({
      sealedSession: SEALED_SESSION,
      user: {
        id: account.id,
        email: account.email,
        firstName: 'Alex',
        lastName: 'Reeves',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    mocks.listOrganizationMemberships.mockImplementation(async ({ userId }) => ({
      data: accounts.filter((candidate) => candidate.id === userId).map((candidate) => ({
        id: `membership_${candidate.id}`,
        userId: candidate.id,
        organizationId: candidate.organizationId,
        status: 'active',
        role: { slug: candidate.id === 'user_gmail' ? 'member' : 'admin' },
      })),
    }));
    vi.spyOn(OrganizationDatabase.prototype, 'getUserAgreementAcceptances').mockResolvedValue([{
      agreement_type: 'terms_of_service',
      agreement_version: '1',
      accepted_at: new Date('2026-01-01T00:00:00.000Z'),
      ip_address: null,
      user_agent: null,
    }]);
    vi.spyOn(OrganizationDatabase.prototype, 'getCurrentAgreementByType').mockResolvedValue(null);
    vi.spyOn(OrganizationDatabase.prototype, 'ensureOrganizationExists').mockResolvedValue({
      workos_organization_id: account.organizationId,
    } as never);
    vi.spyOn(OrganizationDatabase.prototype, 'recordUserLogin').mockResolvedValue(undefined);
    vi.spyOn(SlackDatabase.prototype, 'getByWorkosUserId').mockResolvedValue({
      slack_user_id: `slack_${account.id}`,
      workos_user_id: account.id,
    } as never);
    vi.spyOn(userMergeDb, 'mergeUsers');
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.restoreAllMocks();
  });

  it.each(['provider lookup', 'audit insert'] as const)(
    'completes ordinary login without authority union when %s fails',
    async (failurePoint) => {
      const duplicate = accounts.find((candidate) => candidate.id !== account.id)!;
      mocks.listUsers.mockImplementation(async ({ email }) => ({
        data: email === duplicate.email ? [{ id: duplicate.id, email: duplicate.email }] : [],
      }));
      if (failurePoint === 'provider lookup') {
        mocks.listUsers.mockRejectedValue(new Error(FAILURE_SECRET));
      } else {
        mocks.query.mockImplementation(async (sql: string) => {
          if (sql.includes('INSERT INTO registry_audit_log')) throw new Error(FAILURE_SECRET);
          return { rows: [], rowCount: 0 };
        });
      }
      server = new HTTPServer();
      const returnTo = `/dashboard?org=${account.organizationId}`;

      const response = await request(appFor(server)).get('/auth/callback').query({
        code: 'workos-authorization-code',
        state: JSON.stringify({ return_to: returnTo }),
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(returnTo);
      expect(response.headers['cache-control']).toBe('no-store');
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies).toContainEqual(expect.stringMatching(/^wos-session=SEALED_SESSION_SECRET;/));
      expect(cookies.find((cookie) => cookie.startsWith('wos-session='))).toContain('HttpOnly');
      expect(mocks.listUsers).toHaveBeenCalledWith({ email: duplicate.email });
      expect(mocks.listOrganizationMemberships).toHaveBeenCalledExactlyOnceWith({ userId: account.id });
      expect(OrganizationDatabase.prototype.ensureOrganizationExists).toHaveBeenCalledExactlyOnceWith(
        expect.anything(), account.organizationId,
      );
      expect(OrganizationDatabase.prototype.recordUserLogin).toHaveBeenCalledExactlyOnceWith({
        workos_user_id: account.id,
        workos_organization_id: account.organizationId,
        user_name: 'Alex Reeves',
      });
      expect(mocks.resolvePersonId).toHaveBeenCalledExactlyOnceWith({
        workos_user_id: account.id, email: account.email,
      });

      expect(userMergeDb.mergeUsers).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
      for (const mutation of [
        mocks.createOrganizationMembership, mocks.updateOrganizationMembership,
        mocks.deleteOrganizationMembership, mocks.createUser, mocks.updateUser, mocks.deleteUser,
      ]) {
        expect(mutation).not.toHaveBeenCalled();
      }
      const writes = mocks.query.mock.calls.filter(([sql]) => !sql.trim().startsWith('SELECT'));
      expect(writes).toHaveLength(failurePoint === 'audit insert' ? 2 : 1);
      expect(writes[0][0]).toMatch(/INSERT INTO users \(\s*workos_user_id, email,/);
      expect(writes[0][1].slice(0, 2)).toEqual([account.id, account.email]);
      expect(mocks.query.mock.calls.map(([sql]) => sql).join('\n'))
        .not.toMatch(/user_email_aliases|identity_workos_users|organization_memberships|DELETE FROM users/);
      if (failurePoint === 'audit insert') {
        expect(writes[1][0]).toContain('INSERT INTO registry_audit_log');
        expect(writes[1][1]).toEqual([
          account.id, duplicate.id, JSON.stringify({ outcome: 'support_review_required' }),
        ]);
      }
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
        { userId: account.id }, 'Google alias detection unavailable',
      );
      expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(FAILURE_SECRET);
      expect(response.headers.location).not.toContain(SEALED_SESSION);
      expect(response.text).not.toContain(FAILURE_SECRET);
    },
  );
});
