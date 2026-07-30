import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_CLIENT_ID,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_REDIRECT_URI,
  buildNativeErrorRedirect,
  createNativeAuthRouter,
  deriveS256Challenge,
  isValidPkceVerifier,
  issueNativeGrantRedirect,
  parseNativePendingId,
  type NativeAuthStore,
} from '../../src/routes/native-auth.js';
import type { NativeGrant, NativePendingAuth } from '../../src/db/native-auth-state-db.js';

const STATE = 's'.repeat(43);
const PENDING_ID = 'p'.repeat(43);
const CODE = 'g'.repeat(43);
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ISSUER = 'https://agenticadvertising.org';

class MemoryStore implements NativeAuthStore {
  pending = new Map<string, NativePendingAuth>();
  grants = new Map<string, NativeGrant>();

  async setPendingAuth(id: string, data: NativePendingAuth): Promise<void> {
    this.pending.set(id, data);
  }

  async consumePendingAuth(id: string): Promise<NativePendingAuth | undefined> {
    const value = this.pending.get(id);
    this.pending.delete(id);
    return value;
  }

  async setGrant(code: string, data: NativeGrant): Promise<void> {
    this.grants.set(code, data);
  }

  async consumeGrant(
    code: string,
    binding: Pick<NativeGrant, 'clientId' | 'redirectUri' | 'clientState' | 'codeChallenge'>,
  ): Promise<NativeGrant | undefined> {
    const value = this.grants.get(code);
    if (!value
      || value.clientId !== binding.clientId
      || value.redirectUri !== binding.redirectUri
      || value.clientState !== binding.clientState
      || value.codeChallenge !== binding.codeChallenge) {
      return undefined;
    }
    this.grants.delete(code);
    return value;
  }
}

function pending(): NativePendingAuth {
  return {
    clientId: NATIVE_CLIENT_ID,
    redirectUri: NATIVE_REDIRECT_URI,
    clientState: STATE,
    codeChallenge: RFC_CHALLENGE,
    workosCodeVerifier: PENDING_ID,
    issuer: ISSUER,
  };
}

function app(store: MemoryStore) {
  const instance = express();
  instance.set('trust proxy', 1);
  instance.use(express.json({ limit: '4kb' }));
  instance.use('/auth/native', createNativeAuthRouter({
    issuer: ISSUER,
    store,
    randomOpaqueValue: () => PENDING_ID,
    buildWorkOSAuthorizationUrl: (state, codeChallenge) =>
      `https://workos.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}`,
  }));
  return instance;
}

