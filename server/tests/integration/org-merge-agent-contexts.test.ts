import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import { OrganizationMergeUnavailableError } from '../../src/db/org-merge-containment.js';
import { encrypt, decrypt } from '../../src/db/encryption.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const PRIMARY_ORG = 'org_merge_ac_primary';
const SECONDARY_ORG = 'org_merge_ac_secondary';
const MERGED_BY = 'user_merge_ac_admin';

/**
 * agent_contexts credentials under the contained organization merge (#6827).
 *
 * These fixtures previously proved the credential re-encryption
 * mergeOrganizations performed: tokens sealed under the secondary org's salt
 * were re-sealed under the primary org's salt as the rows moved, and duplicate
 * agent_url rows were dropped instead of violating the unique key. Merge
 * execution is now contained, so the same fixtures prove the stronger property
 * instead — the contained service refuses, the rows stay on the secondary org
 * and no stored credential is re-encrypted, moved or dropped. Restore the
 * re-encryption assertions together with a reviewed merge lifecycle.
 */
// Records rather than no-ops: the contained service must never reach it.
const deleteCalls: string[] = [];
const workosStub = {
  organizations: {
    deleteOrganization: async (id: string) => { deleteCalls.push(id); },
  },
} as unknown as WorkOS;

describe('contained mergeOrganizations — agent_contexts are left sealed in place', () => {
  let pool: Pool;

  async function expectMergeRefused() {
    deleteCalls.length = 0;
    await expect(mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub))
      .rejects.toThrow(OrganizationMergeUnavailableError);
    expect(deleteCalls).toEqual([]);
    const secondary = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM organizations WHERE workos_organization_id = $1',
      [SECONDARY_ORG],
    );
    expect(secondary.rows[0]?.count).toBe('1');
  }

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

  it('leaves an auth token sealed under the secondary org salt, on the secondary org', async () => {
    const TOKEN = 'sk-test-bearer-token-12345';
    const sealed = encrypt(TOKEN, SECONDARY_ORG);

    await pool.query(
      `INSERT INTO agent_contexts (organization_id, agent_url, agent_name, auth_token_encrypted, auth_token_iv, auth_token_hint)
       VALUES ($1, 'https://agent.example/mcp', 'Test', $2, $3, '****2345')`,
      [SECONDARY_ORG, sealed.encrypted, sealed.iv]
    );

    await expectMergeRefused();

    // Nothing landed on the primary org.
    const atPrimary = await pool.query(
      `SELECT 1 FROM agent_contexts WHERE organization_id = $1`,
      [PRIMARY_ORG]
    );
    expect(atPrimary.rows).toHaveLength(0);

    const stayed = await pool.query(
      `SELECT auth_token_encrypted, auth_token_iv FROM agent_contexts WHERE organization_id = $1`,
      [SECONDARY_ORG]
    );
    expect(stayed.rows).toHaveLength(1);
    // Still sealed under the secondary salt: no re-encryption was attempted.
    expect(decrypt(stayed.rows[0].auth_token_encrypted, stayed.rows[0].auth_token_iv, SECONDARY_ORG)).toBe(TOKEN);
    expect(() => decrypt(stayed.rows[0].auth_token_encrypted, stayed.rows[0].auth_token_iv, PRIMARY_ORG)).toThrow();
  });

  it('leaves every populated OAuth token field sealed under the secondary salt', async () => {
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

    await expectMergeRefused();

    const stayed = await pool.query(
      `SELECT oauth_access_token_encrypted, oauth_access_token_iv,
              oauth_refresh_token_encrypted, oauth_refresh_token_iv,
              oauth_client_secret_encrypted, oauth_client_secret_iv
       FROM agent_contexts WHERE organization_id = $1`,
      [SECONDARY_ORG]
    );
    expect(stayed.rows).toHaveLength(1);
    const row = stayed.rows[0];

    expect(decrypt(row.oauth_access_token_encrypted, row.oauth_access_token_iv, SECONDARY_ORG)).toBe(ACCESS);
    expect(decrypt(row.oauth_refresh_token_encrypted, row.oauth_refresh_token_iv, SECONDARY_ORG)).toBe(REFRESH);
    // NULL columns are still NULL: nothing was written at all.
    expect(row.oauth_client_secret_encrypted).toBeNull();
    expect(row.oauth_client_secret_iv).toBeNull();
  });

  it('keeps both duplicate agent_url rows, so no row is dropped as a merge duplicate', async () => {
    const URL = 'https://dup.example/mcp';
    const primaryToken = encrypt('primary-token', PRIMARY_ORG);
    const secondaryToken = encrypt('secondary-token', SECONDARY_ORG);

    await pool.query(
      `INSERT INTO agent_contexts (organization_id, agent_url, agent_name, auth_token_encrypted, auth_token_iv)
       VALUES ($1, $3, 'Primary', $4, $5),
              ($2, $3, 'Secondary', $6, $7)`,
      [PRIMARY_ORG, SECONDARY_ORG, URL, primaryToken.encrypted, primaryToken.iv, secondaryToken.encrypted, secondaryToken.iv]
    );

    await expectMergeRefused();

    const remaining = await pool.query(
      `SELECT organization_id, auth_token_encrypted, auth_token_iv
       FROM agent_contexts WHERE agent_url = $1 ORDER BY organization_id`,
      [URL]
    );
    // Both rows survive on their own organizations; the duplicate-drop the
    // merge used to perform is unreachable, so no credential is discarded.
    expect(remaining.rows).toHaveLength(2);
    const primaryRow = remaining.rows.find(r => r.organization_id === PRIMARY_ORG);
    const secondaryRow = remaining.rows.find(r => r.organization_id === SECONDARY_ORG);
    expect(decrypt(primaryRow.auth_token_encrypted, primaryRow.auth_token_iv, PRIMARY_ORG)).toBe('primary-token');
    expect(decrypt(secondaryRow.auth_token_encrypted, secondaryRow.auth_token_iv, SECONDARY_ORG)).toBe('secondary-token');
  });
});
