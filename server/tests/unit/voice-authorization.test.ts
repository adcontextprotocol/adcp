import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthorizationFingerprint: vi.fn(),
  getUser: vi.fn(),
  getAuthorizationEnforcementWorkos: vi.fn(),
  queryWithTimeout: vi.fn(),
}));

vi.mock('../../src/db/authorization-epoch-db.js', () => ({
  getAuthorizationFingerprint: mocks.getAuthorizationFingerprint,
}));
vi.mock('../../src/auth/workos-client.js', () => ({
  getAuthorizationEnforcementWorkos: mocks.getAuthorizationEnforcementWorkos,
}));
vi.mock('../../src/db/client.js', () => ({
  queryWithTimeout: mocks.queryWithTimeout,
  withDatabaseDeadline: (_deadline: number, work: () => unknown) => work(),
}));

import {
  captureVoiceAuthorization,
  deriveVoiceCallbackTurnId,
  issueVoiceCallbackBinding,
  isVoiceSessionOwner,
  persistVoiceCallbackBinding,
  resolveVoiceCallback,
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

describe('server-issued voice callback capability', () => {
  const threadId = '11111111-1111-4111-8111-111111111111';
  const otherThreadId = '22222222-2222-4222-8222-222222222222';
  const externalId = `addie-${threadId}`;
  let issued: ReturnType<typeof issueVoiceCallbackBinding>;
  let thread: Record<string, unknown>;
  const previousSecret = process.env.TAVUS_LLM_SECRET;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TAVUS_LLM_SECRET = 'test-callback-secret';
    issued = issueVoiceCallbackBinding(threadId, externalId, 3600);
    thread = {
      thread_id: threadId, external_id: externalId, channel: 'video', user_type: 'workos', user_id: 'user_canonical',
      context: { voice_callback_binding: { ...issued.binding, provider_conversation_id: 'tavus-current' }, tavus_conversation_id: 'tavus-current', voice_authorization: persisted },
    };
    mocks.queryWithTimeout.mockImplementation(async () => ({ rows: [thread] }));
  });

  it('derives a stable turn id without using the session capability as its receipt', () => {
    const messages = [
      { role: 'system', content: `[conductor:voice_session=${issued.token}]` },
      { role: 'user', content: 'Please perform this turn once.' },
    ];
    const sameTurn = deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages });
    const replacementCapability = issueVoiceCallbackBinding(threadId, externalId, 3600);

    expect(deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages })).toBe(sameTurn);
    expect(deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages: [
      { role: 'system', content: `[conductor:voice_session=${replacementCapability.token}]` },
      messages[1],
    ] })).toBe(sameTurn);
    expect(deriveVoiceCallbackTurnId({ threadId: otherThreadId, externalId: `addie-${otherThreadId}`, providerConversationId: 'tavus-other', messages })).not.toBe(sameTurn);
    expect(deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages: [...messages, { role: 'assistant', content: 'prior reply' }, messages[1]] })).not.toBe(sameTurn);
    expect(deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages: [
      messages[0],
      { role: 'user', content: `[conductor:voice_session=${replacementCapability.token}]` },
    ] })).not.toBe(deriveVoiceCallbackTurnId({ threadId, externalId, providerConversationId: 'tavus-current', messages: [
      messages[0],
      { role: 'user', content: `[conductor:voice_session=${issued.token}]` },
    ] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.TAVUS_LLM_SECRET;
    else process.env.TAVUS_LLM_SECRET = previousSecret;
  });

  it('resolves only the persisted primary-database video session after validating its MAC', async () => {
    const decision = await resolveVoiceCallback(issued.token, 'tavus-current');
    expect(decision.status).toBe('verified');
    if (decision.status !== 'verified') throw new Error('expected verified callback');
    expect(decision.thread.thread_id).toBe(threadId);
    expect(Object.isFrozen(decision.thread)).toBe(true);
    expect(mocks.queryWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining("channel = 'video'"), [threadId, externalId], 5000,
    );
  });

  it.each([undefined, null, '', `[conductor:thread_id=${threadId}]`, `${'x'.repeat(1025)}.mac`])(
    'rejects missing, raw-thread, and malformed capabilities without database access %#', async (token) => {
      await expect(resolveVoiceCallback(token)).resolves.toEqual({ status: 'invalid' });
      expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
    },
  );

  it('rejects a known victim thread substituted into an otherwise valid token', async () => {
    const [payload, mac] = issued.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.thread_id = otherThreadId;
    const altered = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${mac}`;
    await expect(resolveVoiceCallback(altered)).resolves.toEqual({ status: 'invalid' });
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
  });

  it('rejects a modified MAC and signatures made with the wrong secret', async () => {
    await expect(resolveVoiceCallback(`${issued.token.slice(0, -5)}xxxxx`)).resolves.toEqual({ status: 'invalid' });
    process.env.TAVUS_LLM_SECRET = 'rotated-callback-secret';
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();
  });

  it('expires at the configured session duration and rejects expiration during the lookup', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const shortSession = issueVoiceCallbackBinding(threadId, externalId, 60);
    expect(shortSession.binding.expires_at).toBe(now + 60_000);
    clock.mockReturnValue(now + 60_000);
    await expect(resolveVoiceCallback(shortSession.token)).resolves.toEqual({ status: 'invalid' });
    expect(mocks.queryWithTimeout).not.toHaveBeenCalled();

    clock.mockReturnValue(now);
    mocks.queryWithTimeout.mockImplementation(async () => {
      clock.mockReturnValue(issued.binding.expires_at);
      return { rows: [thread] };
    });
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'invalid' });
  });

  it.each(['missing', 'nonce_changed', 'expiry_changed', 'conversation_missing', 'conversation_rebound', 'conversation_mismatch', 'non_video', 'wrong_owner_type', 'wrong_thread', 'wrong_external_id', 'deleted', 'ambiguous'])(
    'fails closed for a %s persisted binding', async (condition) => {
      const context = thread.context as Record<string, unknown>;
      if (condition === 'missing') delete context.voice_callback_binding;
      if (condition === 'nonce_changed') context.voice_callback_binding = { ...issued.binding, nonce: 'different-nonce' };
      if (condition === 'expiry_changed') context.voice_callback_binding = { ...issued.binding, expires_at: issued.binding.expires_at + 1 };
      if (condition === 'conversation_missing') delete context.tavus_conversation_id;
      if (condition === 'conversation_rebound') context.tavus_conversation_id = 'tavus-rebound';
      if (condition === 'non_video') thread.channel = 'web';
      if (condition === 'wrong_owner_type') thread.user_type = 'anonymous';
      if (condition === 'wrong_thread') thread.thread_id = otherThreadId;
      if (condition === 'wrong_external_id') thread.external_id = `addie-${otherThreadId}`;
      if (condition === 'deleted') mocks.queryWithTimeout.mockResolvedValue({ rows: [] });
      if (condition === 'ambiguous') mocks.queryWithTimeout.mockResolvedValue({ rows: [thread, thread] });
      await expect(resolveVoiceCallback(issued.token, condition === 'conversation_mismatch' ? 'tavus-other' : undefined))
        .resolves.toEqual({ status: 'invalid' });
    },
  );

  it('reports missing signing configuration and primary database failure as unavailable', async () => {
    mocks.queryWithTimeout.mockRejectedValue(new Error('primary unavailable'));
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'unavailable' });
    delete process.env.TAVUS_LLM_SECRET;
    await expect(resolveVoiceCallback(issued.token)).resolves.toEqual({ status: 'unavailable' });
    expect(() => issueVoiceCallbackBinding(threadId, externalId, 3600)).toThrow(VoiceAuthorizationUnavailableError);
  });

  it('persists the exact binding with bounded primary writes and prevents finalization after nonce revocation', async () => {
    mocks.queryWithTimeout.mockResolvedValue({ rowCount: 1 });
    await persistVoiceCallbackBinding(threadId, externalId, issued.binding, 'tavus-current');
    expect(mocks.queryWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining("context->'voice_callback_binding'->>'nonce' = $4"),
      [threadId, externalId, JSON.stringify({
        voice_callback_binding: { ...issued.binding, provider_conversation_id: 'tavus-current' },
        tavus_conversation_id: 'tavus-current',
      }), issued.binding.nonce],
      5000,
    );
  });

  it.each([0, null, 2])('rejects a callback grant or revocation when the write affects %s rows', async (rowCount) => {
    mocks.queryWithTimeout.mockResolvedValue({ rowCount });
    await expect(persistVoiceCallbackBinding(threadId, externalId, issued.binding)).rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
    await expect(persistVoiceCallbackBinding(threadId, externalId, null)).rejects.toBeInstanceOf(VoiceAuthorizationUnavailableError);
  });

  it('treats only the exact captured credential as session owner, never a linked canonical identity', () => {
    expect(isVoiceSessionOwner(persisted, { id: 'user_canonical', authWorkosUserId: 'user_authenticated' })).toBe(true);
    expect(isVoiceSessionOwner(persisted, { id: 'user_authenticated', authWorkosUserId: 'other_credential' })).toBe(false);
    expect(isVoiceSessionOwner(undefined, { id: 'user_authenticated' })).toBe(false);
  });
});
