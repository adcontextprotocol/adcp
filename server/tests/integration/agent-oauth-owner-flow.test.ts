/** Actual published SDK flow + app persistence regression. Execute only after
 * the authenticated issuer-security SDK has been adopted; no source overlay. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startWebOAuthFlow, completeWebOAuthFlow } from '@adcp/sdk/auth';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { AgentContextDatabase } from '../../src/db/agent-context-db.js';
import { encrypt } from '../../src/db/encryption.js';
import { createWebOAuthAdapters } from '../../src/routes/helpers/web-oauth-stores.js';

const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
  throw new Error('Owner OAuth flow tests require disposable loopback PostgreSQL');
}
const admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
const ORG = 'org_synthetic_owner_flow';
const USER = 'user_synthetic_owner_flow';

describe('actual SDK owner flow with private app CAS storage', () => {
  let schema: string;
  let pool: Pool;
  let server: Server;
  let origin: string;
  let id: string;
  let db: AgentContextDatabase;
  let posts: string[];
  let registrationAvailable: boolean;
  let metadataGate: Promise<void> | undefined;
  let tokenGate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    posts = [];
    registrationAvailable = true;
    metadataGate = tokenGate = undefined;
    entered = release = undefined;
    server = createServer(async (req, res) => {
      const path = new URL(req.url!, origin).pathname;
      const send = (body: object, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      };
      if (path.includes('oauth-protected-resource')) return send({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/owner`] });
      if (path.includes('.well-known')) {
        if (metadataGate) { entered?.(); await metadataGate; }
        return send({ issuer: `${origin}/owner`, authorization_endpoint: `${origin}/owner/authorize`,
          token_endpoint: `${origin}/owner/token`,
          ...(registrationAvailable && { registration_endpoint: `${origin}/owner/register` }),
          response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      }
      if (req.method === 'POST') {
        posts.push(path);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (path.endsWith('/register') && registrationAvailable) return send({ ...JSON.parse(Buffer.concat(chunks).toString()), client_id: 'new-synthetic-client' }, 201);
        if (path.endsWith('/token')) {
          if (tokenGate) { entered?.(); await tokenGate; }
          return send({ access_token: 'new-synthetic-access', refresh_token: 'new-synthetic-refresh', token_type: 'Bearer', expires_in: 3600 });
        }
      }
      send({ error: 'not_found' }, 404);
    });
    server.keepAliveTimeout = 100;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local AS failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
    schema = `owner_flow_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connectionString); scoped.searchParams.set('options', `-c search_path=${schema}`);
    pool = initializeDatabase({ connectionString: scoped.toString() });
    await pool.query(`CREATE TABLE agent_contexts (
      id UUID PRIMARY KEY, organization_id TEXT, agent_url TEXT, agent_name TEXT, agent_type TEXT DEFAULT 'sales', protocol TEXT DEFAULT 'mcp',
      auth_type TEXT DEFAULT 'bearer', auth_token_encrypted TEXT, auth_token_iv TEXT, auth_token_hint TEXT,
      oauth_access_token_encrypted TEXT, oauth_access_token_iv TEXT, oauth_refresh_token_encrypted TEXT, oauth_refresh_token_iv TEXT,
      oauth_token_expires_at TIMESTAMPTZ, oauth_token_issuer TEXT, oauth_client_id TEXT,
      oauth_client_secret_encrypted TEXT, oauth_client_secret_iv TEXT, oauth_registered_redirect_uri TEXT, oauth_client_issuer TEXT,
      oauth_cc_token_endpoint TEXT, oauth_cc_client_id TEXT, oauth_cc_client_secret_encrypted TEXT, oauth_cc_client_secret_iv TEXT,
      oauth_cc_scope TEXT, oauth_cc_resource TEXT, oauth_cc_audience TEXT, oauth_cc_auth_method TEXT,
      oauth_owner_generation BIGINT NOT NULL DEFAULT 0,
      tools_discovered TEXT[], last_discovered_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), created_by TEXT
    ); CREATE VIEW agent_context_with_latest_test AS SELECT ac.*,
      NULL::TEXT AS canonical_last_test_scenario, NULL::BOOLEAN AS canonical_last_test_passed,
      NULL::TEXT AS canonical_last_test_summary, NULL::TIMESTAMPTZ AS canonical_last_tested_at,
      0::INTEGER AS canonical_total_tests_run FROM agent_contexts ac;
    CREATE TABLE agent_oauth_pending_flows (state TEXT PRIMARY KEY, data JSONB, expires_at TIMESTAMPTZ);`);
    id = randomUUID();
    const access = encrypt('unchanged-legacy-access', ORG);
    const refresh = encrypt('unchanged-legacy-refresh', ORG);
    const secret = encrypt('unchanged-legacy-secret', ORG);
    await pool.query(`INSERT INTO agent_contexts (id,organization_id,agent_url,
      oauth_access_token_encrypted,oauth_access_token_iv,oauth_refresh_token_encrypted,oauth_refresh_token_iv,
      oauth_client_id,oauth_client_secret_encrypted,oauth_client_secret_iv,oauth_registered_redirect_uri)
      VALUES($1,$2,$3,$4,$5,$6,$7,'legacy-client',$8,$9,$10)`,
    [id, ORG, `${origin}/mcp`, access.encrypted, access.iv, refresh.encrypted, refresh.iv, secret.encrypted, secret.iv, `${origin}/callback`]);
    db = new AgentContextDatabase();
  });
  afterEach(async () => {
    release?.();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await closeDatabase();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  });
  afterAll(async () => { await admin.end(); });

  function adapters(start = false, fresh = true) {
    return createWebOAuthAdapters({ agentContextDb: db, redirectUri: `${origin}/callback`, userId: USER,
      ...(start && { ownerStart: { id, organizationId: ORG, agentUrl: `${origin}/mcp`, fresh } }),
      authorize: async org => org === ORG });
  }
  async function start(fresh = true) {
    const store = adapters(true, fresh);
    const agent = await store.agentStorage.loadAgent(id);
    if (!agent) throw new Error('Synthetic context missing');
    const result = await startWebOAuthFlow({ ...store, agent, redirectUri: `${origin}/callback`, allowHttp: true,
      carry: { organization_id: ORG, user_id: USER } });
    return result.state;
  }
  function complete(state: string) {
    return completeWebOAuthFlow({ ...adapters(), state, expectedState: state, code: 'synthetic-owner-code', allowHttp: true });
  }

  it('stages registration privately then atomically replaces the legacy grant through the real public SDK', async () => {
    const original = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    const state = await start();
    expect(posts).toEqual(['/owner/register']);
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(original);
    await expect(complete(state)).resolves.toMatchObject({ persisted: true });
    const row = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    expect(row).toMatchObject({ oauth_client_id: 'new-synthetic-client', oauth_client_issuer: `${origin}/owner`, oauth_token_issuer: `${origin}/owner` });
    expect(posts).toEqual(['/owner/register', '/owner/token']);
    expect((await pool.query('SELECT * FROM agent_oauth_pending_flows')).rows).toHaveLength(0);
  });

  async function configureBoundPublicClient(issuer = `${origin}/owner`) {
    registrationAvailable = false;
    await pool.query(`UPDATE agent_contexts SET oauth_client_id = 'public-preconfigured-client',
      oauth_client_secret_encrypted = NULL, oauth_client_secret_iv = NULL,
      oauth_client_issuer = $1, oauth_token_issuer = $2 WHERE id = $3`, [issuer, `${origin}/owner`, id]);
  }

  it('ordinary stamped preconfigured public client succeeds without a registration endpoint or POST', async () => {
    await configureBoundPublicClient();
    const original = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    const state = await start(false);
    expect(posts).toEqual([]);
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(original);
    await expect(complete(state)).resolves.toMatchObject({ persisted: true });
    expect(posts).toEqual(['/owner/token']);
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toMatchObject({
      oauth_client_id: 'public-preconfigured-client', oauth_client_issuer: `${origin}/owner`,
      oauth_token_issuer: `${origin}/owner`, oauth_owner_generation: '1',
    });
  });

  it('ordinary exact-redirect stamped client with a mismatched issuer refuses before any POST', async () => {
    await configureBoundPublicClient(`${origin}/different-issuer`);
    const original = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    await expect(start(false)).rejects.toMatchObject({ code: 'oauth_issuer_mismatch' });
    expect(posts).toEqual([]);
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(original);
    expect((await pool.query('SELECT * FROM agent_oauth_pending_flows')).rows).toHaveLength(0);
  });

  it.each([
    ['legacy', 'metadata'], ['legacy', 'token'],
    ['credentialless', 'before-consume'], ['credentialless', 'metadata'], ['credentialless', 'token'],
  ] as const)('preserves %s owner disconnect at %s without resurrecting credentials', async (initial, point) => {
    if (initial === 'credentialless') await db.clearOAuthClient(id);
    const state = await start();
    if (point === 'before-consume') {
      await db.clearOAuthClient(id);
      const cleared = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
      await expect(complete(state)).rejects.toThrow();
      expect(posts.filter(path => path === '/owner/token')).toHaveLength(0);
      expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(cleared);
      return;
    }
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    if (point === 'metadata') metadataGate = gate; else tokenGate = gate;
    const pending = complete(state);
    const outcome = Promise.allSettled([pending]); // Attach rejection handler before releasing the gate.
    await reached;
    await db.clearOAuthClient(id);
    const cleared = (await pool.query('SELECT * FROM agent_contexts')).rows[0];
    release!();
    expect((await outcome)[0].status).toBe('rejected');
    expect((await pool.query('SELECT * FROM agent_contexts')).rows[0]).toEqual(cleared);
    expect(posts.filter(path => path === '/owner/token')).toHaveLength(point === 'metadata' ? 0 : 1);
  });
});
