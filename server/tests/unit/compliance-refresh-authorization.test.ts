import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceRefreshRequest } from '../../src/db/compliance-refresh-requests-db.js';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), getWorkos: vi.fn(), query: vi.fn(), fingerprint: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({ getAuthorizationEnforcementWorkos: mocks.getWorkos }));
vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  withDatabaseDeadline: (_deadline: number, operation: () => unknown) => operation(),
}));
vi.mock('../../src/db/authorization-epoch-db.js', () => ({ getAuthorizationFingerprint: mocks.fingerprint }));

import {
  authorizeComplianceRefresh,
  captureComplianceRefreshAuthorization,
  isRefreshAdmin,
  isRefreshOwner,
  resolveRefreshOwnerOrg,
} from '../../src/services/compliance-refresh-authorization.js';

const userRequest = {
  requester_type: 'user',
  requested_by_user_id: 'user_exact',
  requested_by_auth_workos_user_id: 'user_exact',
  authorization_fingerprint: '',
  triggered_by: 'manual',
  owner_org_id: null,
  agent_url: 'https://agent.example.test/mcp',
} as ComplianceRefreshRequest;

describe('queued compliance refresh authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getWorkos.mockReturnValue({ userManagement: { getUser: mocks.getUser } });
    mocks.getUser.mockResolvedValue({ id: 'user_exact', email: 'current@example.test' });
    mocks.fingerprint.mockResolvedValue('');
    mocks.query.mockResolvedValue({ rows: [{ is_admin: true }] });
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses only the exact live credential and current email for administrator authority', async () => {
    await authorizeComplianceRefresh(userRequest);
    expect(mocks.getUser).toHaveBeenCalledWith('user_exact');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('working_group_memberships'), ['user_exact']);
    expect(mocks.fingerprint).toHaveBeenCalledWith(['user_exact']);
  });

  it.each([401, 403, 408, 429, 500, 503])('treats WorkOS HTTP %s as unavailable without consulting local admin authority', async (status) => {
    mocks.getUser.mockRejectedValue({ status });
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('treats missing WorkOS configuration as unavailable', async () => {
    mocks.getWorkos.mockImplementation(() => { throw new Error('missing configuration'); });
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('bounds a stalled WorkOS body and cannot authorize from its late response', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (credential: { id: string; email: string }) => void;
      mocks.getUser.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const authorization = authorizeComplianceRefresh(userRequest);
      const rejected = expect(authorization).rejects.toMatchObject({ code: 'authorization_unavailable' });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      finish({ id: 'user_exact', email: 'current@example.test' });
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.query).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not authorize using a malformed WorkOS email', async () => {
    mocks.getUser.mockResolvedValue({ id: 'user_exact', email: null });
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('keeps unavailable owner authorization distinct from revoked membership', async () => {
    const request = { ...userRequest, triggered_by: 'owner_test' as const, owner_org_id: 'org_exact' };
    mocks.query.mockRejectedValue(new Error('database unavailable'));
    await expect(authorizeComplianceRefresh(request)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(authorizeComplianceRefresh(request)).rejects.toMatchObject({ code: 'authorization_revoked' });
    expect(mocks.query.mock.calls.every(([sql]) => !sql.includes('working_group_memberships'))).toBe(true);
  });

  it('keeps unavailable administrator authority distinct from a revoked grant', async () => {
    mocks.query.mockRejectedValue(new Error('administrator authority unavailable'));
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    mocks.query.mockResolvedValue({ rows: [{ is_admin: false }] });
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_revoked' });
  });

  it('keeps owner admission and polling outages retryable for the exact credential', async () => {
    const principal = { id: 'user_canonical', authWorkosUserId: 'user_exact' };
    mocks.query.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveRefreshOwnerOrg(principal, userRequest.agent_url)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    await expect(isRefreshOwner(principal, 'org_exact', userRequest.agent_url)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.query.mock.calls.every(([, parameters]) => parameters.includes('user_exact') && !parameters.includes('user_canonical'))).toBe(true);
  });

  it('rejects unverifiable user provenance before any authority lookup', async () => {
    await expect(authorizeComplianceRefresh({ ...userRequest, requested_by_auth_workos_user_id: '' }))
      .rejects.toMatchObject({ code: 'authorization_provenance_missing' });
    expect(mocks.getWorkos).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('captures only the exact credential epoch after live authorization', async () => {
    mocks.fingerprint.mockResolvedValue('user_exact:4');
    await expect(captureComplianceRefreshAuthorization(userRequest)).resolves.toBe('user_exact:4');
    expect(mocks.fingerprint.mock.calls.every(([ids]) => ids.length === 1 && ids[0] === 'user_exact')).toBe(true);
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith('user_exact');
  });

  it('rejects an epoch change between admission capture and live credential lookup', async () => {
    mocks.fingerprint.mockResolvedValueOnce('').mockResolvedValue('user_exact:1');
    await expect(captureComplianceRefreshAuthorization(userRequest))
      .rejects.toMatchObject({ code: 'authorization_revoked' });
    expect(mocks.getWorkos).not.toHaveBeenCalled();
  });

  it.each(['admission', 'execution'])('rejects an epoch change during the %s WorkOS await', async (phase) => {
    mocks.getUser.mockImplementationOnce(async () => {
      mocks.fingerprint.mockResolvedValue('user_exact:1');
      return { id: 'user_exact', email: 'current@example.test' };
    });
    const authorize = phase === 'admission' ? captureComplianceRefreshAuthorization : authorizeComplianceRefresh;
    await expect(authorize(userRequest)).rejects.toMatchObject({ code: 'authorization_revoked' });
  });

  it('rejects a persisted epoch mismatch before looking up WorkOS or grants', async () => {
    mocks.fingerprint.mockResolvedValue('user_exact:5');
    await expect(authorizeComplianceRefresh({ ...userRequest, authorization_fingerprint: 'user_exact:4' }))
      .rejects.toMatchObject({ code: 'authorization_revoked' });
    expect(mocks.getWorkos).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('preserves epoch-store unavailability without falling back to cached authorization', async () => {
    mocks.fingerprint.mockRejectedValue(new Error('epoch database unavailable'));
    await expect(authorizeComplianceRefresh(userRequest)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.getWorkos).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['rotated-key', ''])('rejects a static administrator job after API key rotation or revocation (%s)', async (key) => {
    vi.stubEnv('ADMIN_API_KEY', key);
    const staticRequest = {
      ...userRequest,
      requester_type: 'static_admin' as const,
      requested_by_user_id: null,
      requested_by_auth_workos_user_id: '',
    };
    await expect(captureComplianceRefreshAuthorization(staticRequest))
      .rejects.toMatchObject({ code: 'authorization_provenance_missing' });
    await expect(authorizeComplianceRefresh(staticRequest))
      .rejects.toMatchObject({ code: 'authorization_provenance_missing' });
    expect(mocks.getWorkos).not.toHaveBeenCalled();
    expect(mocks.fingerprint).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('uses current WorkOS email for independent break-glass during a membership outage', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'current@example.test');
    mocks.query.mockRejectedValue(new Error('membership unavailable'));
    await expect(isRefreshAdmin({ id: 'user_canonical', authWorkosUserId: 'user_exact', email: 'stale@example.test' }))
      .resolves.toBe(true);
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith('user_exact');
  });

  it('does not grant break-glass from a stale session email during a membership outage', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'stale@example.test');
    mocks.query.mockRejectedValue(new Error('membership unavailable'));
    await expect(isRefreshAdmin({ id: 'user_canonical', authWorkosUserId: 'user_exact', email: 'stale@example.test' }))
      .rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith('user_exact');
  });
});