describe('native OAuth v2 security boundary', () => {
  it('matches the RFC 7636 S256 test vector', () => {
    expect(deriveS256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it('stores state and S256 binding before returning an opaque WorkOS URL', async () => {
    const store = new MemoryStore();
    const response = await request(app(store)).post('/auth/native/start').send({
      v: NATIVE_PROTOCOL_VERSION,
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      state: STATE,
      code_challenge: RFC_CHALLENGE,
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(store.pending.get(PENDING_ID)).toEqual(pending());
    expect(response.body.authorization_url).not.toContain(STATE);
    expect(response.body.authorization_url).toContain('native_pending_id');
    expect(response.body.authorization_url).toContain(
      `code_challenge=${deriveS256Challenge(PENDING_ID)}`,
    );
  });

  it('accepts the full RFC verifier alphabet through 128 characters only', () => {
    expect(isValidPkceVerifier(`${'x'.repeat(124)}-._~`)).toBe(true);
    expect(isValidPkceVerifier(`${'x'.repeat(42)}=`)).toBe(false);
    expect(isValidPkceVerifier(`${'x'.repeat(42)} `)).toBe(false);
    expect(isValidPkceVerifier(`${'x'.repeat(42)}é`)).toBe(false);
  });

  it.each([
    { redirect_uri: 'addie://auth/callback' },
    { redirect_uri: `${NATIVE_REDIRECT_URI}/evil` },
    { client_id: 'attacker-app' },
    { state: 'short' },
    { code_challenge: 'short' },
    { code_challenge_method: 'plain' },
    { v: 1 },
    { extra: 'ambiguous-parser-input' },
  ])('rejects non-exact start binding %#', async (override) => {
    const response = await request(app(new MemoryStore())).post('/auth/native/start').send({
      v: NATIVE_PROTOCOL_VERSION,
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      state: STATE,
      code_challenge: RFC_CHALLENGE,
      code_challenge_method: 'S256',
      ...override,
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it.each([
    ['protocol version', { v: 1 }, 'invalid_request'],
    ['grant type', { grant_type: 'refresh_token' }, 'invalid_request'],
    ['client id', { client_id: 'attacker-app' }, 'invalid_request'],
    ['redirect URI', { redirect_uri: 'addie://auth/callback' }, 'invalid_request'],
    ['authorization code syntax', { code: 'short' }, 'invalid_request'],
    ['authorization code value', { code: 'x'.repeat(43) }, 'invalid_grant'],
    ['state syntax', { state: 'short' }, 'invalid_request'],
    ['state value', { state: 'x'.repeat(43) }, 'invalid_grant'],
    ['short verifier', { code_verifier: 'x'.repeat(42) }, 'invalid_request'],
    ['long verifier', { code_verifier: 'x'.repeat(129) }, 'invalid_request'],
    ['invalid verifier alphabet', { code_verifier: `${'x'.repeat(42)}!` }, 'invalid_request'],
    ['extra field', { extra: true }, 'invalid_request'],
  ])('rejects a non-exact token %s binding', async (_name, override, expectedError) => {
    const store = new MemoryStore();
    store.grants.set(CODE, {
      ...pending(),
      sealedSession: 'SEALED_SESSION_SECRET',
      user: { id: 'user_1', email: 'person@example.com' },
    });

    const response = await request(app(store)).post('/auth/native/token').send({
      v: NATIVE_PROTOCOL_VERSION,
      grant_type: 'authorization_code',
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      code: CODE,
      state: STATE,
      code_verifier: RFC_VERIFIER,
      ...override,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: expectedError });
    expect(store.grants.has(CODE)).toBe(true);
  });

  it('issues a deep link containing only code, state, version, and issuer', async () => {
    const store = new MemoryStore();
    const redirect = await issueNativeGrantRedirect(
      pending(),
      'SEALED_SESSION_SECRET',
      { id: 'user_1', email: 'person@example.com', firstName: 'Person' },
      store,
      () => CODE,
    );

    const url = new URL(redirect);
    expect(url.protocol).toBe('org.agenticadvertising.addie:');
    expect([...url.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state', 'v']);
    expect(redirect).not.toContain('SEALED_SESSION_SECRET');
    expect(redirect).not.toContain('person%40example.com');
    expect(store.grants.get(CODE)).not.toHaveProperty('workosCodeVerifier');
  });

  it('fails closed when stored redirect state violates the server invariant', async () => {
    const corrupt = { ...pending(), redirectUri: 'https://evil.example/callback' };
    expect(() => buildNativeErrorRedirect(corrupt, 'server_error')).toThrow(
      'redirect URI invariant failed',
    );

    const store = new MemoryStore();
    await expect(issueNativeGrantRedirect(
      corrupt,
      'SEALED_SESSION_SECRET',
      { id: 'user_1', email: 'person@example.com' },
      store,
      () => CODE,
    )).rejects.toThrow('redirect URI invariant failed');
    expect(store.grants.size).toBe(0);
  });

  it('binds token redemption to state, client, redirect, and PKCE and consumes once', async () => {
    const store = new MemoryStore();
    store.grants.set(CODE, {
      ...pending(),
      sealedSession: 'SEALED_SESSION_SECRET',
      user: { id: 'user_1', email: 'person@example.com', firstName: 'Pérson' },
    });

    const wrong = await request(app(store)).post('/auth/native/token').send({
      v: 2,
      grant_type: 'authorization_code',
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      code: CODE,
      state: STATE,
      code_verifier: 'x'.repeat(43),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'invalid_grant' });
    expect(store.grants.has(CODE)).toBe(true);

    const valid = await request(app(store)).post('/auth/native/token').send({
      v: 2,
      grant_type: 'authorization_code',
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      code: CODE,
      state: STATE,
      code_verifier: RFC_VERIFIER,
    });
    expect(valid.status, valid.text).toBe(200);
    expect(valid.headers['cache-control']).toBe('no-store');
    expect(valid.body).toEqual({
      sealed_session: 'SEALED_SESSION_SECRET',
      user: {
        id: 'user_1',
        email: 'person@example.com',
        first_name: 'Pérson',
        last_name: null,
      },
    });

    const replay = await request(app(store)).post('/auth/native/token').send({
      v: 2,
      grant_type: 'authorization_code',
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      code: CODE,
      state: STATE,
      code_verifier: RFC_VERIFIER,
    });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: 'invalid_grant' });
  });

  it('strictly recognizes only a single well-formed native pending id', () => {
    expect(parseNativePendingId(JSON.stringify({ native_pending_id: PENDING_ID }))).toBe(PENDING_ID);
    expect(parseNativePendingId(JSON.stringify({ native_pending_id: 'short' }))).toBeUndefined();
    expect(parseNativePendingId(JSON.stringify({ native_pending_id: PENDING_ID, extra: true }))).toBeUndefined();
    expect(parseNativePendingId('{bad json')).toBeUndefined();
    expect(parseNativePendingId([JSON.stringify({ native_pending_id: PENDING_ID })])).toBeUndefined();
  });

  it('returns only structured nonsecret callback errors', () => {
    const redirect = buildNativeErrorRedirect(pending(), 'access_denied');
    expect(redirect).toContain('error=access_denied');
    expect(redirect).toContain(`state=${STATE}`);
    expect(redirect).not.toContain('sealed_session');
  });

  it('rate-limits native starts with a generic response', async () => {
    const instance = app(new MemoryStore());
    const payload = {
      v: NATIVE_PROTOCOL_VERSION,
      client_id: NATIVE_CLIENT_ID,
      redirect_uri: NATIVE_REDIRECT_URI,
      state: STATE,
      code_challenge: RFC_CHALLENGE,
      code_challenge_method: 'S256',
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(instance)
        .post('/auth/native/start')
        .set('X-Forwarded-For', '203.0.113.77')
        .send(payload);
      expect(response.status).toBe(200);
    }
    const limited = await request(instance)
      .post('/auth/native/start')
      .set('X-Forwarded-For', '203.0.113.77')
      .send(payload);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'slow_down' });
  });
});
