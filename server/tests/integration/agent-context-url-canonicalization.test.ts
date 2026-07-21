import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { decrypt, encrypt } from '../../src/db/encryption.js';

const ORG = 'org_agent_context_canonicalization_test';
const CANONICAL = 'https://platform.loopme.ai/mcp/seller';
const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../src/db/migrations/525_canonicalize_agent_context_urls.sql'),
  'utf8',
);

describe('migration 525: canonicalize agent context URLs', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Agent context canonicalization test', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function cleanup() {
    if (!pool) return;
    await pool.query('DELETE FROM agent_contexts WHERE organization_id = $1', [ORG]);
  }

  it('collapses path/trailing-slash variants without losing the refreshable OAuth grant or history', async () => {
    const accessOnly = encrypt('access-only', ORG);
    const refreshableAccess = encrypt('refreshable-access', ORG);
    const refreshToken = encrypt('refresh-token', ORG);
    const clientSecret = encrypt('client-secret', ORG);

    const canonicalRow = await pool.query<{ id: string }>(
      `INSERT INTO agent_contexts (organization_id, agent_url, agent_name, updated_at)
       VALUES ($1, $2, 'Canonical without tokens', NOW()) RETURNING id`,
      [ORG, CANONICAL],
    );
    const accessOnlyRow = await pool.query<{ id: string }>(
      `INSERT INTO agent_contexts (
         organization_id, agent_url,
         oauth_access_token_encrypted, oauth_access_token_iv, updated_at
       ) VALUES ($1, 'HTTPS://PLATFORM.LOOPME.AI/MCP/SELLER/', $2, $3, NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [ORG, accessOnly.encrypted, accessOnly.iv],
    );
    const refreshableRow = await pool.query<{ id: string }>(
      `INSERT INTO agent_contexts (
         organization_id, agent_url,
         oauth_access_token_encrypted, oauth_access_token_iv,
         oauth_refresh_token_encrypted, oauth_refresh_token_iv,
         oauth_client_id, oauth_client_secret_encrypted, oauth_client_secret_iv,
         updated_at
       ) VALUES (
         $1, 'https://platform.loopme.ai/mcp/seller//',
         $2, $3, $4, $5, 'loopme-client', $6, $7, NOW() - INTERVAL '1 hour'
       ) RETURNING id`,
      [
        ORG,
        refreshableAccess.encrypted,
        refreshableAccess.iv,
        refreshToken.encrypted,
        refreshToken.iv,
        clientSecret.encrypted,
        clientSecret.iv,
      ],
    );

    for (const contextId of [canonicalRow.rows[0].id, accessOnlyRow.rows[0].id]) {
      await pool.query(
        `INSERT INTO agent_test_history (
           agent_context_id, scenario, overall_passed, steps_passed, steps_failed
         ) VALUES ($1, 'oauth-regression', TRUE, 1, 0)`,
        [contextId],
      );
    }

    await pool.query(MIGRATION_SQL);

    const contexts = await pool.query(
      `SELECT * FROM agent_contexts WHERE organization_id = $1`,
      [ORG],
    );
    expect(contexts.rows).toHaveLength(1);
    const context = contexts.rows[0];
    expect(context.id).toBe(refreshableRow.rows[0].id);
    expect(context.agent_url).toBe(CANONICAL);
    expect(decrypt(context.oauth_access_token_encrypted, context.oauth_access_token_iv, ORG))
      .toBe('refreshable-access');
    expect(decrypt(context.oauth_refresh_token_encrypted, context.oauth_refresh_token_iv, ORG))
      .toBe('refresh-token');
    expect(context.oauth_client_id).toBe('loopme-client');
    expect(decrypt(context.oauth_client_secret_encrypted, context.oauth_client_secret_iv, ORG))
      .toBe('client-secret');

    const history = await pool.query(
      `SELECT agent_context_id FROM agent_test_history WHERE scenario = 'oauth-regression'`,
    );
    expect(history.rows).toHaveLength(2);
    expect(history.rows.every((row) => row.agent_context_id === context.id)).toBe(true);

    await pool.query(MIGRATION_SQL);
    const rerun = await pool.query(
      `SELECT id, agent_url FROM agent_contexts WHERE organization_id = $1`,
      [ORG],
    );
    expect(rerun.rows).toEqual([{ id: context.id, agent_url: CANONICAL }]);
  });
});
