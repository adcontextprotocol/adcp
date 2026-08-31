import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => vi.useRealTimers());

  it.each([
    { rows: [] },
    { rows: [{ value: true }] },
    { rows: [{ value: { enabled: 'true', expires_at: null } }] },
    { rows: [{ value: { enabled: true, expires_at: '2026-09-02T00:00:00.000Z', unexpected: 'ignored' } }] },
    { rows: [{ value: { enabled: true, expires_at: null } }] },
    { rows: [{ value: { enabled: false, expires_at: '2026-09-02T00:00:00.000Z' } }] },
  ])('defaults absent or malformed persisted values off %#', async ({ rows }) => {
    queryMock.mockResolvedValueOnce({ rows });
    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({ enabled: false, expires_at: null });
  });

  it('reads a valid enabled value', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: true, expires_at: '2026-09-02T00:00:00.000Z' } }],
    });
    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({
      enabled: true,
      expires_at: '2026-09-02T00:00:00.000Z',
    });
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO system_settings_audit');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'verification_profile_shadow_rollout',
      'system:verification-profile-shadow-auto-expiry',
    ]);
  });

  it('returns the atomically disabled value after an audited expiry', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ value: { enabled: false, expires_at: null } }],
    });

    await expect(getVerificationProfileShadowRollout()).resolves.toEqual({
      enabled: false,
      expires_at: null,
    });
    expect(queryMock.mock.calls[0][0]).toContain("current.old_value->>'expires_at'");
    expect(queryMock.mock.calls[0][0]).toContain('UPDATE system_settings setting');
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO system_settings_audit');
  });

  it('writes an audited 72-hour lease when enabling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(
      setVerificationProfileShadowRollout({ enabled: true }, 'credential_admin'),
    ).resolves.toEqual({ enabled: true, expires_at: '2026-09-02T10:00:00.000Z' });

    expect(queryMock.mock.calls[0][1]).toEqual([
      'verification_profile_shadow_rollout',
      JSON.stringify({ enabled: true, expires_at: '2026-09-02T10:00:00.000Z' }),
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
