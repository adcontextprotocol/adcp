import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  consumeGrant,
  consumePendingAuth,
  setGrant,
  setPendingAuth,
  type NativeGrant,
  type NativePendingAuth,
} from '../../src/db/native-auth-state-db.js';

const CLIENT_ID = 'org.agenticadvertising.addie';
const REDIRECT_URI = 'org.agenticadvertising.addie:/auth/callback';
const ISSUER = 'https://agenticadvertising.org';
const RUN_STATE = crypto.randomBytes(32).toString('base64url');

function opaque(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function pending(): NativePendingAuth {
  return {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    clientState: RUN_STATE,
    codeChallenge: opaque(),
    workosCodeVerifier: opaque(),
    issuer: ISSUER,
  };
}

describe.skipIf(!process.env.DATABASE_URL)('native OAuth PostgreSQL consumption', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL! });
    await runMigrations();
  }, 60_000);

  afterEach(async () => {
    await pool.query("DELETE FROM native_oauth_pending_auths WHERE data->>'clientState' = $1", [RUN_STATE]);
    await pool.query("DELETE FROM native_oauth_grants WHERE data->>'clientState' = $1", [RUN_STATE]);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('allows exactly one concurrent pending-state consumption', async () => {
    const id = opaque();
    const value = pending();
    await setPendingAuth(id, value);

    const results = await Promise.all([
      consumePendingAuth(id),
      consumePendingAuth(id),
      consumePendingAuth(id),
      consumePendingAuth(id),
    ]);

    expect(results.filter((result) => result !== undefined)).toEqual([value]);
  });

  it('allows exactly one concurrent PKCE-bound grant consumption', async () => {
    const code = opaque();
    const value: NativeGrant = {
      ...pending(),
      sealedSession: 'sealed-session-test-value',
      user: { id: 'user_native_auth_test', email: 'native-auth-test@example.com' },
    };
    const expectedGrant: NativeGrant = {
      clientId: value.clientId,
      redirectUri: value.redirectUri,
      clientState: value.clientState,
      codeChallenge: value.codeChallenge,
      issuer: value.issuer,
      sealedSession: value.sealedSession,
      user: value.user,
    };
    await setGrant(code, value);

    const binding = {
      clientId: value.clientId,
      redirectUri: value.redirectUri,
      clientState: value.clientState,
      codeChallenge: value.codeChallenge,
    };
    const results = await Promise.all([
      consumeGrant(code, binding),
      consumeGrant(code, binding),
      consumeGrant(code, binding),
      consumeGrant(code, binding),
    ]);

    expect(results.filter((result) => result !== undefined)).toEqual([expectedGrant]);
  });

  it('rejects expired pending states and grants in PostgreSQL', async () => {
    const pendingId = opaque();
    const grantCode = opaque();
    const pendingValue = pending();
    const grantValue: NativeGrant = {
      ...pendingValue,
      sealedSession: 'sealed-session-test-value',
      user: { id: 'user_native_auth_test', email: 'native-auth-test@example.com' },
    };
    await setPendingAuth(pendingId, pendingValue);
    await setGrant(grantCode, grantValue);
    await pool.query(
      "UPDATE native_oauth_pending_auths SET expires_at = NOW() - INTERVAL '1 second' WHERE data->>'clientState' = $1",
      [RUN_STATE],
    );
    await pool.query(
      "UPDATE native_oauth_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE data->>'clientState' = $1",
      [RUN_STATE],
    );

    expect(await consumePendingAuth(pendingId)).toBeUndefined();
    expect(await consumeGrant(grantCode, {
      clientId: grantValue.clientId,
      redirectUri: grantValue.redirectUri,
      clientState: grantValue.clientState,
      codeChallenge: grantValue.codeChallenge,
    })).toBeUndefined();
  });
});
