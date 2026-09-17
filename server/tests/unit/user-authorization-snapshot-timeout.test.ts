import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWithTimeout } from '../../src/db/client.js';
import { loadApiKeyManagementSnapshot } from '../../src/db/api-key-management-db.js';
import {
  AuthorizationSnapshotUnavailableError,
  loadAuthorizationSnapshot,
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
      in_recovery: false, terminal_marker: false, primary_count: '1',
      authenticated_user_id: USER_ID,
      canonical_user_id: USER_ID,
      identity_id: 'fd3043f7-cb4f-43c7-9b81-22ac97576150',
      binding_version: '42',
      authorization_epoch: '7',
      email: 'sam@pinnacle.example',
      email_verified: true,
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

  it.each([
    { terminal_marker: true }, { primary_count: '0' }, { primary_count: '2' },
    { identity_id: null }, { binding_version: null }, { canonical_user_id: null },
  ])('denies terminal lifecycle state without retrying: %j', async invalid => {
    boundedQuery.mockResolvedValue(queryResult(invalid));
    expect(await loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID)).toBeNull();
    expect(boundedQuery).toHaveBeenCalledOnce();
  });

  it.each([
    { terminal_marker: true }, { primary_count: '0' }, { primary_count: '2' },
    { primary_count: undefined }, { authenticated_user_id: null },
    { identity_id: null }, { binding_version: null }, { canonical_user_id: null },
  ])('management denies terminal or ambiguous lifecycle state without retry: %j', async invalid => {
    boundedQuery.mockResolvedValue(queryResult(invalid));
    expect(await loadApiKeyManagementSnapshot(USER_ID, ORGANIZATION_ID)).toBeNull();
    expect(boundedQuery).toHaveBeenCalledOnce();
  });

  it('management retains exact bigint epochs and ignores grants in a valid lifecycle snapshot', async () => {
    boundedQuery.mockResolvedValue(queryResult({ authorization_epoch: '9007199254740993', grant_role: 'owner' }));
    const snapshot = await loadApiKeyManagementSnapshot(USER_ID, ORGANIZATION_ID);
    expect(snapshot).toMatchObject({
      authenticatedUserId: USER_ID, canonicalUserId: USER_ID,
      bindingVersion: '42', authorizationEpoch: '9007199254740993', credentialGrant: null,
    });
    expect(boundedQuery).toHaveBeenCalledOnce();
    expect(boundedQuery.mock.calls[0][0]).not.toContain('organization_credential_grants');
  });

  it('management fails unavailable on recovery or audit-read failure without retry', async () => {
    boundedQuery.mockResolvedValueOnce(queryResult({ in_recovery: true }));
    await expect(loadApiKeyManagementSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toThrow(AuthorizationSnapshotUnavailableError);
    boundedQuery.mockRejectedValueOnce(new Error('audit store unavailable'));
    await expect(loadApiKeyManagementSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toThrow(AuthorizationSnapshotUnavailableError);
    expect(boundedQuery).toHaveBeenCalledTimes(2);
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
    expect(first[3]).toEqual({
      retryTransientCheckout: false,
      deadlineMs: Date.parse('2026-01-01T00:00:02Z'),
    });
    expect(second).toEqual([first[0], first[1], 1_300, {
      retryTransientCheckout: false,
      deadlineMs: first[3]?.deadlineMs,
    }]);
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
  ])('does not retry an unavailable $state snapshot', async ({ row }) => {
    boundedQuery.mockResolvedValue(queryResult(row));
    await expect(loadAuthorizationSnapshot(USER_ID, ORGANIZATION_ID))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
    expect(boundedQuery).toHaveBeenCalledTimes(1);
  });
});
