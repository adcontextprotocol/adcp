import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthorizationFingerprint: vi.fn(),
  getUser: vi.fn(),
  getAuthorizationEnforcementWorkos: vi.fn(),
}));

vi.mock('../../src/db/authorization-epoch-db.js', () => ({
  getAuthorizationFingerprint: mocks.getAuthorizationFingerprint,
}));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: mocks.getAuthorizationEnforcementWorkos,
}));

import {
  captureVoiceAuthorization,
  resolveVoiceAuthorization,
  VoiceAuthorizationUnavailableError,
} from '../../src/addie/voice-authorization.js';

const persisted = {
  version: 1,
  authenticated_workos_user_id: 'user_authenticated',
  authorization_fingerprint: 'user_authenticated:4',
};

describe('persisted voice credential authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAuthorizationFingerprint.mockResolvedValue(persisted.authorization_fingerprint);
    mocks.getUser.mockResolvedValue({ id: 'user_authenticated', email: 'authenticated@example.test' });
    mocks.getAuthorizationEnforcementWorkos.mockReturnValue({ userManagement: { getUser: mocks.getUser } });
  });

  it('captures the authenticated credential separately from the canonical identity', async () => {
    await expect(captureVoiceAuthorization({ id: 'user_canonical', authWorkosUserId: 'user_authenticated' }))
      .resolves.toEqual(persisted);
    expect(mocks.getAuthorizationFingerprint).toHaveBeenCalledWith(['user_authenticated']);
  });

  it('supports an authenticated singleton and its valid empty initial fingerprint', async () => {
    mocks.getAuthorizationFingerprint.mockResolvedValue('');
    const context = await captureVoiceAuthorization({ id: 'user_authenticated' });
    expect(context.authorization_fingerprint).toBe('');
    await expect(resolveVoiceAuthorization(context)).resolves.toMatchObject({ status: 'authorized' });
  });

  it('refuses session creation when the persisted epoch cannot be captured', async () => {
    mocks.getAuthorizationFingerprint.mockRejectedValue(new Error('database down'));
    await expect(captureVoiceAuthorization({ id: 'user_authenticated' }))
      .rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { user_id: 'user_canonical' },
    { ...persisted, version: 2 }, { ...persisted, authorization_fingerprint: undefined },
    { ...persisted, authenticated_workos_user_id: '' },
  ])('requires server-persisted provenance for legacy or malformed context %#', async (context) => {
    await expect(resolveVoiceAuthorization(context)).resolves.toEqual({ status: 'stale', reason: 'missing_provenance' });
    expect(mocks.getAuthorizationFingerprint).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('fetches only the authenticated credential and ignores old or canonical email fields', async () => {
    await expect(resolveVoiceAuthorization({ ...persisted, email: 'canonical-admin@example.test', user_id: 'user_canonical' }))
      .resolves.toEqual({
        status: 'authorized',
        principal: { id: 'user_authenticated', authWorkosUserId: 'user_authenticated', email: 'authenticated@example.test' },
    });
    expect(mocks.getUser).toHaveBeenCalledWith('user_authenticated');
    expect(mocks.getAuthorizationFingerprint).toHaveBeenCalledTimes(2);
    expect(mocks.getAuthorizationFingerprint).toHaveBeenNthCalledWith(1, ['user_authenticated']);
    expect(mocks.getAuthorizationFingerprint).toHaveBeenNthCalledWith(2, ['user_authenticated']);
  });

  it('rechecks epoch and current credential email on every turn', async () => {
    await resolveVoiceAuthorization(persisted);
    mocks.getUser.mockResolvedValue({ id: 'user_authenticated', email: 'changed@example.test' });
    await expect(resolveVoiceAuthorization(persisted)).resolves.toMatchObject({
      status: 'authorized', principal: { email: 'changed@example.test' },
    });
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(mocks.getAuthorizationFingerprint).toHaveBeenCalledTimes(4);
  });

  it.each(['user_authenticated:5', ''])('rejects changed epochs, including a deleted epoch row (%s)', async (fingerprint) => {
    mocks.getAuthorizationFingerprint.mockResolvedValue(fingerprint);
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'stale', reason: 'epoch_changed' });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('rejects an identity change while WorkOS is being read', async () => {
    mocks.getAuthorizationFingerprint.mockResolvedValueOnce(persisted.authorization_fingerprint).mockResolvedValueOnce('user_authenticated:5');
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'stale', reason: 'epoch_changed' });
  });

  it.each([1, 2])('fails closed when epoch read %s is unavailable', async (read) => {
    if (read === 2) mocks.getAuthorizationFingerprint.mockResolvedValueOnce(persisted.authorization_fingerprint);
    mocks.getAuthorizationFingerprint.mockRejectedValueOnce(new Error('database down'));
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'unavailable', source: 'authorization_epoch' });
  });

  it('requires a new sign-in when the exact WorkOS credential was deleted', async () => {
    mocks.getUser.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'stale', reason: 'credential_deleted' });
  });

  it('reports provider outages separately from stale sessions without falling back', async () => {
    mocks.getUser.mockRejectedValue(new Error('WorkOS unavailable'));
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'unavailable', source: 'workos' });
  });

  it('fails closed when the provider client cannot be constructed', async () => {
    mocks.getAuthorizationEnforcementWorkos.mockImplementation(() => { throw new Error('missing configuration'); });
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'unavailable', source: 'workos' });
  });

  it('never accepts a different credential returned by the provider', async () => {
    mocks.getUser.mockResolvedValue({ id: 'user_canonical', email: 'canonical-admin@example.test' });
    await expect(resolveVoiceAuthorization(persisted)).resolves.toEqual({ status: 'unavailable', source: 'workos' });
  });
});
