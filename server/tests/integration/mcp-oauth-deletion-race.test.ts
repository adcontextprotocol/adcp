import type { Response } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = 'user_mcp_oauth_deletion_race';
const PENDING_ID = 'pending_mcp_oauth_deletion_race';

const mocks = vi.hoisted(() => ({
  authenticateWithCodeForTokens: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/auth/workos-client.js')>()),
  authenticateWithCodeForTokens: mocks.authenticateWithCodeForTokens,
}));

const { initializeDatabase, closeDatabase } = await import('../../src/db/client.js');
const { runMigrations } = await import('../../src/db/migrate.js');
const mcpOAuthStateDb = await import('../../src/db/mcp-oauth-state-db.js');
const { deleteIdentityCredential } = await import('../../src/services/identity-credential-deletion.js');
const { handleMCPOAuthCallback } = await import('../../src/mcp/oauth-provider.js');

describe('MCP OAuth callback vs confirmed credential deletion', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL
        || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await pool.query(
      `INSERT INTO users (
         workos_user_id, email, first_name, last_name, email_verified,
         workos_created_at, workos_updated_at, created_at, updated_at
       ) VALUES ($1, 'mcp-race@example.test', 'MCP', 'Race', TRUE,
                 NOW(), NOW(), NOW(), NOW())`,
      [USER_ID],
    );
    await mcpOAuthStateDb.setPendingAuth(PENDING_ID, {
      clientId: 'client_mcp_race',
      redirectUri: 'https://client.example.test/callback',
      codeChallenge: 'challenge',
      scopes: ['openid'],
      state: 'roundtrip-state',
    });
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query(`DELETE FROM mcp_oauth_pending_auths WHERE id = $1`, [PENDING_ID]);
    await pool.query(
      `DELETE FROM mcp_oauth_auth_codes
        WHERE data->>'clientId' = 'client_mcp_race'`,
    );
    await pool.query(`DELETE FROM registry_audit_log WHERE workos_user_id = $1`, [USER_ID]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [USER_ID]);
  }

  it('issues no local code when deletion commits after exchange starts but before local finalize', async () => {
    let exchangeEntered!: () => void;
    let releaseExchange!: () => void;
    const entered = new Promise<void>((resolve) => { exchangeEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseExchange = resolve; });
    mocks.authenticateWithCodeForTokens.mockImplementation(async () => {
      exchangeEntered();
      await release;
      return {
        user: {
          id: USER_ID,
          email: 'mcp-race@example.test',
          firstName: 'MCP',
          lastName: 'Race',
          emailVerified: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      };
    });
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      redirect: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const callback = handleMCPOAuthCallback({} as never, res, 'workos-code', PENDING_ID);
    await entered;
    await deleteIdentityCredential(USER_ID, 'workos_webhook');
    releaseExchange();
    await callback;

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const redirect = new URL(vi.mocked(res.redirect).mock.calls[0][0] as string);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.has('code')).toBe(false);
    expect((await pool.query(
      `SELECT 1 FROM mcp_oauth_auth_codes WHERE data->>'clientId' = 'client_mcp_race'`,
    )).rows).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM users WHERE workos_user_id = $1`, [USER_ID])).rows)
      .toEqual([]);
  });
});
