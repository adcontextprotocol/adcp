import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  enforcementWorkos: {
    userManagement: {
      listOrganizationMemberships: vi.fn(),
      getUser: vi.fn(),
    },
  },
  getEnforcementWorkos: vi.fn(),
  getDefaultWorkos: vi.fn(),
  upsertOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
  deleteExactOrganizationMembership: vi.fn(),
  consumeInvitationSeatType: vi.fn(),
  canAddSeat: vi.fn(),
  activeCredentialMutation: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: mocks.getEnforcementWorkos,
  getWorkos: mocks.getDefaultWorkos,
}));

vi.mock('../../src/db/identity-db.js', () => ({
  upsertWorkosUserInCredentialEvent: vi.fn(),
  upsertWorkosUserUnlessConfirmedDeleted: vi.fn(),
  withCredentialCreationEventMutation: vi.fn(),
  withActiveCredentialEventMutation: mocks.activeCredentialMutation,
  withActiveCredentialEventMutationAfterSerializedPrefetch: mocks.activeCredentialMutation,
}));

vi.mock('../../src/db/membership-db.js', () => ({
  upsertOrganizationMembership: mocks.upsertOrganizationMembership,
  deleteOrganizationMembership: mocks.deleteOrganizationMembership,
  deleteExactOrganizationMembership: mocks.deleteExactOrganizationMembership,
  consumeInvitationSeatType: mocks.consumeInvitationSeatType,
}));

vi.mock('../../src/db/organization-db.js', () => ({
  OrganizationDatabase: class MockOrganizationDatabase {},
  canAddSeat: mocks.canAddSeat,
}));

vi.mock('../../src/db/users-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/users-db.js')>()),
  resolvePreferredOrganization: vi.fn().mockResolvedValue(null),
  backfillPrimaryOrganization: vi.fn(),
}));

import { upsertMembership } from '../../src/routes/workos-webhooks.js';

const membership = {
  id: 'om_webhook_lock_test',
  user_id: 'user_webhook_lock_test',
  organization_id: 'org_webhook_lock_test',
  status: 'active' as const,
  role: { slug: 'member' },
  created_at: '2026-09-17T00:00:00.000Z',
  updated_at: '2026-09-17T00:00:00.000Z',
};

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function clientWith(query: (sql: string) => Promise<unknown>): MockClient {
  return { query: vi.fn(query), release: vi.fn() };
}

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.getEnforcementWorkos.mockReset().mockReturnValue(mocks.enforcementWorkos);
  mocks.getDefaultWorkos.mockReset();
  mocks.enforcementWorkos.userManagement.listOrganizationMemberships.mockReset();
  mocks.enforcementWorkos.userManagement.getUser.mockReset();
  mocks.upsertOrganizationMembership.mockReset().mockResolvedValue(undefined);
  mocks.deleteOrganizationMembership.mockReset().mockResolvedValue(null);
  mocks.deleteExactOrganizationMembership.mockReset().mockResolvedValue({ matched: false, role: null });
  mocks.consumeInvitationSeatType.mockReset().mockResolvedValue(null);
  mocks.canAddSeat.mockReset().mockResolvedValue({ allowed: true });
  mocks.activeCredentialMutation.mockReset().mockImplementation(async (_userId, prefetch, mutation) => {
    await prefetch();
    const client = await mocks.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      const value = await mutation(client);
      await client.query('COMMIT');
      return { applied: true, value };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
});

describe('organization membership webhook lock budgets', () => {
  it('does not consult the provider when the exact credential lifecycle fence rejects the event', async () => {
    mocks.activeCredentialMutation.mockResolvedValueOnce({ applied: false });

    await expect(upsertMembership(membership)).resolves.toBe(false);

    expect(mocks.enforcementWorkos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(mocks.enforcementWorkos.userManagement.getUser).not.toHaveBeenCalled();
    expect(mocks.upsertOrganizationMembership).not.toHaveBeenCalled();
    expect(mocks.deleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mocks.deleteExactOrganizationMembership).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('uses the fail-fast exact-credential client during serialized prefetch before local writes', async () => {
    const active = {
      id: membership.id,
      userId: membership.user_id,
      organizationId: membership.organization_id,
      status: membership.status,
      role: membership.role,
    };
    mocks.enforcementWorkos.userManagement.listOrganizationMemberships
      .mockResolvedValue({ data: [active], listMetadata: {} });
    mocks.enforcementWorkos.userManagement.getUser.mockResolvedValue({
      id: membership.user_id,
      email: 'member@example.test',
      firstName: 'Sam',
      lastName: 'Adeyemi',
      emailVerified: true,
      createdAt: membership.created_at,
      updatedAt: membership.updated_at,
    });
    const client = clientWith(async (sql) => {
      if (sql.includes('FROM organizations')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FROM organization_memberships')) {
        return { rowCount: 1, rows: [{ seat_type: 'community_only', provisioning_source: 'webhook' }] };
      }
      return { rowCount: 0, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);

    await expect(upsertMembership(membership)).resolves.toBe(true);

    expect(mocks.enforcementWorkos.userManagement.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.enforcementWorkos.userManagement.getUser).toHaveBeenCalledOnce();
    expect(mocks.getDefaultWorkos).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql).slice(0, 3)).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '1s'",
      'SELECT workos_organization_id FROM organizations WHERE workos_organization_id = $1 FOR UPDATE',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not enter the local mutation while serialized provider prefetch is pending', async () => {
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolveStarted) => {
      mocks.enforcementWorkos.userManagement.listOrganizationMemberships.mockImplementationOnce(() =>
        new Promise((resolveProvider) => {
          releaseProvider = () => resolveProvider({ data: [], listMetadata: {} });
          resolveStarted();
        }),
      );
    });
    const client = clientWith(async (sql) => {
      if (sql.includes('FROM organizations')) return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);

    const holdingWrite = upsertMembership(membership);
    await providerStarted;
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.upsertOrganizationMembership).not.toHaveBeenCalled();
    expect(mocks.deleteOrganizationMembership).not.toHaveBeenCalled();
    expect(mocks.deleteExactOrganizationMembership).not.toHaveBeenCalled();

    releaseProvider();
    await expect(holdingWrite).resolves.toBe(false);
    expect(mocks.deleteExactOrganizationMembership).toHaveBeenCalledOnce();
    expect(mocks.deleteOrganizationMembership).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });
});
