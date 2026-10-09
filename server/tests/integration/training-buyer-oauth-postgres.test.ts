/** Real primary PostgreSQL and HTTP MCP; Connect JWTs/membership are controlled ports. */
import express from 'express';
import { Pool } from 'pg';
import { generateKeyPair, SignJWT } from 'jose';
import { SingleAgentClient, closeMCPConnections } from '@adcp/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';

const state = vi.hoisted(() => ({ key: undefined as unknown, runtime: undefined as unknown, active: true, calls: [] as string[] }));
vi.hoisted(() => {
  process.env.TRAINING_BUYER_OAUTH_ENABLED = 'true';
  process.env.TRAINING_BUYER_OAUTH_ISSUER = 'https://auth.example.com';
  process.env.TRAINING_BUYER_OAUTH_ORGANIZATION_ID = 'org_buyerpg';
  delete process.env.TRAINING_REPORTING_GCS_CANARY_PRINCIPAL;
});
vi.mock('jose', async original => ({ ...await original<object>(), createRemoteJWKSet: () => async () => state.key }));
vi.mock('../../src/auth/workos-client.js', () => ({ getPipesWorkos: () => ({ userManagement: { listOrganizationMemberships: async () => ({ data: state.active ? [{ userId: 'user_buyerpg', organizationId: 'org_buyerpg', status: 'active', role: { slug: 'admin' } }] : [] }) } }) }));
vi.mock('../../src/db/bans-db.js', () => ({ bansDb: { checkPlatformBanForUserAndOrg: async () => ({ banned: false }) } }));
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: () => state.runtime }));
import { createTrainingAgentRouter } from '../../src/training-agent/index.js';

const databaseUrl = process.env.TRAINING_BUYER_AUTH_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('sales buyer OAuth with real primary state and official HTTP MCP', () => {
  let pool: Pool;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  let signed: string;
  let buyer: SingleAgentClient;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/training_buyer_auth_tests') throw new Error('Use the dedicated local buyer auth database.');
    pool = initializeDatabase({ connectionString: databaseUrl, maxPoolSize: 3 });
    await pool.query(`
      CREATE TABLE users (workos_user_id text PRIMARY KEY, email text, email_verified boolean, first_name text, last_name text);
      CREATE TABLE identity_workos_users (workos_user_id text PRIMARY KEY REFERENCES users, identity_id uuid, is_primary boolean);
      CREATE TABLE authorization_epochs (workos_user_id text PRIMARY KEY REFERENCES users, epoch bigint);
      CREATE TABLE registry_audit_log (workos_user_id text, action text);
      CREATE TABLE organization_credential_grants (id uuid PRIMARY KEY, workos_user_id text REFERENCES users, workos_organization_id text, role text, effective_from timestamptz, effective_until timestamptz, revoked_at timestamptz);
      INSERT INTO users VALUES ('user_buyerpg','buyer@example.com',true,'Sam','Buyer'), ('user_aliaspg','alias@example.com',true,'Sam','Alias');
      INSERT INTO identity_workos_users VALUES ('user_aliaspg','f0000000-0000-4000-8000-000000000001',true),('user_buyerpg','f0000000-0000-4000-8000-000000000001',false);
      INSERT INTO organization_credential_grants VALUES ('f0000000-0000-4000-8000-000000000002','user_buyerpg','org_buyerpg','admin',NOW()-INTERVAL '1 day',NULL,NULL);
      INSERT INTO authorization_epochs VALUES ('user_buyerpg',9007199254740993);
    `);
    const keys = await generateKeyPair('RS256'); state.key = keys.publicKey;
    signed = await new SignJWT({ org_id: 'org_buyerpg', client_id: 'client_buyerpg', sid: 'app_consent_buyerpg' })
      .setProtectedHeader({ alg: 'RS256', kid: 'pg' }).setIssuer('https://auth.example.com')
      .setAudience('https://test-agent.adcontextprotocol.org/sales/mcp').setSubject('user_buyerpg').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    state.runtime = { grant: async (principal: string) => { state.calls.push(principal); return { principal_id: principal, account_id: 'account-a', destination_ref: 'destination-a' }; }, buyerConfiguration: async () => ({ expected: {} }) };
    const app = express(); app.use(express.json()); app.use(createTrainingAgentRouter({ disableRateLimit: true }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP listener.');
    base = `http://127.0.0.1:${address.port}`;
    buyer = new SingleAgentClient({ id: 'buyer-pg', name: 'Buyer PG test', agent_uri: `${base}/sales`, protocol: 'mcp', auth_token: signed }, { adcpVersion: '3.2.1', wireAdcpVersion: '3.2' });
  });
  afterAll(async () => {
    await closeMCPConnections(); if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    try { if (pool) await pool.query('DROP TABLE IF EXISTS organization_credential_grants,registry_audit_log,authorization_epochs,identity_workos_users,users'); }
    finally { await closeDatabase(); }
  });
  const grantRequest = () => fetch(`${base}/sales/reporting/destinations/account-a/destination-a`, { headers: { Authorization: `Bearer ${signed}` } });
  it('discovers the dedicated resource and initializes the actual sales SDK handler as an OAuth buyer', async () => {
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/sales/mcp`)).json();
    expect(metadata.resource).toBe('https://test-agent.adcontextprotocol.org/sales/mcp');
    const result = await buyer.executeTask('get_adcp_capabilities', {});
    expect(result.success).toBe(true);
    expect((await grantRequest()).status).toBe(200); expect(state.calls).toEqual(['workos:org_buyerpg']);
    const wrongTenant = await fetch(`${base}/signals/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${signed}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(wrongTenant.status).toBe(401);
  });
  it('rejects a revoked exact grant even when the linked canonical user has admin authority', async () => {
    await pool.query("UPDATE organization_credential_grants SET revoked_at=NOW() WHERE workos_user_id='user_buyerpg'");
    await pool.query("INSERT INTO organization_credential_grants VALUES ('f0000000-0000-4000-8000-000000000003','user_aliaspg','org_buyerpg','admin',NOW()-INTERVAL '1 day',NULL,NULL)");
    expect((await grantRequest()).status).toBe(403); expect(state.calls).toHaveLength(1);
    await pool.query("UPDATE organization_credential_grants SET revoked_at=NULL WHERE workos_user_id='user_buyerpg'");
  });
  it('checks current provider membership on the next request with the same token', async () => {
    state.active = false; expect((await grantRequest()).status).toBe(403); state.active = true;
  });
  it('honors durable deletion markers after a process-independent primary-state change', async () => {
    await pool.query("INSERT INTO registry_audit_log VALUES ('user_buyerpg','identity_credential_deleted')");
    expect((await grantRequest()).status).toBe(401); expect(state.calls).toHaveLength(1);
  });
});
