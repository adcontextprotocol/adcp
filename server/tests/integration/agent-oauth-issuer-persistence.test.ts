import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { ComplianceDatabase } from '../../src/db/compliance-db.js';
import { encrypt } from '../../src/db/encryption.js';
import { resolveUserAgentAuth } from '../../src/routes/helpers/resolve-user-agent-auth.js';
import { agentConfigAuthFields } from '../../src/services/sdk-auth-adapter.js';

const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
const databaseUrl = new URL(connectionString);
if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
  throw new Error('OAuth issuer persistence tests require a disposable loopback PostgreSQL fixture');
}
const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const migration = readFileSync(new URL('../../src/db/migrations/617_agent_oauth_issuer_bindings.sql', import.meta.url), 'utf8');
const ownerGenerationMigration = readFileSync(new URL('../../src/db/migrations/618_agent_oauth_owner_generation.sql', import.meta.url), 'utf8');
const ORG = 'org_oauth_issuer_synthetic';
const AGENT_URL = 'https://seller.example.test/mcp';
const TOKEN_ISSUER = 'https://tokens.example.test/tenant';
const CLIENT_ISSUER = 'https://registration.example.test/tenant';
const REDIRECT = 'https://buyer.example.test/api/oauth/agent/callback';

// This deliberately models pre-migration columns. Tests exercise real app SQL
// and encryption against private schemas, without running unrelated migrations.
const legacySchema = `CREATE TABLE agent_contexts (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, agent_url TEXT NOT NULL,
  agent_name TEXT, agent_type TEXT DEFAULT 'sales', protocol TEXT DEFAULT 'mcp',
  auth_type TEXT DEFAULT 'bearer', auth_token_encrypted TEXT, auth_token_iv TEXT, auth_token_hint TEXT,
  oauth_access_token_encrypted TEXT, oauth_access_token_iv TEXT,
  oauth_refresh_token_encrypted TEXT, oauth_refresh_token_iv TEXT, oauth_token_expires_at TIMESTAMPTZ,
  oauth_client_id TEXT, oauth_client_secret_encrypted TEXT, oauth_client_secret_iv TEXT,
  oauth_registered_redirect_uri TEXT,
  oauth_cc_token_endpoint TEXT, oauth_cc_client_id TEXT, oauth_cc_client_secret_encrypted TEXT,
  oauth_cc_client_secret_iv TEXT, oauth_cc_scope TEXT, oauth_cc_resource TEXT,
  oauth_cc_audience TEXT, oauth_cc_auth_method TEXT,
  tools_discovered TEXT[], last_discovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), created_by TEXT,
  UNIQUE (organization_id, agent_url)
);
CREATE VIEW agent_context_with_latest_test AS SELECT ac.*,
  NULL::TEXT AS canonical_last_test_scenario, NULL::BOOLEAN AS canonical_last_test_passed,
  NULL::TEXT AS canonical_last_test_summary, NULL::TIMESTAMPTZ AS canonical_last_tested_at,
  0::INTEGER AS canonical_total_tests_run FROM agent_contexts ac;
CREATE TABLE member_profiles (workos_organization_id TEXT PRIMARY KEY, agents JSONB NOT NULL);`;

