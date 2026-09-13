import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWithTimeout } from '../../src/db/client.js';
import {
  AuthorizationSnapshotUnavailableError,
  loadAuthorizationSnapshot,
  sameAuthorizationIdentity,
  sameAuthorizationSnapshot,
  type AuthorizationSnapshot,
} from '../../src/db/user-authorization-snapshot-db.js';

vi.mock('../../src/db/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/db/client.js')>(),
  queryWithTimeout: vi.fn(),
}));

const boundedQuery = vi.mocked(queryWithTimeout);
const USER_ID = 'user_snapshot_timeout';
const ORGANIZATION_ID = 'org_snapshot_timeout';

function queryResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      in_recovery: false,
      authenticated_user_id: USER_ID,
      canonical_user_id: USER_ID,
      identity_id: 'fd3043f7-cb4f-43c7-9b81-22ac97576150',
      authorization_epoch: '7',
      email: 'sam@pinnacle.example',
      email_verified: true,
      email_mutation_pending: false,
      first_name: 'Sam',
      last_name: 'Adeyemi',
      grant_id: null,
      grant_organization_id: null,
      grant_role: null,
      grant_effective_from: null,
      grant_effective_until: null,
      ...overrides,
    }],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

describe('authorization snapshot query deadline and connection retry', () => {
  beforeEach(() => {
    boundedQuery.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries one transient connection failure with only the remaining absolute budget', async () => {
    boundedQuery.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 700);
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    }).mockResolvedValueOnce(queryResult());

    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID)).resolves.toMatchObject({
      authenticatedUserId: USER_ID,
      selectedOrganizationId: ORGANIZATION_ID,
      authorizationEpoch: '7',
    });
    expect(boundedQuery).toHaveBeenCalledTimes(2);
    const [first, second] = boundedQuery.mock.calls;
    expect(first[2]).toBe(2_000);
    expect(first[3]).toEqual({ retryTransientCheckout: false });
    expect(second).toEqual([first[0], first[1], 1_300, { retryTransientCheckout: false }]);
    expect(first[1]).toEqual([USER_ID, ORGANIZATION_ID]);
  });

  it('stops after two connection failures and permits a clean request after recovery', async () => {
    boundedQuery.mockRejectedValue(Object.assign(new Error('private connection details'), { code: 'EPIPE' }));
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toThrow(new AuthorizationSnapshotUnavailableError());
    expect(boundedQuery).toHaveBeenCalledTimes(2);

    boundedQuery.mockResolvedValueOnce(queryResult());
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID)).resolves.toMatchObject({
      authenticatedUserId: USER_ID, authorizationEpoch: '7',
    });
    expect(boundedQuery).toHaveBeenCalledTimes(3);
  });

  it('does not start a retry after the first attempt exhausts the deadline', async () => {
    boundedQuery.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2_000);
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    });
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
    expect(boundedQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects a result delivered after the absolute deadline without retrying', async () => {
    boundedQuery.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2_001);
      return queryResult();
    });
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
    expect(boundedQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '55P03', message: 'canceling statement due to lock timeout' },
    { code: '42P01', message: 'relation does not exist' },
  ])('does not retry a non-connection database error ($code)', async ({ code, message }) => {
    boundedQuery.mockRejectedValue(Object.assign(new Error(message), { code }));
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toThrow(new AuthorizationSnapshotUnavailableError());
    expect(boundedQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    { state: 'replica', row: { in_recovery: true } },
    { state: 'missing primary confirmation', row: { in_recovery: undefined } },
    { state: 'malformed primary confirmation', row: { in_recovery: 0 } },
    { state: 'missing primary identity', row: { canonical_user_id: null } },
  ])('does not retry an unavailable $state snapshot', async ({ row }) => {
    boundedQuery.mockResolvedValue(queryResult(row));
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
    expect(boundedQuery).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 'false', 'true', 0, 1, {}, []])(
    'fails closed for a missing or malformed email mutation flag (%j)', async value => {
      boundedQuery.mockResolvedValue(queryResult({ email_mutation_pending: value }));
      await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
        .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
      expect(boundedQuery).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])('preserves an explicit email mutation flag %s', async pending => {
    boundedQuery.mockResolvedValue(queryResult({ email_mutation_pending: pending }));
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID)).resolves.toMatchObject({
      credential: { emailMutationPending: pending },
    });
  });

  it('rejects old or malformed snapshot replay even when both flags are missing', async () => {
    boundedQuery.mockResolvedValue(queryResult());
    const current = (await loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))!;
    for (const value of [undefined, null, 'false', 0]) {
      const malformed = {
        ...current, credential: { ...current.credential, emailMutationPending: value },
      } as unknown as AuthorizationSnapshot;
      expect(sameAuthorizationIdentity(malformed, current)).toBe(false);
      expect(sameAuthorizationIdentity(current, malformed)).toBe(false);
      expect(sameAuthorizationSnapshot(malformed, malformed)).toBe(false);
    }
  });
});
