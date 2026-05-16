import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import { encrypt, decrypt } from '../../src/db/encryption.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const PRIMARY_ORG = 'org_merge_ac_primary';
const SECONDARY_ORG = 'org_merge_ac_secondary';
const MERGED_BY = 'user_merge_ac_admin';

// Stub WorkOS client — mergeOrganizations only calls organizations.deleteOrganization
// after the local commit, so the stub just needs to no-op.
const workosStub = {
  organizations: {
    deleteOrganization: async (_id: string) => {},
  },
} as unknown as WorkOS;

describe('mergeOrganizations — agent_contexts re-encryption', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Primary', NOW(), NOW()),
              ($2, 'Secondary', NOW(), NOW())`,
      [PRIMARY_ORG, SECONDARY_ORG]
    );
  });

  async function cleanup() {
    await pool.query(`DELETE FROM agent_contexts WHERE organization_id IN ($1, $2)`, [PRIMARY_ORG, SECONDARY_ORG]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)`, [PRIMARY_ORG, SECONDARY_ORG]);
  }

  it('re-encrypts auth tokens under the primary org salt so decrypt keeps working', async () => {
    const TOKEN = 'sk-test-bearer-token-12345';
    const sealed = encrypt(TOKEN, SECONDARY_ORG);

    await pool.query(
      `INSERT INTO agent_contexts (organization_id, agent_url, agent_name, auth_token_encrypted, auth_token_iv, auth_token_hint)
       VALUES ($1, 'https://agent.example/mcp', 'Test', $2, $3, '****2345')`,
      [SECONDARY_ORG, sealed.encrypted, sealed.iv]
    );

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const moved = await pool.query(
      `SELECT auth_token_encrypted, auth_token_iv FROM agent_contexts WHERE organization_id = $1`,
      [PRIMARY_ORG]
    );
    expect(moved.rows).toHaveLength(1);

    // Old salt no longer works (proves we re-encrypted, not just moved bytes).
    expect(() => decrypt(moved.rows[0].auth_token_encrypted, moved.rows[0].auth_token_iv, SECONDARY_ORG))
      .toThrow();

    // New salt round-trips to the original plaintext.
    const recovered = decrypt(moved.rows[0].auth_token_encrypted, moved.rows[0].auth_token_iv, PRIMARY_ORG);
    expect(recovered).toBe(TOKEN);
  });

  it('re-encrypts every populated OAuth token field, leaves NULLs alone', async () => {
    const ACCESS = 'access-abc';
    const REFRESH = 'refresh-def';
    const access = encrypt(ACCESS, SECONDARY_ORG);
    const refresh = encrypt(REFRESH, SECONDARY_ORG);

    await pool.query(
      `INSERT INTO agent_contexts (
         organization_id, agent_url, agent_name,
         oauth_access_token_encrypted, oauth_access_token_iv,
         oauth_refresh_token_encrypted, oauth_refresh_token_iv
       ) VALUES ($1, 'https://oauth.example/mcp', 'OAuth', $2, $3, $4, $5)`,
      [SECONDARY_ORG, access.encrypted, access.iv, refresh.encrypted, refresh.iv]
    );

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const moved = await pool.query(
      `SELECT oauth_access_token_encrypted, oauth_access_token_iv,
              oauth_refresh_token_encrypted, oauth_refresh_token_iv,
              oauth_client_secret_encrypted, oauth_client_secret_iv
       FROM agent_contexts WHERE organization_id = $1`,
      [PRIMARY_ORG]
    );
    expect(moved.rows).toHaveLength(1);
    const row = moved.rows[0];

    expect(decrypt(row.oauth_access_token_encrypted, row.oauth_access_token_iv, PRIMARY_ORG)).toBe(ACCESS);
    expect(decrypt(row.oauth_refresh_token_encrypted, row.oauth_refresh_token_iv, PRIMARY_ORG)).toBe(REFRESH);
    expect(row.oauth_client_secret_encrypted).toBeNull();
    expect(row.oauth_client_secret_iv).toBeNull();
  });

  it('drops duplicate agent_url rows from secondary instead of conflicting on the unique key', async () => {
    const URL = 'https://dup.example/mcp';
    const primaryToken = encrypt('primary-token', PRIMARY_ORG);
    const secondaryToken = encrypt('secondary-token', SECONDARY_ORG);

    await pool.query(
      `INSERT INTO agent_contexts (organization_id, agent_url, agent_name, auth_token_encrypted, auth_token_iv)
       VALUES ($1, $3, 'Primary', $4, $5),
              ($2, $3, 'Secondary', $6, $7)`,
      [PRIMARY_ORG, SECONDARY_ORG, URL, primaryToken.encrypted, primaryToken.iv, secondaryToken.encrypted, secondaryToken.iv]
    );

    const summary = await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const remaining = await pool.query(
      `SELECT auth_token_encrypted, auth_token_iv FROM agent_contexts WHERE agent_url = $1`,
      [URL]
    );
    expect(remaining.rows).toHaveLength(1);
    // Primary's row was kept (its token was never re-encrypted).
    expect(decrypt(remaining.rows[0].auth_token_encrypted, remaining.rows[0].auth_token_iv, PRIMARY_ORG))
      .toBe('primary-token');

    const acSummary = summary.tables_merged.find(t => t.table_name === 'agent_contexts');
    expect(acSummary?.rows_skipped_duplicate).toBe(1);
  });
});
