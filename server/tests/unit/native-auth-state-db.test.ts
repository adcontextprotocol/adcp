import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  isDatabaseInitialized: vi.fn(() => true),
}));

vi.mock('../../src/db/encryption.js', () => ({
  encrypt: vi.fn((value: string, salt: string) => ({
    encrypted: `encrypted:${value}:${salt}`,
    iv: 'test-iv',
  })),
  decrypt: vi.fn((value: string) => value.split(':')[1]),
}));

import { query } from '../../src/db/client.js';
import {
  consumeGrant,
  consumePendingAuth,
  setGrant,
  setPendingAuth,
  type NativeGrant,
  type NativePendingAuth,
} from '../../src/db/native-auth-state-db.js';

const mockedQuery = vi.mocked(query);
const RAW_ID = 'p'.repeat(43);
const RAW_CODE = 'g'.repeat(43);

const pending: NativePendingAuth = {
  clientId: 'org.agenticadvertising.addie',
  redirectUri: 'org.agenticadvertising.addie:/auth/callback',
  clientState: 's'.repeat(43),
  codeChallenge: 'c'.repeat(43),
  workosCodeVerifier: 'w'.repeat(43),
  issuer: 'https://agenticadvertising.org',
};

const grant: NativeGrant = {
  ...pending,
  sealedSession: 'SEALED_SESSION_SECRET',
  user: { id: 'user_1', email: 'person@example.com' },
};

describe('native OAuth database atomicity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores only the hash of the pending browser id', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await setPendingAuth(RAW_ID, pending);

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('native_oauth_pending_auths');
    expect(params[0]).not.toBe(RAW_ID);
    expect(params[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(params[1]).not.toContain(`"workosCodeVerifier":"${pending.workosCodeVerifier}"`);
    expect(params[1]).toContain('workosCodeVerifierEncrypted');
  });

  it('atomically consumes only an unexpired pending id', async () => {
    const stored = {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      clientState: pending.clientState,
      codeChallenge: pending.codeChallenge,
      issuer: pending.issuer,
      workosCodeVerifierEncrypted: `encrypted:${pending.workosCodeVerifier}:salt`,
      workosCodeVerifierIv: 'test-iv',
    };
    mockedQuery.mockResolvedValueOnce({ rows: [{ data: stored }], rowCount: 1 } as never);
    expect(await consumePendingAuth(RAW_ID)).toEqual(pending);

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM native_oauth_pending_auths');
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain('RETURNING data');
    expect(params[0]).not.toBe(RAW_ID);
  });

  it('encrypts the sealed session and stores only a grant hash', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await setGrant(RAW_CODE, grant);

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    const stored = params[1] as string;
    expect(sql).toContain('native_oauth_grants');
    expect(params[0]).not.toBe(RAW_CODE);
    expect(stored).not.toContain('"sealedSession":"SEALED_SESSION_SECRET"');
    expect(stored).toContain('sealedSessionEncrypted');
  });

  it('uses one DELETE predicate for code, TTL, client, redirect, state, and challenge', async () => {
    const stored = {
      ...pending,
      sealedSessionEncrypted: 'encrypted:SEALED_SESSION_SECRET:salt',
      sealedSessionIv: 'test-iv',
      user: grant.user,
    };
    mockedQuery.mockResolvedValueOnce({ rows: [{ data: stored }], rowCount: 1 } as never);

    const consumed = await consumeGrant(RAW_CODE, {
      clientId: grant.clientId,
      redirectUri: grant.redirectUri,
      clientState: grant.clientState,
      codeChallenge: grant.codeChallenge,
    });
    expect(consumed?.sealedSession).toBe('SEALED_SESSION_SECRET');

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM native_oauth_grants');
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain("data->>'clientId'");
    expect(sql).toContain("data->>'redirectUri'");
    expect(sql).toContain("data->>'clientState'");
    expect(sql).toContain("data->>'codeChallenge'");
    expect(params.slice(1)).toEqual([
      grant.clientId,
      grant.redirectUri,
      grant.clientState,
      grant.codeChallenge,
    ]);
  });
});
