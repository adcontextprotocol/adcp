import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', () => ({ query: queryMock }));
vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import {
  getVerificationProfileShadowRollout,
  setVerificationProfileShadowRollout,
} from '../../src/db/system-settings-db.js';

describe('verification profile shadow rollout setting', () => {
  beforeEach(() => queryMock.mockReset());

  it.each([
    { rows: [] },
    { rows: [{ value: true }] },
    { rows: [{ value: { enabled: 'true', expires_at: null } }] },
    { rows: [{ value: { enabled: true, expires_at: null, unexpected: 'ignored' } }] },
    { rows: [{ value: { enabled: true, expires_at: '2026-09-02T00:00:00.000Z', unexpected: 'ignored' } }] },
    { rows: [{ value: { enabled: false, expires_at: '2026-09-02T00:00:00.000Z' } }] },
  ])('defaults absent or malformed persisted values off %#', async ({ rows }) => {
    queryMock.mockResolvedValueOnce({ rows });
    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({ enabled: false, expires_at: null });
  });

  it('reads a valid enabled value', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: true, expires_at: null } }],
    });
    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({
      enabled: true,
      expires_at: null,
    });
    expect(queryMock.mock.calls[0][1]).toEqual(['verification_profile_shadow_rollout']);
  });

  it('fails closed for legacy expiring leases', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: true, expires_at: '2026-09-02T00:00:00.000Z' } }],
    });

    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({
      enabled: false,
      expires_at: null,
    });
  });

  it('writes an audited persistent switch when enabling', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      setVerificationProfileShadowRollout({ enabled: true }, 'credential_admin'),
    ).resolves.toEqual({ enabled: true, expires_at: null });

    expect(queryMock.mock.calls[0][1]).toEqual([
      'verification_profile_shadow_rollout',
      JSON.stringify({ enabled: true, expires_at: null }),
      'credential_admin',
    ]);
  });

  it('clears the lease when disabling', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      setVerificationProfileShadowRollout({ enabled: false }, 'credential_admin'),
    ).resolves.toEqual({ enabled: false, expires_at: null });
  });
});
