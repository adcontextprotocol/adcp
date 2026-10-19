import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { encrypt, decrypt } from '../../src/db/encryption.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import {
  captureAgentOAuthState, assertAgentOAuthState, completeOwnerOAuthIfUnchanged,
  replaceOAuthTokensIfUnchanged, type AgentOAuthState,
} from '../../src/db/agent-oauth-state-db.js';

// Run only with a freshly verified task-owned loopback fixture, never a customer DB.
const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
  throw new Error('Owner OAuth CAS tests require disposable loopback PostgreSQL');
}
const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const ORG = 'org_owner_cas_synthetic';
const AGENT_URL = 'https://seller.example.test/mcp';
const ISSUER = 'https://issuer.example.test/owner';
const REDIRECT = 'https://buyer.example.test/api/oauth/agent/callback';
const newClient = { client_id: 'new-client', client_secret: 'new-secret', issuer: ISSUER };
const newTokens = { access_token: 'new-access', refresh_token: 'new-refresh', issuer: ISSUER };

describe('owner authorization and tokens-only encrypted-state CAS', () => {
  let schema: string;
  let pool: Pool;
  let id: string;
  let state: AgentOAuthState;

  beforeEach(async () => {
    schema = `owner_cas_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new globalThis.URL(connectionString);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = initializeDatabase({ connectionString: scoped.toString() });
    await pool.query(`CREATE TABLE agent_contexts (
      id UUID PRIMARY KEY, organization_id TEXT, agent_url TEXT, protocol TEXT DEFAULT 'mcp',
      auth_type TEXT DEFAULT 'bearer', auth_token_encrypted TEXT, auth_token_iv TEXT, auth_token_hint TEXT,
      oauth_access_token_encrypted TEXT, oauth_access_token_iv TEXT,
      oauth_refresh_token_encrypted TEXT, oauth_refresh_token_iv TEXT,
      oauth_token_expires_at TIMESTAMPTZ, oauth_token_issuer TEXT,
      oauth_client_id TEXT, oauth_client_secret_encrypted TEXT, oauth_client_secret_iv TEXT,
      oauth_registered_redirect_uri TEXT, oauth_client_issuer TEXT,
      oauth_cc_token_endpoint TEXT, oauth_cc_client_id TEXT, oauth_cc_client_secret_encrypted TEXT,
      oauth_cc_client_secret_iv TEXT, oauth_cc_scope TEXT, oauth_cc_resource TEXT,
      oauth_cc_audience TEXT, oauth_cc_auth_method TEXT,
      oauth_owner_generation BIGINT NOT NULL DEFAULT 0,
      agent_name TEXT, last_test_passed BOOLEAN, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    id = randomUUID();
    const access = encrypt('legacy-access', ORG);
    const refresh = encrypt('legacy-refresh', ORG);
    const secret = encrypt('legacy-secret', ORG);
    await pool.query(`INSERT INTO agent_contexts (id, organization_id, agent_url,
      oauth_access_token_encrypted, oauth_access_token_iv, oauth_refresh_token_encrypted, oauth_refresh_token_iv,
      oauth_client_id, oauth_client_secret_encrypted, oauth_client_secret_iv, oauth_registered_redirect_uri)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'legacy-client',$8,$9,$10)`,
    [id, ORG, AGENT_URL, access.encrypted, access.iv, refresh.encrypted, refresh.iv, secret.encrypted, secret.iv, REDIRECT]);
    state = await captureAgentOAuthState(id, ORG, AGENT_URL);
  });
  afterEach(async () => { await closeDatabase(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
  afterAll(async () => { await admin.end(); });

  it('captures encrypted legacy bytes without stamping or modifying them', async () => {
    const before = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    expect(state.oauth_token_issuer).toBeNull();
    expect(state.oauth_client_issuer).toBeNull();
    expect(JSON.stringify(state)).not.toContain('legacy-access');
    expect(JSON.stringify(state)).not.toContain('legacy-secret');
    await assertAgentOAuthState(state);
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(before);
  });

  it('atomically replaces both owner records and issuers while preserving static/CC modes', async () => {
    await pool.query(`UPDATE agent_contexts SET auth_token_encrypted='unchanged-static', auth_token_iv='static-iv',
      oauth_cc_client_id='unchanged-cc' WHERE id=$1`, [id]);
    state = await captureAgentOAuthState(id, ORG, AGENT_URL);
    const next = await completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT);
    expect(next).toMatchObject({ oauth_client_id: 'new-client', oauth_client_issuer: ISSUER,
      oauth_token_issuer: ISSUER, oauth_registered_redirect_uri: REDIRECT, oauth_owner_generation: '1',
      auth_token_encrypted: 'unchanged-static', oauth_cc_client_id: 'unchanged-cc' });
    expect(decrypt(next.oauth_access_token_encrypted!, next.oauth_access_token_iv!, ORG)).toBe('new-access');
    expect(decrypt(next.oauth_client_secret_encrypted!, next.oauth_client_secret_iv!, ORG)).toBe('new-secret');
    await expect(completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT)).rejects.toThrow();
  });

  it('allows unrelated name/test/time changes instead of using updated_at as a fence', async () => {
    await pool.query(`UPDATE agent_contexts SET agent_name='renamed', last_test_passed=true,
      updated_at=NOW()+INTERVAL '1 second' WHERE id=$1`, [id]);
    await expect(completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT)).resolves.toMatchObject({
      oauth_client_id: 'new-client', oauth_token_issuer: ISSUER,
    });
  });

  const mutations = [
    ['organization_id', 'other-org'], ['agent_url', 'https://other.example.test/mcp'], ['protocol', 'a2a'],
    ['auth_type', 'basic'], ['auth_token_encrypted', 'changed'], ['auth_token_iv', 'changed'],
    ['auth_token_hint', 'changed'], ['oauth_access_token_encrypted', 'changed'], ['oauth_access_token_iv', 'changed'],
    ['oauth_refresh_token_encrypted', 'changed'], ['oauth_refresh_token_iv', 'changed'],
    ['oauth_token_expires_at', '2030-01-01T00:00:00Z'], ['oauth_token_issuer', ISSUER],
    ['oauth_client_id', 'changed'], ['oauth_client_secret_encrypted', 'changed'], ['oauth_client_secret_iv', 'changed'],
    ['oauth_registered_redirect_uri', 'https://changed.example.test/callback'], ['oauth_client_issuer', ISSUER],
    ['oauth_cc_token_endpoint', 'https://changed.example.test/token'], ['oauth_cc_client_id', 'changed'],
    ['oauth_cc_client_secret_encrypted', 'changed'], ['oauth_cc_client_secret_iv', 'changed'],
    ['oauth_cc_scope', 'changed'], ['oauth_cc_resource', 'changed'], ['oauth_cc_audience', 'changed'],
    ['oauth_cc_auth_method', 'body'], ['oauth_owner_generation', '1'],
  ] as const;
  it.each(mutations)('refuses a changed %s with zero stale owner persistence', async (field, value) => {
    await pool.query(`UPDATE agent_contexts SET ${field}=$1 WHERE id=$2`, [value, id]);
    const changed = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    await expect(completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(changed);
  });

  it('refuses an owner deletion rather than recreating the record', async () => {
    await pool.query('DELETE FROM agent_contexts WHERE id=$1', [id]);
    await expect(assertAgentOAuthState(state)).rejects.toThrow();
    await expect(completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM agent_contexts')).rows).toHaveLength(0);
  });

  it.each(['removeOAuthTokens', 'clearOAuthClient'] as const)('credentialless %s cancellation prevents a late staged grant', async method => {
    await new AgentContextDatabase().clearOAuthClient(id);
    state = await captureAgentOAuthState(id, ORG, AGENT_URL);
    const before = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    expect(before.oauth_client_id).toBeNull();
    expect(before.oauth_access_token_encrypted).toBeNull();
    await new AgentContextDatabase()[method](id); // Explicit clear remains meaningful when already empty.
    const cleared = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    const attempt = await Promise.allSettled([completeOwnerOAuthIfUnchanged(state, newClient, newTokens, REDIRECT)]);
    expect(attempt[0].status).toBe('rejected');
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(cleared);
    expect(BigInt(cleared.oauth_owner_generation)).toBe(BigInt(before.oauth_owner_generation) + 1n);
  });

  it('requires verified matching registration/token issuer on completed owner replacement', async () => {
    const before = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    for (const client of [{ client_id: 'missing-stamp' }, { ...newClient, issuer: 'https://other.example.test/as' }]) {
      await expect(completeOwnerOAuthIfUnchanged(state, client, newTokens, REDIRECT)).rejects.toThrow();
    }
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(before);
  });

  it('tokens-only CAS retains omitted refresh token, preserves registration/modes and advances the baseline', async () => {
    await pool.query('UPDATE agent_contexts SET oauth_token_issuer=$1, oauth_client_issuer=$1 WHERE id=$2', [ISSUER, id]);
    state = await captureAgentOAuthState(id, ORG, AGENT_URL);
    const next = await replaceOAuthTokensIfUnchanged(state, { access_token: 'rotated-access', issuer: ISSUER });
    for (const key of ['oauth_client_id', 'oauth_client_secret_encrypted', 'oauth_client_secret_iv',
      'oauth_registered_redirect_uri', 'oauth_client_issuer', 'auth_type', 'auth_token_encrypted',
      'oauth_cc_client_id', 'oauth_refresh_token_encrypted', 'oauth_refresh_token_iv', 'oauth_owner_generation'] as const) {
      expect(next[key]).toBe(state[key]);
    }
    expect(decrypt(next.oauth_refresh_token_encrypted!, next.oauth_refresh_token_iv!, ORG)).toBe('legacy-refresh');
    await expect(replaceOAuthTokensIfUnchanged(state, newTokens)).rejects.toThrow();
    await expect(replaceOAuthTokensIfUnchanged(next, newTokens)).resolves.toMatchObject({ oauth_token_issuer: ISSUER });
  });

  it('refuses tokens-only writes against unstamped grants without inference', async () => {
    const before = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    await expect(replaceOAuthTokensIfUnchanged(state, newTokens)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(before);
  });
});