describe('OAuth issuer migration and private grant readers', () => {
  let schema: string;
  let pool: Pool;
  let contextId: string;
  let legacyRow: Record<string, unknown>;
  let db: AgentContextDatabase;

  beforeEach(async () => {
    schema = `oauth_issuer_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connectionString);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = initializeDatabase({ connectionString: scoped.toString() });
    await pool.query(legacySchema);
    contextId = randomUUID();
    const access = encrypt('synthetic-access', ORG);
    const refresh = encrypt('synthetic-refresh', ORG);
    const secret = encrypt('synthetic-client-secret', ORG);
    await pool.query(`INSERT INTO agent_contexts (id, organization_id, agent_url,
      oauth_access_token_encrypted, oauth_access_token_iv, oauth_refresh_token_encrypted, oauth_refresh_token_iv,
      oauth_client_id, oauth_client_secret_encrypted, oauth_client_secret_iv, oauth_registered_redirect_uri)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'synthetic-client', $8, $9, $10)`,
    [contextId, ORG, AGENT_URL, access.encrypted, access.iv, refresh.encrypted, refresh.iv, secret.encrypted, secret.iv, REDIRECT]);
    await pool.query('INSERT INTO member_profiles VALUES ($1, $2)', [ORG, JSON.stringify([{ url: AGENT_URL }])]);
    legacyRow = (await pool.query('SELECT * FROM agent_contexts WHERE id = $1', [contextId])).rows[0];
    await pool.query(migration);
    await pool.query(ownerGenerationMigration);
    db = new AgentContextDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  });
  afterAll(async () => { await admin.end(); });

  it('adds nullable issuer columns without backfilling or changing any historical credential byte', async () => {
    const row = (await pool.query('SELECT * FROM agent_contexts WHERE id = $1', [contextId])).rows[0];
    expect(row).toEqual({ ...legacyRow, oauth_token_issuer: null, oauth_client_issuer: null, oauth_owner_generation: '0' });
    const columns = await pool.query(`SELECT column_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'agent_contexts'
      AND column_name IN ('oauth_token_issuer', 'oauth_client_issuer')`, [schema]);
    expect(columns.rows).toHaveLength(2);
    for (const column of columns.rows) expect(column).toMatchObject({ is_nullable: 'YES', column_default: null });
    await pool.query(migration);
    expect((await pool.query('SELECT * FROM agent_contexts WHERE id = $1', [contextId])).rows[0]).toEqual(row);
    expect(await db.getOAuthTokens(contextId)).not.toHaveProperty('issuer');
    expect(await db.getOAuthClient(contextId)).not.toHaveProperty('issuer');
  });

  it('adds an owner-specific cancellation fence without changing any credential byte', async () => {
    const row = (await pool.query('SELECT * FROM agent_contexts WHERE id=$1', [contextId])).rows[0];
    expect(row).toEqual({ ...legacyRow, oauth_token_issuer: null, oauth_client_issuer: null, oauth_owner_generation: '0' });
    const column = (await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='agent_contexts' AND column_name='oauth_owner_generation'`, [schema])).rows[0];
    expect(column).toMatchObject({ data_type: 'bigint', is_nullable: 'NO', column_default: '0' });
    await pool.query(ownerGenerationMigration);
    expect((await pool.query('SELECT * FROM agent_contexts WHERE id=$1', [contextId])).rows[0]).toEqual(row);
  });

  it('round-trips both independent bindings through SQL readers, owner resolution and raw SDK config', async () => {
    const tokens = { access_token: 'new-access', refresh_token: 'new-refresh',
      expires_at: new Date('2030-01-01T00:00:00Z'), issuer: TOKEN_ISSUER };
    const client = { client_id: 'new-client', client_secret: 'new-secret',
      registered_redirect_uri: REDIRECT, issuer: CLIENT_ISSUER };
    await db.saveOAuthClient(contextId, client);
    await db.saveOAuthTokens(contextId, tokens);
    expect(await db.getOAuthTokens(contextId)).toEqual(tokens);
    expect(await db.getOAuthTokensByOrgAndUrl(ORG, AGENT_URL)).toEqual(tokens);
    expect(await db.getOAuthClient(contextId)).toEqual(client);
    const expectedAuth = { type: 'oauth', tokens: { ...tokens, expires_at: tokens.expires_at.toISOString() },
      client: { client_id: client.client_id, client_secret: client.client_secret, issuer: CLIENT_ISSUER } };
    expect((await db.getEvaluationAuthByOrgAndUrl(ORG, AGENT_URL))?.auth).toEqual(expectedAuth);
    expect(await new ComplianceDatabase().resolveOwnerAuth(AGENT_URL)).toEqual(expectedAuth);
    const userAuth = await resolveUserAgentAuth(db, ORG, AGENT_URL, { warn: () => undefined });
    expect(userAuth).toEqual(expectedAuth);
    expect(agentConfigAuthFields(userAuth)).toEqual({ auth_token: tokens.access_token,
      oauth_tokens: expectedAuth.tokens, oauth_client: expectedAuth.client });
    expect(await db.getOAuthTokensByOrgAndUrl('org_unrelated', AGENT_URL)).toBeNull();
    expect(await resolveUserAgentAuth(db, 'org_unrelated', AGENT_URL, { warn: () => undefined })).toBeUndefined();
  });

  it('does not inherit an old issuer when an explicit replacement omits its binding', async () => {
    await db.saveOAuthTokens(contextId, { access_token: 'bound-access', issuer: TOKEN_ISSUER });
    await db.saveOAuthClient(contextId, { client_id: 'bound-client', issuer: CLIENT_ISSUER });
    await db.saveOAuthTokens(contextId, { access_token: 'replacement-access' });
    await db.saveOAuthClient(contextId, { client_id: 'replacement-client' });
    expect(await db.getOAuthTokens(contextId)).toEqual({ access_token: 'replacement-access' });
    expect(await db.getOAuthClient(contextId)).toMatchObject({ client_id: 'replacement-client' });
    expect(await db.getOAuthClient(contextId)).not.toHaveProperty('issuer');
    const row = (await pool.query('SELECT oauth_token_issuer, oauth_client_issuer FROM agent_contexts WHERE id = $1', [contextId])).rows[0];
    expect(row).toEqual({ oauth_token_issuer: null, oauth_client_issuer: null });
  });

  it.each(['removeOAuthTokens', 'clearOAuthClient'] as const)('clears both corresponding bindings only with the existing explicit %s operation', async method => {
    await db.saveOAuthTokens(contextId, { access_token: 'bound-access', refresh_token: 'bound-refresh', issuer: TOKEN_ISSUER });
    await db.saveOAuthClient(contextId, { client_id: 'bound-client', issuer: CLIENT_ISSUER });
    await pool.query(`UPDATE agent_contexts SET auth_token_encrypted = 'unrelated-static-ciphertext',
      auth_token_iv = 'unrelated-static-iv', oauth_cc_client_id = 'unrelated-cc-client' WHERE id = $1`, [contextId]);
    await db[method](contextId);
    const row = (await pool.query('SELECT * FROM agent_contexts WHERE id = $1', [contextId])).rows[0];
    for (const name of ['oauth_token_issuer', 'oauth_client_issuer', 'oauth_access_token_encrypted',
      'oauth_refresh_token_encrypted', 'oauth_client_id']) expect(row[name]).toBeNull();
    expect(row).toMatchObject({ auth_token_encrypted: 'unrelated-static-ciphertext',
      auth_token_iv: 'unrelated-static-iv', oauth_cc_client_id: 'unrelated-cc-client' });
  });
});
